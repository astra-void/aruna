use crate::config::ArunaConfig;
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

impl Default for ConventionSet {
    fn default() -> Self {
        Self {
            client: vec!["**/client/**".to_string()],
            server: vec!["**/server/**".to_string()],
            shared: vec!["**/shared/**".to_string()],
        }
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
    let defaults = ConventionSet::default();
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

pub fn classify_relative_path(path: &str, conventions: &ConventionSet) -> ModuleClassification {
    let relative_path = normalize_path(path);
    let mut matched = Vec::new();

    if matches_any(&conventions.client, &relative_path) {
        matched.push(ModuleKind::Client);
    }
    if matches_any(&conventions.server, &relative_path) {
        matched.push(ModuleKind::Server);
    }
    if matches_any(&conventions.shared, &relative_path) {
        matched.push(ModuleKind::Shared);
    }

    match matched.as_slice() {
        [kind] => ModuleClassification {
            kind: *kind,
            matched_kinds: matched,
            reason_detail: None,
        },
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
                    .map(|kind| match kind {
                        ModuleKind::Client => "client",
                        ModuleKind::Server => "server",
                        ModuleKind::Shared => "shared",
                        ModuleKind::ClientEntry => "client entry",
                        ModuleKind::ServerEntry => "server entry",
                        ModuleKind::ServerAction => "server action",
                        ModuleKind::Unknown => "unknown",
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
        },
    }
}

fn classify_entry_path(root: &str, relative_path: &str) -> Option<ModuleKind> {
    let root = if root.is_empty() { "src" } else { root };
    let client_entry = format!("{root}/client.ts");
    let client_entry_tsx = format!("{root}/client.tsx");
    let server_entry = format!("{root}/server.ts");
    let server_entry_tsx = format!("{root}/server.tsx");

    match relative_path {
        _ if relative_path == client_entry || relative_path == client_entry_tsx => {
            Some(ModuleKind::ClientEntry)
        }
        _ if relative_path == server_entry || relative_path == server_entry_tsx => {
            Some(ModuleKind::ServerEntry)
        }
        _ => None,
    }
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

    if let Some(kind) = classify_entry_path(&config.root, &relative) {
        return ModuleClassification {
            kind,
            matched_kinds: Vec::new(),
            reason_detail: Some("matched recommended entry file".to_string()),
        };
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
