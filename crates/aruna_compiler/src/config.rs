use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceConfig {
    #[serde(default)]
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsConfig {
    #[serde(default)]
    pub warnings_as_errors: bool,
    #[serde(default)]
    pub ignore: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SecurityMode {
    Recommended,
    Strict,
    Audit,
    Off,
}

impl Default for SecurityMode {
    fn default() -> Self {
        Self::Recommended
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecurityConfig {
    #[serde(default)]
    pub mode: SecurityMode,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestConfig {
    #[serde(default = "default_manifest_enabled")]
    pub enabled: bool,
    #[serde(default = "default_manifest_output")]
    pub output: String,
}

fn default_manifest_enabled() -> bool {
    true
}

fn default_manifest_output() -> String {
    ".aruna/manifest.json".to_string()
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
    #[serde(default)]
    pub root: Option<String>,
    #[serde(default = "default_tsconfig")]
    pub tsconfig: String,
    #[serde(default)]
    pub source: SourceConfig,
    #[serde(default)]
    pub conventions: ConventionConfig,
    #[serde(default)]
    pub diagnostics: DiagnosticsConfig,
    #[serde(default)]
    pub security: SecurityConfig,
    #[serde(default)]
    pub manifest: ManifestConfig,
}

fn default_tsconfig() -> String {
    "tsconfig.json".to_string()
}

impl Default for SourceConfig {
    fn default() -> Self {
        Self {
            include: vec!["src/**/*.ts".to_string(), "src/**/*.tsx".to_string()],
            exclude: vec![
                "node_modules/**".to_string(),
                "out/**".to_string(),
                ".aruna/**".to_string(),
            ],
        }
    }
}

impl Default for DiagnosticsConfig {
    fn default() -> Self {
        Self {
            warnings_as_errors: false,
            ignore: Vec::new(),
        }
    }
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            mode: SecurityMode::Recommended,
        }
    }
}

impl Default for ManifestConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            output: default_manifest_output(),
        }
    }
}

impl Default for ArunaConfig {
    fn default() -> Self {
        Self {
            root: None,
            tsconfig: default_tsconfig(),
            source: SourceConfig::default(),
            conventions: ConventionConfig::default(),
            diagnostics: DiagnosticsConfig::default(),
            security: SecurityConfig::default(),
            manifest: ManifestConfig::default(),
        }
    }
}
