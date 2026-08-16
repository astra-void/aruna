pub mod codegen;
pub mod actions;
pub mod compiler;
pub mod config;
pub mod diagnostics;
pub mod domains;
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
pub use codegen::{
    generate_action_files, generate_signal_files, GeneratedActionOutput, GeneratedFile,
    GeneratedSignalOutput,
};
pub use actions::{
    collect_action_definitions, collect_runtime_definitions, collect_signal_definitions,
    collect_store_definitions, resolve_runtime_order, ActionDiscoveryResult, ArunaActionRateLimitMetadata, ArunaActionRecord,
    ArunaSchemaLiteralMetadata, ArunaSchemaMetadata, ArunaSignalRecord, ArunaStoreKind,
    ArunaRuntimeRecord, ArunaStoreRecord, RuntimeDiscoveryResult, SignalDiscoveryResult,
    StoreDiscoveryResult,
};
pub use config::{
    ActionRateLimitConfig, ArunaConfig, CompilerConfig, ConventionConfig, DomainsConfig,
    EntriesMode, StrictConfig, StrictSeverity,
};
pub use domains::{DomainIndex, DomainRef, PublicSurface};
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
