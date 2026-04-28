pub mod compiler;
pub mod config;
pub mod diagnostics;
pub mod files;
pub mod graph;
pub mod manifest;
pub mod module_kind;
pub mod parser;
pub mod resolver;
pub mod rules;

pub use compiler::{
    check_project, inspect_project, CompilerInput, CompilerOutput, CompilerSummary,
};
pub use config::{
    ArunaConfig, ConventionConfig, DiagnosticsConfig, ManifestConfig, SecurityConfig, SourceConfig,
};
pub use diagnostics::{
    create_diagnostic, diagnostic_meta, is_error_severity, stable_sort_diagnostics,
    strip_ignored_diagnostics, summarize_diagnostics, ArunaDiagnostic, DiagnosticSeverity,
    DiagnosticSpan, DiagnosticSummary,
};
pub use files::{discover_source_files, normalize_path, project_absolute, project_relative};
pub use graph::{
    build_project_graph, ArunaImportEdge, BuildGraphResult, GraphImportRecord, ImportKind,
};
pub use manifest::{create_manifest, ArunaManifest, ArunaModuleRecord};
pub use module_kind::{
    classify_module, classify_relative_path, ConventionSet, ModuleClassification, ModuleKind,
    ModuleReason,
};
pub use parser::{collect_static_imports, StaticImportRecord};
pub use resolver::{resolve_import_specifier, ResolvedImport, TsconfigResolverOptions};
pub use rules::boundary_code;
