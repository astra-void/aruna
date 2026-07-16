use crate::config::{ArunaConfig, EntriesMode};
use crate::files::normalize_path;
use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ModuleKind {
    Client,
    Server,
    Shared,
    ClientEntry,
    ServerEntry,
    ServerAction,
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModuleReason {
    Path,
    Directive,
    Fallback,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConventionSet {
    pub client: Vec<String>,
    pub server: Vec<String>,
    pub shared: Vec<String>,
}

impl ConventionSet {
    // Recommended Layout v0 defaults: directory conventions plus file-name
    // conventions (`ui.tsx`, `actions.ts`, `schema.ts`, ...) so a plain
    // `domains/<feature>/` layout classifies with no aruna.config.ts at all.
    pub fn for_root(root: &str) -> Self {
        let root = if root.is_empty() { "src" } else { root };
        Self {
            client: vec!["**/client/**".to_string(), "**/ui.tsx".to_string()],
            server: vec![
                "**/server/**".to_string(),
                "**/actions.ts".to_string(),
                "**/runtime.ts".to_string(),
            ],
            shared: vec![
                "**/shared/**".to_string(),
                format!("{root}/app/**"),
                "**/schema.ts".to_string(),
                "**/model.ts".to_string(),
            ],
        }
    }
}

impl Default for ConventionSet {
    fn default() -> Self {
        Self::for_root("src")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleClassification {
    pub kind: ModuleKind,
    pub matched_kinds: Vec<ModuleKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_detail: Option<String>,
}

fn compile_globset(patterns: &[String]) -> Result<GlobSet, String> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        builder.add(Glob::new(pattern).map_err(|error| error.to_string())?);
    }
    builder.build().map_err(|error| error.to_string())
}

fn matches_any(patterns: &[String], path: &str) -> bool {
    compile_globset(patterns)
        .map(|globset| globset.is_match(path))
        .unwrap_or(false)
}

fn convention_patterns(config: &ArunaConfig, kind: &ModuleKind) -> Vec<String> {
    let defaults = ConventionSet::for_root(&config.root);
    let convention = match kind {
        ModuleKind::Client | ModuleKind::ClientEntry => config.conventions.client.clone(),
        ModuleKind::Server | ModuleKind::ServerEntry | ModuleKind::ServerAction => {
            config.conventions.server.clone()
        }
        ModuleKind::Shared => config.conventions.shared.clone(),
        ModuleKind::Unknown => Vec::new(),
    };

    if convention.is_empty() {
        match kind {
            ModuleKind::Client | ModuleKind::ClientEntry => defaults.client,
            ModuleKind::Server | ModuleKind::ServerEntry | ModuleKind::ServerAction => {
                defaults.server
            }
            ModuleKind::Shared => defaults.shared,
            ModuleKind::Unknown => Vec::new(),
        }
    } else {
        convention
    }
}

// A pattern whose final segment is a concrete file name (no wildcard) is a
// file-name convention; anything else (trailing `**`, `*`, ...) is a directory
// convention. Directory conventions are the stronger signal: an explicit
// client/ / server/ / shared/ folder in the path wins over a file-name rule,
// so `src/server/model.ts` stays Server even though `**/model.ts` is a shared
// file-name default. Only same-tier cross-kind matches are ambiguous.
fn is_file_name_pattern(pattern: &str) -> bool {
    let last_segment = pattern.rsplit('/').next().unwrap_or(pattern);
    !last_segment.contains(['*', '?', '['])
}

pub fn classify_relative_path(path: &str, conventions: &ConventionSet) -> ModuleClassification {
    let relative_path = normalize_path(path);
    let mut directory_matches = Vec::new();
    let mut file_name_matches = Vec::new();

    for (kind, patterns) in [
        (ModuleKind::Client, &conventions.client),
        (ModuleKind::Server, &conventions.server),
        (ModuleKind::Shared, &conventions.shared),
    ] {
        let (file_patterns, directory_patterns): (Vec<String>, Vec<String>) = patterns
            .iter()
            .cloned()
            .partition(|pattern| is_file_name_pattern(pattern));

        if matches_any(&directory_patterns, &relative_path) {
            directory_matches.push(kind);
        } else if matches_any(&file_patterns, &relative_path) {
            file_name_matches.push(kind);
        }
    }

    let matched = if directory_matches.is_empty() {
        file_name_matches.clone()
    } else {
        directory_matches.clone()
    };

    match matched.as_slice() {
        [kind] => {
            let overridden: Vec<&str> = if directory_matches.len() == 1 {
                file_name_matches
                    .iter()
                    .filter(|other| **other != *kind)
                    .map(kind_label)
                    .collect()
            } else {
                Vec::new()
            };
            ModuleClassification {
                kind: *kind,
                matched_kinds: matched,
                reason_detail: if overridden.is_empty() {
                    None
                } else {
                    Some(format!(
                        "directory convention overrode file-name convention: {}",
                        overridden.join(", ")
                    ))
                },
            }
        }
        [] => ModuleClassification {
            kind: ModuleKind::Unknown,
            matched_kinds: matched,
            reason_detail: None,
        },
        _ => ModuleClassification {
            kind: ModuleKind::Unknown,
            matched_kinds: matched.clone(),
            reason_detail: Some(format!(
                "matched multiple conventions: {}",
                matched
                    .iter()
                    .map(kind_label)
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
        },
    }
}

fn kind_label(kind: &ModuleKind) -> &'static str {
    match kind {
        ModuleKind::Client => "client",
        ModuleKind::Server => "server",
        ModuleKind::Shared => "shared",
        ModuleKind::ClientEntry => "client entry",
        ModuleKind::ServerEntry => "server entry",
        ModuleKind::ServerAction => "server action",
        ModuleKind::Unknown => "unknown",
    }
}

// Which side a recommended entry-path file belongs to, before the entries mode
// decides whether it is a script entry or a plain hook module.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntrySide {
    Client,
    Server,
}

pub fn entry_side_for_path(root: &str, relative_path: &str) -> Option<EntrySide> {
    let root = if root.is_empty() { "src" } else { root };
    let client_entry = format!("{root}/client.ts");
    let client_entry_tsx = format!("{root}/client.tsx");
    let server_entry = format!("{root}/server.ts");
    let server_entry_tsx = format!("{root}/server.tsx");

    match relative_path {
        _ if relative_path == client_entry || relative_path == client_entry_tsx => {
            Some(EntrySide::Client)
        }
        _ if relative_path == server_entry || relative_path == server_entry_tsx => {
            Some(EntrySide::Server)
        }
        _ => None,
    }
}

// Under `entries: "user"` the recommended entry files are the runtime entry
// scripts. Under `entries: "generated"` Aruna owns the entry scripts, and the
// same files become plain hook modules on their respective side.
fn classify_entry_path(
    root: &str,
    relative_path: &str,
    entries: EntriesMode,
) -> Option<ModuleClassification> {
    let side = entry_side_for_path(root, relative_path)?;
    let (kind, detail) = match (entries, side) {
        (EntriesMode::User, EntrySide::Client) => {
            (ModuleKind::ClientEntry, "matched recommended entry file")
        }
        (EntriesMode::User, EntrySide::Server) => {
            (ModuleKind::ServerEntry, "matched recommended entry file")
        }
        (EntriesMode::Generated, EntrySide::Client) => {
            (ModuleKind::Client, "client hook module (entries: generated)")
        }
        (EntriesMode::Generated, EntrySide::Server) => {
            (ModuleKind::Server, "server hook module (entries: generated)")
        }
    };
    Some(ModuleClassification {
        kind,
        matched_kinds: Vec::new(),
        reason_detail: Some(detail.to_string()),
    })
}

pub fn classify_module(
    project_root: &std::path::Path,
    absolute_path: &std::path::Path,
    config: &ArunaConfig,
) -> ModuleClassification {
    let relative = absolute_path
        .strip_prefix(project_root)
        .map(|value| normalize_path(&value.to_string_lossy()))
        .unwrap_or_else(|_| normalize_path(&absolute_path.to_string_lossy()));

    if let Some(classification) = classify_entry_path(&config.root, &relative, config.entries) {
        return classification;
    }

    let convention_set = ConventionSet {
        client: convention_patterns(config, &ModuleKind::Client),
        server: convention_patterns(config, &ModuleKind::Server),
        shared: convention_patterns(config, &ModuleKind::Shared),
    };

    // Aruna owns the layout under `generatedDir` (server registry under
    // `server/`, stubs/signals/runtime under `shared/`). Classify generated
    // files by their path *relative to* `generatedDir` so a convention segment in
    // the generatedDir's own ancestry — e.g. `src/shared/.aruna` matching
    // `**/shared/**` — does not collide with the generated subtree's own kind and
    // produce a spurious multi-convention (ambiguous) match.
    let match_path = strip_generated_dir_prefix(&relative, &config.generated_dir).unwrap_or(relative);

    classify_relative_path(&match_path, &convention_set)
}

// Returns `path` with the `generated_dir` prefix removed when `path` lives inside
// it, or `None` when it does not. Both are normalized first so the comparison is
// slash- and segment-accurate.
fn strip_generated_dir_prefix(path: &str, generated_dir: &str) -> Option<String> {
    let generated_dir = normalize_path(generated_dir);
    if generated_dir.is_empty() {
        return None;
    }

    let prefix = format!("{generated_dir}/");
    path.strip_prefix(&prefix).map(|rest| rest.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_feature_local_layout() {
        let conventions = ConventionSet::default();
        assert_eq!(
            classify_relative_path("src/features/shop/client/panel.tsx", &conventions).kind,
            ModuleKind::Client
        );
        assert_eq!(
            classify_relative_path("src/features/shop/server/pricing.ts", &conventions).kind,
            ModuleKind::Server
        );
        assert_eq!(
            classify_relative_path("src/features/shop/shared/schema.ts", &conventions).kind,
            ModuleKind::Shared
        );
        assert_eq!(
            classify_relative_path("src/utils/debug.ts", &conventions).kind,
            ModuleKind::Unknown
        );
    }

    #[test]
    fn classifies_recommended_entry_files() {
        let config = ArunaConfig::default();
        assert_eq!(
            classify_module(
                std::path::Path::new("/workspace"),
                std::path::Path::new("/workspace/src/client.tsx"),
                &config,
            )
            .kind,
            ModuleKind::ClientEntry
        );
        assert_eq!(
            classify_module(
                std::path::Path::new("/workspace"),
                std::path::Path::new("/workspace/src/server.ts"),
                &config,
            )
            .kind,
            ModuleKind::ServerEntry
        );
    }

    #[test]
    fn classifies_entry_files_as_hook_modules_under_generated_entries() {
        let mut config = ArunaConfig::default();
        config.entries = crate::config::EntriesMode::Generated;

        let client = classify_module(
            std::path::Path::new("/workspace"),
            std::path::Path::new("/workspace/src/client.tsx"),
            &config,
        );
        assert_eq!(client.kind, ModuleKind::Client);
        assert_eq!(
            client.reason_detail.as_deref(),
            Some("client hook module (entries: generated)")
        );

        let server = classify_module(
            std::path::Path::new("/workspace"),
            std::path::Path::new("/workspace/src/server.ts"),
            &config,
        );
        assert_eq!(server.kind, ModuleKind::Server);
        assert_eq!(
            server.reason_detail.as_deref(),
            Some("server hook module (entries: generated)")
        );
    }

    #[test]
    fn classifies_generated_files_relative_to_generated_dir() {
        // generatedDir nested inside a `shared/` convention path. The generated
        // server registry must classify as Server (not ambiguous Unknown) because
        // the generatedDir's own `shared/` ancestry is stripped before matching.
        let mut config = ArunaConfig::default();
        config.generated_dir = "src/shared/.aruna".to_string();

        let server = classify_module(
            std::path::Path::new("/workspace"),
            std::path::Path::new("/workspace/src/shared/.aruna/server/actions.server.generated.ts"),
            &config,
        );
        assert_eq!(server.kind, ModuleKind::Server);
        assert!(server.matched_kinds.len() <= 1);

        let shared = classify_module(
            std::path::Path::new("/workspace"),
            std::path::Path::new("/workspace/src/shared/.aruna/shared/actions.client.generated.ts"),
            &config,
        );
        assert_eq!(shared.kind, ModuleKind::Shared);

        // A non-generated file under the same `shared/` tree still classifies
        // normally as Shared.
        let regular = classify_module(
            std::path::Path::new("/workspace"),
            std::path::Path::new("/workspace/src/shared/schema.ts"),
            &config,
        );
        assert_eq!(regular.kind, ModuleKind::Shared);
    }

    #[test]
    fn classifies_recommended_layout_file_name_conventions() {
        let conventions = ConventionSet::default();
        assert_eq!(
            classify_relative_path("src/domains/shop/ui.tsx", &conventions).kind,
            ModuleKind::Client
        );
        assert_eq!(
            classify_relative_path("src/domains/shop/actions.ts", &conventions).kind,
            ModuleKind::Server
        );
        assert_eq!(
            classify_relative_path("src/domains/combat/runtime.ts", &conventions).kind,
            ModuleKind::Server
        );
        assert_eq!(
            classify_relative_path("src/domains/shop/schema.ts", &conventions).kind,
            ModuleKind::Shared
        );
        assert_eq!(
            classify_relative_path("src/domains/shop/model.ts", &conventions).kind,
            ModuleKind::Shared
        );
        assert_eq!(
            classify_relative_path("src/app/providers.ts", &conventions).kind,
            ModuleKind::Shared
        );
        assert_eq!(
            classify_relative_path("src/utils/debug.ts", &conventions).kind,
            ModuleKind::Unknown
        );
    }

    #[test]
    fn directory_convention_wins_over_file_name_convention() {
        let conventions = ConventionSet::default();

        // `**/server/**` (directory tier) beats `**/model.ts` (file-name tier).
        let server_model = classify_relative_path("src/server/model.ts", &conventions);
        assert_eq!(server_model.kind, ModuleKind::Server);
        assert_eq!(server_model.matched_kinds, vec![ModuleKind::Server]);
        assert_eq!(
            server_model.reason_detail.as_deref(),
            Some("directory convention overrode file-name convention: shared")
        );

        // `src/app/**` (directory tier) beats `**/ui.tsx` (file-name tier).
        let app_ui = classify_relative_path("src/app/ui.tsx", &conventions);
        assert_eq!(app_ui.kind, ModuleKind::Shared);

        // Same kind on both tiers is not a conflict and carries no override note.
        let shared_schema = classify_relative_path("src/shared/schema.ts", &conventions);
        assert_eq!(shared_schema.kind, ModuleKind::Shared);
        assert_eq!(shared_schema.reason_detail, None);
    }

    #[test]
    fn detects_ambiguous_convention_match() {
        let conventions = ConventionSet {
            client: vec!["**/client/**".to_string(), "**/shared/**".to_string()],
            server: vec!["**/server/**".to_string()],
            shared: vec!["**/shared/**".to_string()],
        };
        let classification = classify_relative_path("src/shared/mixed.ts", &conventions);
        assert_eq!(classification.kind, ModuleKind::Unknown);
        assert_eq!(
            classification.matched_kinds,
            vec![ModuleKind::Client, ModuleKind::Shared]
        );
        assert_eq!(
            classification.reason_detail.as_deref(),
            Some("matched multiple conventions: client, shared")
        );
    }
}
