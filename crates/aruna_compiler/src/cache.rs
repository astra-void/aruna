// Per-file caching for the project graph.
//
// Everything `build_project_graph` learns from one file is a pure function of
// that file's contents (and, for primitive discovery, of the files its schema
// imports read), so each fact is cached keyed by the content hash it was
// computed from and reused while that hash holds. A one-shot check builds the
// graph with an empty cache; a `CompilerSession` keeps one across checks and
// tells it which files changed. Nothing here decides an output: the graph code
// that consumes these facts is the same either way, which is what keeps a
// session's output identical to a clean check.
//
// Hand-rolled rather than built on `salsa`: see docs/compiler-performance.md.

use crate::diagnostics::ArunaDiagnostic;
use crate::module_kind::{classify_module, ModuleClassification};
use crate::parser::{collect_module_exports, collect_static_imports, StaticImportRecord};
use crate::primitives::{parse_source, ParsedFile, PrimitiveFiles, PrimitiveRecords};
use crate::raw_remote::{collect_raw_remote_usages, RawRemoteUsage};
use crate::shared_safety::{collect_server_service_accesses, ServerServiceAccess};
use crate::resolver::{resolve_import_specifier, ResolvedImport, TsconfigResolverOptions};
use crate::config::ArunaConfig;
use crate::schema_metadata::SourceReader;
use oxc_allocator::Allocator;
use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

// FNV-1a, 64-bit. Collisions would only cost a missed recompute on two
// different contents with one hash; at this width that is not a practical risk
// for source files.
fn content_hash(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// `path` with `.` and `..` components folded away, without touching the disk:
/// the schema import hop reads `dir/./schema.ts`, and that must be the same
/// cache entry an edit to `dir/schema.ts` invalidates.
pub fn normalize_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    normalized.push(component);
                }
            }
            other => normalized.push(other),
        }
    }
    normalized
}

/// One file's contents as last read, and their hash.
#[derive(Debug)]
pub struct Source {
    pub text: Arc<str>,
    pub hash: u64,
}

/// File contents read through the cache. A read is remembered — including a
/// failed one, with its error message — until `invalidate` drops it.
#[derive(Default)]
pub struct SourceCache {
    entries: RefCell<HashMap<PathBuf, Result<Arc<Source>, String>>>,
}

impl SourceCache {
    pub fn get(&self, path: &Path) -> Result<Arc<Source>, String> {
        // Most lookups are for paths already in normal form (the project walk's);
        // try the path as given before allocating a normalized copy.
        if let Some(entry) = self.entries.borrow().get(path) {
            return entry.clone();
        }
        let path = &normalize_lexically(path);
        if let Some(entry) = self.entries.borrow().get(path) {
            return entry.clone();
        }
        let entry = std::fs::read_to_string(path)
            .map(|text| {
                Arc::new(Source {
                    hash: content_hash(text.as_bytes()),
                    text: Arc::from(text),
                })
            })
            .map_err(|error| error.to_string());
        self.entries
            .borrow_mut()
            .insert(path.to_path_buf(), entry.clone());
        entry
    }

    /// The hash of `path`'s current contents, or `None` when it cannot be read.
    pub fn hash(&self, path: &Path) -> Option<u64> {
        self.get(path).ok().map(|source| source.hash)
    }

    pub fn invalidate(&mut self, path: &Path) {
        self.entries.get_mut().remove(&normalize_lexically(path));
    }

    /// Drops every cached file at or under `path` (a directory that moved or
    /// went away).
    pub fn invalidate_under(&mut self, path: &Path) {
        let prefix = normalize_lexically(path);
        self.entries
            .get_mut()
            .retain(|cached, _| !cached.starts_with(&prefix));
    }

    pub fn clear(&mut self) {
        self.entries.get_mut().clear();
    }
}

impl SourceReader for SourceCache {
    fn read_source(&self, path: &Path) -> Option<String> {
        self.get(path).ok().map(|source| source.text.to_string())
    }
}

/// What every registered primitive found in one file.
#[derive(Clone, Debug, Default)]
pub struct FileDiscovery {
    pub records: PrimitiveRecords,
    pub files: PrimitiveFiles,
    pub diagnostics: Vec<ArunaDiagnostic>,
}

struct Keyed<T> {
    source_hash: u64,
    value: T,
}

struct DiscoveryEntry {
    source_hash: u64,
    // Each file discovery read besides this one, with the hash it had then
    // (`None`: it could not be read). A change to any of them invalidates.
    dependencies: Vec<(PathBuf, Option<u64>)>,
    value: Result<Arc<FileDiscovery>, String>,
}

struct ResolutionEntry {
    source_hash: u64,
    file_set: u64,
    value: Arc<Vec<ResolvedImport>>,
}

/// The cached per-file facts of a project graph.
#[derive(Default)]
pub struct GraphCache {
    pub sources: SourceCache,
    classifications: HashMap<PathBuf, ModuleClassification>,
    module_exports: HashMap<PathBuf, Keyed<Result<Vec<String>, String>>>,
    discoveries: HashMap<PathBuf, DiscoveryEntry>,
    raw_remote_usages: HashMap<PathBuf, Keyed<Result<Vec<RawRemoteUsage>, String>>>,
    server_service_accesses: HashMap<PathBuf, Keyed<Result<Vec<ServerServiceAccess>, String>>>,
    static_imports: HashMap<PathBuf, Keyed<Result<Arc<Vec<StaticImportRecord>>, String>>>,
    resolutions: HashMap<PathBuf, ResolutionEntry>,
    // A hash of the discovered file set: import resolution depends on which
    // files exist, so a resolution computed under another set is stale.
    file_set: u64,
    // Counts recomputed facts, for tests that assert what an edit re-ran.
    pub stats: CacheStats,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CacheStats {
    pub discoveries: usize,
    pub static_imports: usize,
    pub resolutions: usize,
}

impl GraphCache {
    /// Drops `path`'s contents so the next check re-reads it. Facts derived from
    /// it are kept and revalidated against the new hash.
    pub fn invalidate(&mut self, path: &Path) {
        self.sources.invalidate(path);
    }

    pub fn invalidate_under(&mut self, path: &Path) {
        self.sources.invalidate_under(path);
    }

    /// Records the project's file set; resolutions made under another one are
    /// recomputed.
    pub fn set_file_set(&mut self, discovered_files: &BTreeSet<String>) {
        let mut joined = String::new();
        for file in discovered_files {
            joined.push_str(file);
            joined.push('\n');
        }
        self.file_set = content_hash(joined.as_bytes());
    }

    /// Forgets facts about files no longer in the project.
    pub fn retain_files(&mut self, files: &[PathBuf]) {
        let keep: std::collections::HashSet<&PathBuf> = files.iter().collect();
        self.classifications.retain(|path, _| keep.contains(path));
        self.module_exports.retain(|path, _| keep.contains(path));
        self.discoveries.retain(|path, _| keep.contains(path));
        self.raw_remote_usages.retain(|path, _| keep.contains(path));
        self.server_service_accesses.retain(|path, _| keep.contains(path));
        self.static_imports.retain(|path, _| keep.contains(path));
        self.resolutions.retain(|path, _| keep.contains(path));
    }

    pub fn source(&self, path: &Path) -> Result<Arc<Source>, String> {
        self.sources.get(path)
    }

    // Classification depends on the path and the config, and a cache never
    // outlives its config.
    pub fn classify(
        &mut self,
        project_root: &Path,
        path: &Path,
        config: &ArunaConfig,
    ) -> ModuleClassification {
        self.classifications
            .entry(path.to_path_buf())
            .or_insert_with(|| classify_module(project_root, path, config))
            .clone()
    }

    pub fn module_exports(&mut self, path: &Path, source: &Source) -> Result<Vec<String>, String> {
        let entry = self.module_exports.get(path);
        if let Some(entry) = entry.filter(|entry| entry.source_hash == source.hash) {
            return entry.value.clone();
        }
        let value = collect_module_exports(path, &source.text);
        self.module_exports.insert(
            path.to_path_buf(),
            Keyed {
                source_hash: source.hash,
                value: value.clone(),
            },
        );
        value
    }

    /// Every registered primitive's discovery over `path`, or the parse error.
    pub fn discovery(
        &mut self,
        path: &Path,
        relative_path: &str,
        source: &Source,
    ) -> Result<Arc<FileDiscovery>, String> {
        if let Some(entry) = self.discoveries.get(path) {
            let fresh = entry.source_hash == source.hash
                && entry
                    .dependencies
                    .iter()
                    .all(|(dependency, hash)| self.sources.hash(dependency) == *hash);
            if fresh {
                return entry.value.clone();
            }
        }

        self.stats.discoveries += 1;
        let allocator = Allocator::default();
        let (value, dependencies) = match parse_source(&allocator, path, &source.text) {
            Ok(program) => {
                let parsed = ParsedFile::with_reader(path, &program, &self.sources);
                let mut discovery = FileDiscovery::default();
                discovery.records.discover_file(
                    &mut discovery.files,
                    relative_path,
                    &parsed,
                    &mut discovery.diagnostics,
                );
                let dependencies = parsed
                    .dependencies()
                    .into_iter()
                    .map(|dependency| {
                        let hash = self.sources.hash(&dependency);
                        (dependency, hash)
                    })
                    .collect();
                (Ok(Arc::new(discovery)), dependencies)
            }
            Err(error) => (Err(error), Vec::new()),
        };
        self.discoveries.insert(
            path.to_path_buf(),
            DiscoveryEntry {
                source_hash: source.hash,
                dependencies,
                value: value.clone(),
            },
        );
        value
    }

    pub fn raw_remote_usages(
        &mut self,
        path: &Path,
        source: &Source,
    ) -> Result<Vec<RawRemoteUsage>, String> {
        let entry = self.raw_remote_usages.get(path);
        if let Some(entry) = entry.filter(|entry| entry.source_hash == source.hash) {
            return entry.value.clone();
        }
        let value = collect_raw_remote_usages(path, &source.text);
        self.raw_remote_usages.insert(
            path.to_path_buf(),
            Keyed {
                source_hash: source.hash,
                value: value.clone(),
            },
        );
        value
    }

    pub fn server_service_accesses(
        &mut self,
        path: &Path,
        source: &Source,
    ) -> Result<Vec<ServerServiceAccess>, String> {
        let entry = self.server_service_accesses.get(path);
        if let Some(entry) = entry.filter(|entry| entry.source_hash == source.hash) {
            return entry.value.clone();
        }
        let value = collect_server_service_accesses(path, &source.text);
        self.server_service_accesses.insert(
            path.to_path_buf(),
            Keyed {
                source_hash: source.hash,
                value: value.clone(),
            },
        );
        value
    }

    pub fn static_imports(
        &mut self,
        path: &Path,
        source: &Source,
    ) -> Result<Arc<Vec<StaticImportRecord>>, String> {
        let entry = self.static_imports.get(path);
        if let Some(entry) = entry.filter(|entry| entry.source_hash == source.hash) {
            return entry.value.clone();
        }
        self.stats.static_imports += 1;
        let value = collect_static_imports(path, &source.text).map(Arc::new);
        self.static_imports.insert(
            path.to_path_buf(),
            Keyed {
                source_hash: source.hash,
                value: value.clone(),
            },
        );
        value
    }

    /// How each of `imports` (the file's static imports) resolves.
    #[allow(clippy::too_many_arguments)]
    pub fn resolutions(
        &mut self,
        project_root: &Path,
        path: &Path,
        source: &Source,
        generated_dir: &str,
        imports: &[StaticImportRecord],
        options: &TsconfigResolverOptions,
        discovered_files: &BTreeSet<String>,
    ) -> Arc<Vec<ResolvedImport>> {
        if let Some(entry) = self.resolutions.get(path) {
            if entry.source_hash == source.hash && entry.file_set == self.file_set {
                return entry.value.clone();
            }
        }
        self.stats.resolutions += 1;
        let value: Arc<Vec<ResolvedImport>> = imports
            .iter()
            .map(|entry| {
                resolve_import_specifier(
                    project_root,
                    path,
                    generated_dir,
                    &entry.specifier,
                    options,
                    discovered_files,
                )
            })
            .collect::<Vec<_>>()
            .into();
        self.resolutions.insert(
            path.to_path_buf(),
            ResolutionEntry {
                source_hash: source.hash,
                file_set: self.file_set,
                value: value.clone(),
            },
        );
        value
    }
}
