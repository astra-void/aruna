use crate::config::{ArunaConfig, ConventionConfig, EntriesMode};
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
    // A module that exports a store definition. Server-only like ServerAction,
    // and separated from it so the client-side violation can say "store".
    ServerStore,
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
    //
    // `**/signals.ts` is shared structurally: the generated signal registry
    // lands in the shared partition and imports each definition from the file
    // that declared it, so a server-classified declaration cannot resolve on
    // the client. Must stay in sync with `defaultConventionsForRoot` in
    // packages/compiler/src/config.ts.
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
                "**/signals.ts".to_string(),
                // A barrel is a surface other modules import through — a
                // domain's `index.ts` is exactly its cross-domain public API —
                // so it is shared-safe by default. A barrel inside a partition
                // folder keeps that folder's kind: the directory tier wins.
                "**/index.ts".to_string(),
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

fn patterns_for_kind(conventions: &ConventionConfig, kind: &ModuleKind) -> Vec<String> {
    match kind {
        ModuleKind::Client | ModuleKind::ClientEntry => conventions.client.clone(),
        ModuleKind::Server
        | ModuleKind::ServerEntry
        | ModuleKind::ServerAction
        | ModuleKind::ServerStore => conventions.server.clone(),
        ModuleKind::Shared => conventions.shared.clone(),
        ModuleKind::Unknown => Vec::new(),
    }
}

fn convention_patterns(config: &ArunaConfig, kind: &ModuleKind) -> Vec<String> {
    let convention = patterns_for_kind(&config.conventions, kind);

    // The fallback is all-or-nothing on purpose. A per-kind fallback makes an
    // intentionally empty kind (`conventions: { defaults: false, client: [...] }`
    // with no `shared`) impossible to express: it would silently reinstate the
    // shared defaults the caller just opted out of. The JS side always sends a
    // fully resolved convention set, so this only governs direct crate use.
    if config.conventions.is_empty() {
        let defaults = ConventionSet::for_root(&config.root);
        match kind {
            ModuleKind::Client | ModuleKind::ClientEntry => defaults.client,
            ModuleKind::Server
            | ModuleKind::ServerEntry
            | ModuleKind::ServerAction
            | ModuleKind::ServerStore => defaults.server,
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

// The folder form of a file-name convention: a concern that outgrew one file
// becomes a directory of the same name. `**/actions.ts` also covers
// `**/actions/**`, `**/ui.tsx` covers `**/ui/**`, and a project's own
// `src/domains/**/policy.ts` covers `src/domains/**/policy/**` — so splitting a
// concern never needs a config edit.
//
// The derived pattern sits in its own tier *below* real directory conventions:
// `src/shared/actions/util.ts` stays Shared because the `shared/` partition
// folder still outranks the `actions` concern, and it sits *above* the
// file-name tier so an enclosing concern folder beats a file name inside it
// (`domains/shop/ui/schema.ts` is client UI, not a shared schema).
fn derive_concern_directory_pattern(pattern: &str) -> Option<String> {
    let (prefix, last_segment) = match pattern.rsplit_once('/') {
        Some((prefix, last_segment)) => (Some(prefix), last_segment),
        None => (None, pattern),
    };
    let stem = last_segment.rsplit_once('.')?.0;
    if stem.is_empty() {
        return None;
    }
    Some(match prefix {
        Some(prefix) => format!("{prefix}/{stem}/**"),
        None => format!("{stem}/**"),
    })
}

// Match strength, strongest last. A path is classified by the kinds that match
// at its highest tier; lower-tier matches for other kinds are recorded as
// overridden rather than treated as a conflict.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum ConventionTier {
    FileName,
    ConcernDirectory,
    Directory,
}

fn matched_tier(patterns: &[String], path: &str) -> Option<ConventionTier> {
    let (file_patterns, directory_patterns): (Vec<String>, Vec<String>) = patterns
        .iter()
        .cloned()
        .partition(|pattern| is_file_name_pattern(pattern));
    let concern_directory_patterns: Vec<String> = file_patterns
        .iter()
        .filter_map(|pattern| derive_concern_directory_pattern(pattern))
        .collect();

    if matches_any(&directory_patterns, path) {
        Some(ConventionTier::Directory)
    } else if matches_any(&concern_directory_patterns, path) {
        Some(ConventionTier::ConcernDirectory)
    } else if matches_any(&file_patterns, path) {
        Some(ConventionTier::FileName)
    } else {
        None
    }
}

pub fn classify_relative_path(path: &str, conventions: &ConventionSet) -> ModuleClassification {
    let relative_path = normalize_path(path);
    let mut tier_matches: Vec<(ConventionTier, ModuleKind)> = Vec::new();

    for (kind, patterns) in [
        (ModuleKind::Client, &conventions.client),
        (ModuleKind::Server, &conventions.server),
        (ModuleKind::Shared, &conventions.shared),
    ] {
        if let Some(tier) = matched_tier(patterns, &relative_path) {
            tier_matches.push((tier, kind));
        }
    }

    let winning_tier = tier_matches.iter().map(|(tier, _)| *tier).max();
    let matched: Vec<ModuleKind> = tier_matches
        .iter()
        .filter(|(tier, _)| Some(*tier) == winning_tier)
        .map(|(_, kind)| *kind)
        .collect();

    match matched.as_slice() {
        [kind] => {
            let overridden: Vec<&str> = tier_matches
                .iter()
                .filter(|(tier, other)| Some(*tier) != winning_tier && other != kind)
                .map(|(_, other)| kind_label(other))
                .collect();
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
        ModuleKind::ServerStore => "server store",
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
    // Globs written in aruna.config.ts outrank the built-in Recommended Layout
    // set, whatever their shape. Without this tier the merged set would let a
    // *default* directory glob beat a *user's* file-name glob — so opting into
    // the defaults would silently reclassify files the project had already
    // pinned by hand. Empty when the project supplied no conventions, which
    // makes this a no-op for the zero-config case.
    let overrides = ConventionSet {
        client: patterns_for_kind(&config.convention_overrides, &ModuleKind::Client),
        server: patterns_for_kind(&config.convention_overrides, &ModuleKind::Server),
        shared: patterns_for_kind(&config.convention_overrides, &ModuleKind::Shared),
    };

    // Aruna owns the layout under `generatedDir` (server registry under
    // `server/`, stubs/signals/runtime under `shared/`). Classify generated
    // files by their path *relative to* `generatedDir` so a convention segment in
    // the generatedDir's own ancestry — e.g. `src/shared/.aruna` matching
    // `**/shared/**` — does not collide with the generated subtree's own kind and
    // produce a spurious multi-convention (ambiguous) match.
    let match_path = strip_generated_dir_prefix(&relative, &config.generated_dir).unwrap_or(relative);

    classify_with_overrides(&match_path, &overrides, &convention_set)
}

// Two-tier classification: config globs decide on their own whenever any of
// them matches — including an ambiguous multi-kind match, which is a defect in
// the project's own config and must not be papered over by a default. Only a
// path no config glob matches falls through to the full (defaults-inclusive)
// set.
pub fn classify_with_overrides(
    path: &str,
    overrides: &ConventionSet,
    effective: &ConventionSet,
) -> ModuleClassification {
    let from_overrides = classify_relative_path(path, overrides);
    if !from_overrides.matched_kinds.is_empty() {
        return from_overrides;
    }
    classify_relative_path(path, effective)
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
    fn classifies_folder_form_concerns() {
        let conventions = ConventionSet::default();

        // A concern that outgrew one file becomes a directory of the same name.
        for (path, expected) in [
            ("src/domains/shop/actions/buy.ts", ModuleKind::Server),
            ("src/domains/shop/runtime/boot.ts", ModuleKind::Server),
            ("src/domains/shop/ui/panel.tsx", ModuleKind::Client),
            ("src/domains/shop/schema/buy.ts", ModuleKind::Shared),
            ("src/domains/shop/model/entity.ts", ModuleKind::Shared),
            ("src/domains/shop/model/index.ts", ModuleKind::Shared),
            ("src/domains/round/signals/lifecycle.ts", ModuleKind::Shared),
            // Nested files inside the concern folder classify the same way.
            ("src/domains/shop/actions/admin/grant.ts", ModuleKind::Server),
        ] {
            assert_eq!(
                classify_relative_path(path, &conventions).kind,
                expected,
                "{path}"
            );
        }

        // A partition folder still outranks a concern folder, so a `shared/`
        // tree keeps its kind even when a segment shares a concern's name.
        let shared_actions = classify_relative_path("src/shared/actions/util.ts", &conventions);
        assert_eq!(shared_actions.kind, ModuleKind::Shared);
        assert_eq!(shared_actions.matched_kinds, vec![ModuleKind::Shared]);
        assert_eq!(
            classify_relative_path("src/domains/shop/server/schema.ts", &conventions).kind,
            ModuleKind::Server
        );

        // A concern folder outranks a file-name convention inside it: the
        // enclosing folder is the author's more specific statement.
        let ui_schema = classify_relative_path("src/domains/shop/ui/schema.ts", &conventions);
        assert_eq!(ui_schema.kind, ModuleKind::Client);
        assert_eq!(
            ui_schema.reason_detail.as_deref(),
            Some("directory convention overrode file-name convention: shared")
        );
    }

    #[test]
    fn derives_concern_directories_from_project_globs() {
        let mut config = ArunaConfig::default();
        config.convention_overrides.shared = vec!["src/domains/**/policy.ts".to_string()];
        config.conventions = ConventionConfig {
            client: vec!["**/ui.tsx".to_string()],
            server: vec!["**/actions.ts".to_string()],
            shared: vec!["src/domains/**/policy.ts".to_string()],
        };

        // The folder form comes with the glob the project already wrote.
        assert_eq!(
            classify_module(
                std::path::Path::new("/workspace"),
                std::path::Path::new("/workspace/src/domains/shop/policy/refunds.ts"),
                &config,
            )
            .kind,
            ModuleKind::Shared
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

    #[test]
    fn config_globs_outrank_the_defaults_they_are_merged_with() {
        let mut config = ArunaConfig::default();
        // A project that pinned `src/app/client.ts` as client by hand, and now
        // also inherits the `src/app/**` shared default. Without the override
        // tier the default's directory shape would beat the file-name glob and
        // silently reclassify the file.
        config.convention_overrides.client = vec!["src/app/client.ts".to_string()];
        config.conventions = ConventionConfig {
            client: vec![
                "**/client/**".to_string(),
                "**/ui.tsx".to_string(),
                "src/app/client.ts".to_string(),
            ],
            server: vec!["**/server/**".to_string()],
            shared: vec!["src/app/**".to_string()],
        };

        let pinned = classify_module(
            std::path::Path::new("/workspace"),
            std::path::Path::new("/workspace/src/app/client.ts"),
            &config,
        );
        assert_eq!(pinned.kind, ModuleKind::Client);

        // Anything the project did not pin still falls through to the defaults.
        let untouched = classify_module(
            std::path::Path::new("/workspace"),
            std::path::Path::new("/workspace/src/app/providers.ts"),
            &config,
        );
        assert_eq!(untouched.kind, ModuleKind::Shared);
    }
}
