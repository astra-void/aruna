pub mod codegen;
pub mod compiler;
pub mod config;
pub mod diagnostics;
pub mod domains;
pub mod files;
pub mod graph;
pub mod manifest;
pub mod module_kind;
pub mod parser;
pub mod payload_size;
pub mod primitives;
pub mod raw_remote;
pub mod resolver;
pub mod rules;
pub mod schema_metadata;
pub mod spans;
pub mod static_literals;

pub use compiler::{
    check_project, inspect_project, CompilerInput, CompilerOutput, CompilerSummary,
};
pub use codegen::{
    generate_action_files, generate_signal_files, GeneratedActionOutput, GeneratedFile,
    GeneratedSignalOutput,
};
pub use primitives::{
    collect_action_definitions, collect_runtime_definitions, collect_signal_definitions,
    collect_store_definitions, resolve_runtime_order, ActionDiscoveryResult, ArunaActionRateLimitMetadata, ArunaActionRecord,
    ArunaSignalRecord, ArunaStoreKind,
    ArunaRuntimeRecord, ArunaStoreRecord, RuntimeDiscoveryResult, SignalDiscoveryResult,
    StoreDiscoveryResult,
};
pub use schema_metadata::{ArunaSchemaLiteralMetadata, ArunaSchemaMetadata};
pub use config::{
    ActionRateLimitConfig, ArunaConfig, CompilerConfig, ContractConfig, ConventionConfig,
    DiagnosticsConfig, DomainsConfig, EntriesMode, StrictConfig, StrictSeverity,
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
