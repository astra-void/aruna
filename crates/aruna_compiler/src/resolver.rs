use crate::files::{normalize_path, normalize_path_buf, project_absolute};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TsconfigResolverOptions {
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub paths: BTreeMap<String, Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedImport {
    pub resolved: bool,
    pub absolute_path: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VirtualGeneratedActionModule {
    Client,
    Server,
}

// Split-tree generated layout (relative to the configured generatedDir). The
// server action registry imports server implementations, so it lands in a
// `server/` subtree that maps to a server-only Rojo mount; the client stubs, the
// signal registry, and the vendored runtime are replication-safe and land in a
// `shared/` subtree. Single source of truth for both the virtual-module resolver
// (which makes `$aruna/actions/server` resolve to the right file) and codegen
// (which writes the file) — keep them identical.
pub const GENERATED_CLIENT_ACTIONS_FILE: &str = "shared/actions.client.generated.ts";
pub const GENERATED_SERVER_ACTIONS_FILE: &str = "server/actions.server.generated.ts";
pub const GENERATED_SIGNALS_FILE: &str = "shared/signals.generated.ts";

// Generated runtime entries (entries: "generated"). The `.server`/`.client`
// suffixes make roblox-ts emit a real Script / LocalScript; the `server/` and
// `client/` subtrees map onto the matching Rojo partitions. Nothing imports
// these modules — they are the roots of the runtime graph.
pub const GENERATED_SERVER_ENTRY_FILE: &str = "server/main.server.ts";
pub const GENERATED_CLIENT_ENTRY_FILE: &str = "client/main.client.ts";

impl VirtualGeneratedActionModule {
    pub fn specifier(self) -> &'static str {
        match self {
            VirtualGeneratedActionModule::Client => "$aruna/actions/client",
            VirtualGeneratedActionModule::Server => "$aruna/actions/server",
        }
    }

    pub fn filename(self) -> &'static str {
        match self {
            VirtualGeneratedActionModule::Client => GENERATED_CLIENT_ACTIONS_FILE,
            VirtualGeneratedActionModule::Server => GENERATED_SERVER_ACTIONS_FILE,
        }
    }
}

pub fn resolve_virtual_generated_action_module(
    specifier: &str,
) -> Option<VirtualGeneratedActionModule> {
    match specifier {
        "$aruna/actions/client" => Some(VirtualGeneratedActionModule::Client),
        "$aruna/actions/server" => Some(VirtualGeneratedActionModule::Server),
        _ => None,
    }
}

// Signals are server -> client contracts: the same typed registry feeds the
// server publisher and the client subscriber, so a single virtual module serves
// both sides (unlike actions, whose client/server stubs differ).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VirtualGeneratedSignalModule;

impl VirtualGeneratedSignalModule {
    pub fn specifier(self) -> &'static str {
        "$aruna/signals"
    }

    pub fn filename(self) -> &'static str {
        GENERATED_SIGNALS_FILE
    }
}

pub fn resolve_virtual_generated_signal_module(
    specifier: &str,
) -> Option<VirtualGeneratedSignalModule> {
    if specifier == "$aruna/signals" {
        Some(VirtualGeneratedSignalModule)
    } else {
        None
    }
}

fn is_ts_source_file(file_path: &Path) -> bool {
    let text = normalize_path(&file_path.to_string_lossy());
    (text.ends_with(".ts") || text.ends_with(".tsx")) && !text.ends_with(".d.ts")
}

fn candidate_paths(base: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    candidates.push(base.to_path_buf());
    candidates.push(base.with_extension("ts"));
    candidates.push(base.with_extension("tsx"));
    candidates.push(base.join("index.ts"));
    candidates.push(base.join("index.tsx"));
    candidates
}

fn try_resolve_candidate(
    candidate: &Path,
    project_root: &Path,
    discovered_files: &std::collections::BTreeSet<String>,
) -> Option<PathBuf> {
    for path in candidate_paths(candidate) {
        if !path.exists() || !path.is_file() || !is_ts_source_file(&path) {
            continue;
        }

        let absolute = normalize_path_buf(&path.to_path_buf());
        let relative = absolute
            .strip_prefix(project_root)
            .ok()
            .map(|value| normalize_path(&value.to_string_lossy()));
        if let Some(relative_path) = relative {
            if discovered_files.contains(&relative_path) {
                return Some(absolute);
            }
        }
    }

    None
}

fn match_pattern(pattern: &str, input: &str) -> Option<Vec<String>> {
    if !pattern.contains('*') {
        return if pattern == input {
            Some(Vec::new())
        } else {
            None
        };
    }

    let parts: Vec<&str> = pattern.split('*').collect();
    let mut rest = input;
    let mut captures = Vec::new();

    if let Some(prefix) = parts.first() {
        if !rest.starts_with(prefix) {
            return None;
        }
        rest = &rest[prefix.len()..];
    }

    for (index, part) in parts.iter().enumerate().skip(1) {
        if index == parts.len() - 1 {
            if !rest.ends_with(part) {
                return None;
            }
            let capture = &rest[..rest.len().saturating_sub(part.len())];
            captures.push(capture.to_string());
            rest = "";
        } else if let Some(pos) = rest.find(part) {
            captures.push(rest[..pos].to_string());
            rest = &rest[pos + part.len()..];
        } else {
            return None;
        }
    }

    if !rest.is_empty() && !pattern.ends_with('*') {
        return None;
    }

    if pattern.ends_with('*') && !rest.is_empty() {
        captures.push(rest.to_string());
    }

    Some(captures)
}

fn apply_pattern(pattern: &str, captures: &[String]) -> Option<String> {
    if !pattern.contains('*') {
        return Some(pattern.to_string());
    }

    let mut result = String::new();
    let mut capture_index = 0usize;
    for part in pattern.split('*') {
        result.push_str(part);
        if capture_index < captures.len() {
            result.push_str(&captures[capture_index]);
            capture_index += 1;
        }
    }

    Some(result)
}

fn resolve_paths_mapping(
    project_root: &Path,
    importer_path: &Path,
    specifier: &str,
    options: &TsconfigResolverOptions,
    discovered_files: &std::collections::BTreeSet<String>,
) -> Option<PathBuf> {
    for (pattern, targets) in &options.paths {
        let Some(captures) = match_pattern(pattern, specifier) else {
            continue;
        };

        for target in targets {
            let Some(mapped) = apply_pattern(target, &captures) else {
                continue;
            };
            let base = options
                .base_url
                .as_ref()
                .map(|base_url| project_absolute(project_root, base_url))
                .unwrap_or_else(|| project_root.to_path_buf());
            let absolute = project_absolute(&base, &mapped);
            if let Some(resolved) = try_resolve_candidate(&absolute, project_root, discovered_files)
            {
                return Some(resolved);
            }
        }
    }

    let base = options
        .base_url
        .as_ref()
        .map(|base_url| project_absolute(project_root, base_url))
        .unwrap_or_else(|| project_root.to_path_buf());
    let absolute = project_absolute(&base, specifier);
    try_resolve_candidate(&absolute, project_root, discovered_files).or_else(|| {
        let importer_dir = importer_path.parent().unwrap_or(importer_path);
        try_resolve_candidate(
            &importer_dir.join(specifier),
            project_root,
            discovered_files,
        )
    })
}

fn is_relative_specifier(specifier: &str) -> bool {
    specifier.starts_with("./")
        || specifier.starts_with("../")
        || specifier == "."
        || specifier == ".."
}

pub fn is_bare_specifier(specifier: &str) -> bool {
    !is_relative_specifier(specifier) && !specifier.starts_with('/')
}

pub fn resolve_import_specifier(
    project_root: &Path,
    importer_path: &Path,
    generated_dir: &str,
    specifier: &str,
    options: &TsconfigResolverOptions,
    discovered_files: &std::collections::BTreeSet<String>,
) -> ResolvedImport {
    if let Some(virtual_module) = resolve_virtual_generated_action_module(specifier) {
        let generated_path = project_absolute(project_root, generated_dir).join(virtual_module.filename());
        return ResolvedImport {
            resolved: true,
            absolute_path: Some(normalize_path_buf(&generated_path)),
        };
    }

    if let Some(virtual_module) = resolve_virtual_generated_signal_module(specifier) {
        let generated_path =
            project_absolute(project_root, generated_dir).join(virtual_module.filename());
        return ResolvedImport {
            resolved: true,
            absolute_path: Some(normalize_path_buf(&generated_path)),
        };
    }

    let resolved = if is_relative_specifier(specifier) {
        let importer_dir = importer_path.parent().unwrap_or(importer_path);
        let absolute = importer_dir.join(specifier);
        try_resolve_candidate(&absolute, project_root, discovered_files)
    } else {
        resolve_paths_mapping(
            project_root,
            importer_path,
            specifier,
            options,
            discovered_files,
        )
    };

    match resolved {
        Some(absolute_path) => ResolvedImport {
            resolved: true,
            absolute_path: Some(absolute_path),
        },
        None => ResolvedImport {
            resolved: false,
            absolute_path: None,
        },
    }
}
