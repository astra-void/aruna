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
#[serde(rename_all = "kebab-case")]
pub enum ActionTransport {
    RemoteEvent,
    RemoteFunction,
    Memory,
}

impl Default for ActionTransport {
    fn default() -> Self {
        Self::RemoteEvent
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
    pub transport: ActionTransport,
    #[serde(default)]
    pub default_rate_limit: ActionRateLimitConfig,
}

impl Default for ActionsConfig {
    fn default() -> Self {
        Self {
            transport: ActionTransport::default(),
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
    #[serde(default)]
    pub conventions: ConventionConfig,
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
            strict: StrictConfig::default(),
        }
    }
}
