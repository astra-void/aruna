use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompilerConfig {
    #[serde(default = "default_preserve_generated_comments")]
    pub preserve_generated_comments: bool,
}

fn default_preserve_generated_comments() -> bool {
    true
}

impl Default for CompilerConfig {
    fn default() -> Self {
        Self {
            preserve_generated_comments: default_preserve_generated_comments(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActionRateLimitConfig {
    #[serde(default = "default_action_rate_limit_key")]
    pub key: String,
    #[serde(default = "default_action_rate_limit_window_ms")]
    pub window_ms: u32,
    #[serde(default = "default_action_rate_limit_max")]
    pub max: u32,
}

fn default_action_rate_limit_key() -> String {
    "player".to_string()
}

fn default_action_rate_limit_window_ms() -> u32 {
    1000
}

fn default_action_rate_limit_max() -> u32 {
    20
}

impl Default for ActionRateLimitConfig {
    fn default() -> Self {
        Self {
            key: default_action_rate_limit_key(),
            window_ms: default_action_rate_limit_window_ms(),
            max: default_action_rate_limit_max(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActionsConfig {
    #[serde(default)]
    pub default_rate_limit: ActionRateLimitConfig,
}

impl Default for ActionsConfig {
    fn default() -> Self {
        Self {
            default_rate_limit: ActionRateLimitConfig::default(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StrictSeverity {
    Off,
    Warning,
    Error,
}

impl Default for StrictSeverity {
    fn default() -> Self {
        Self::Warning
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StrictConfig {
    #[serde(default = "default_shared_safety")]
    pub shared_safety: bool,
    #[serde(default)]
    pub raw_remote_usage: StrictSeverity,
    #[serde(default)]
    pub unresolved_imports: StrictSeverity,
    // Cross-domain imports that reach past a domain's public surface. A warning
    // by default: domain taxonomy is the project's, and a boundary the project
    // never asked for must not fail its build on the day it upgrades.
    #[serde(default)]
    pub domain_boundary: StrictSeverity,
}

fn default_shared_safety() -> bool {
    true
}

impl Default for StrictConfig {
    fn default() -> Self {
        Self {
            shared_safety: default_shared_safety(),
            raw_remote_usage: StrictSeverity::default(),
            unresolved_imports: StrictSeverity::default(),
            domain_boundary: StrictSeverity::default(),
        }
    }
}

// Who owns the runtime entry scripts. `User` is the classic model: the project
// provides `src/server.ts` / `src/client.tsx` and they become the Script /
// LocalScript. `Generated` moves entry ownership to codegen: Aruna emits
// `<generatedDir>/server/main.server.ts` + `<generatedDir>/client/main.client.ts`
// from the manifest, and the user entry files (when present) become plain hook
// modules imported by the generated mains.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum EntriesMode {
    #[default]
    User,
    Generated,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConventionConfig {
    #[serde(default)]
    pub client: Vec<String>,
    #[serde(default)]
    pub server: Vec<String>,
    #[serde(default)]
    pub shared: Vec<String>,
}

impl ConventionConfig {
    // No convention at all was supplied, so the built-in Recommended Layout set
    // applies. Deliberately not per-kind: see `convention_patterns`.
    pub fn is_empty(&self) -> bool {
        self.client.is_empty() && self.server.is_empty() && self.shared.is_empty()
    }
}

// Which directories are domain units. Empty means the built-in
// `<root>/domains/*`; see `default_domain_roots` in domains.rs. The JS side
// always sends the effective list, so this only governs direct crate use.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DomainsConfig {
    #[serde(default)]
    pub roots: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArunaConfig {
    #[serde(default = "default_root")]
    pub root: String,
    #[serde(default = "default_generated_dir")]
    pub generated_dir: String,
    #[serde(default = "default_manifest_output")]
    pub manifest_output: String,
    #[serde(default)]
    pub entries: EntriesMode,
    #[serde(default)]
    pub compiler: CompilerConfig,
    #[serde(default)]
    pub actions: ActionsConfig,
    // The effective convention set: built-in defaults merged with the project's
    // own globs (unless it opted out via `conventions.defaults: false`).
    #[serde(default)]
    pub conventions: ConventionConfig,
    // Just the project's own globs, which outrank the defaults inside
    // `conventions`. See `classify_with_overrides`.
    #[serde(default)]
    pub convention_overrides: ConventionConfig,
    #[serde(default)]
    pub domains: DomainsConfig,
    #[serde(default)]
    pub strict: StrictConfig,
}

fn default_root() -> String {
    "src".to_string()
}

fn default_generated_dir() -> String {
    "src/.aruna".to_string()
}

fn default_manifest_output() -> String {
    "src/.aruna/manifest.json".to_string()
}

impl Default for ArunaConfig {
    fn default() -> Self {
        Self {
            root: default_root(),
            generated_dir: default_generated_dir(),
            manifest_output: default_manifest_output(),
            entries: EntriesMode::default(),
            compiler: CompilerConfig::default(),
            actions: ActionsConfig::default(),
            conventions: ConventionConfig::default(),
            convention_overrides: ConventionConfig::default(),
            domains: DomainsConfig::default(),
            strict: StrictConfig::default(),
        }
    }
}
