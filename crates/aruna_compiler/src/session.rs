// A long-lived compiler session: the project's file list and every per-file
// fact stay cached between checks, and `update` says which files changed. A
// check after a one-file body edit re-reads and re-parses that file and
// rebuilds the project-wide parts (the graph, diagnostics, the manifest) from
// cached facts; every other file costs a hash comparison.
//
// The output is the one-shot compiler's: `check()` runs the same pipeline as
// `check_project`, through the session's cache instead of an empty one. The
// differential test (tests/session.rs) holds the two equal across randomized
// edit sequences.
//
// The session trusts `update`: a file changed on disk but never reported keeps
// its cached contents. Config (aruna.config.ts, tsconfig) is part of the input;
// when it changes, start a new session.

use crate::cache::{normalize_lexically, CacheStats, GraphCache};
use crate::compiler::{resolve_project_root, run_project_with, run_project_with_files};
use crate::files::discover_source_files;
use crate::{CompilerInput, CompilerOutput};
use std::path::{Path, PathBuf};

pub struct CompilerSession {
    input: CompilerInput,
    project_root: PathBuf,
    // `None` until the first check, and again after an update that may have
    // added or removed a file: the next check walks the project.
    files: Option<Vec<PathBuf>>,
    cache: GraphCache,
}

impl CompilerSession {
    pub fn new(input: CompilerInput) -> Self {
        let project_root = resolve_project_root(&input);
        CompilerSession {
            input,
            project_root,
            files: None,
            cache: GraphCache::default(),
        }
    }

    /// Marks files as changed on disk: edited, created, deleted, or (for a
    /// directory) moved. Paths may be absolute or relative to the project root.
    pub fn update<P: AsRef<Path>>(&mut self, changed_paths: &[P]) {
        for path in changed_paths {
            let absolute = self.absolute(path.as_ref());
            self.cache.invalidate(&absolute);

            let known = self
                .files
                .as_ref()
                .is_some_and(|files| files.iter().any(|file| normalize_lexically(file) == absolute));
            if absolute.is_file() {
                // A file the walk has not seen may be a new source file.
                if !known {
                    self.files = None;
                }
            } else {
                // Deleted, or a directory: a file may have left the project, and
                // a moved directory takes every cached file under it along.
                self.cache.invalidate_under(&absolute);
                self.files = None;
            }
        }
    }

    pub fn check(&mut self) -> CompilerOutput {
        self.run(true)
    }

    pub fn inspect(&mut self) -> CompilerOutput {
        self.run(false)
    }

    /// What the last checks recomputed, cumulatively.
    pub fn stats(&self) -> CacheStats {
        self.cache.stats
    }

    fn run(&mut self, write_manifest: bool) -> CompilerOutput {
        let input = self.input.clone();
        let project_root = self.project_root.clone();
        let files = &mut self.files;
        let cache = &mut self.cache;
        let mut panicked = true;
        let output = run_project_with(input, write_manifest, |input, write_manifest| {
            if files.is_none() {
                let discovered = discover_source_files(&project_root, &input.config)?;
                cache.retain_files(&discovered);
                *files = Some(discovered);
            }
            let result = run_project_with_files(
                input,
                write_manifest,
                files.as_deref().unwrap_or_default(),
                cache,
            );
            panicked = false;
            result
        });
        if panicked {
            // A panic left the cache in an unknown state; start over.
            self.files = None;
            self.cache = GraphCache::default();
        }
        output
    }

    fn absolute(&self, path: &Path) -> PathBuf {
        let joined = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.project_root.join(path)
        };
        let normalized = normalize_lexically(&joined);
        if normalized.starts_with(&self.project_root) {
            return normalized;
        }
        // A watcher may report the resolved path of a root reached through a
        // symlink (macOS's /var -> /private/var): map it back onto the root the
        // file list uses.
        if let (Ok(real_root), Ok(real_path)) = (
            self.project_root.canonicalize(),
            normalized
                .parent()
                .map(Path::canonicalize)
                .unwrap_or_else(|| Ok(normalized.clone())),
        ) {
            if let Ok(rest) = real_path.strip_prefix(&real_root) {
                if let Some(name) = normalized.file_name() {
                    return self.project_root.join(rest).join(name);
                }
            }
        }
        normalized
    }
}
