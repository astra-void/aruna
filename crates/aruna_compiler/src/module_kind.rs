use crate::config::ArunaConfig;
use crate::files::normalize_path;
use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModuleKind {
    Client,
    Server,
    Shared,
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
        ModuleKind::Client => config.conventions.client.clone(),
        ModuleKind::Server => config.conventions.server.clone(),
        ModuleKind::Shared => config.conventions.shared.clone(),
        ModuleKind::Unknown => Vec::new(),
    };

    if convention.is_empty() {
        match kind {
            ModuleKind::Client => defaults.client,
            ModuleKind::Server => defaults.server,
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
                        ModuleKind::Unknown => "unknown",
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
        },
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

    let convention_set = ConventionSet {
        client: convention_patterns(config, &ModuleKind::Client),
        server: convention_patterns(config, &ModuleKind::Server),
        shared: convention_patterns(config, &ModuleKind::Shared),
    };

    classify_relative_path(&relative, &convention_set)
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
