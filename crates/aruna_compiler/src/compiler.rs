use crate::config::ArunaConfig;
use crate::diagnostics::{
    create_diagnostic, strip_ignored_diagnostics, summarize_diagnostics, ArunaDiagnostic,
};
use crate::files::discover_source_files;
use crate::graph::{build_project_graph, ArunaImportEdge, GraphImportRecord};
use crate::manifest::{create_manifest, ArunaManifest, ArunaModuleRecord};
use crate::module_kind::ModuleKind;
use crate::resolver::TsconfigResolverOptions;
use crate::rules::boundary_code;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompilerInput {
    pub project_root: String,
    #[serde(default)]
    pub config: ArunaConfig,
    #[serde(default)]
    pub config_diagnostics: Vec<ArunaDiagnostic>,
    #[serde(default)]
    pub tsconfig_options: TsconfigResolverOptions,
    #[serde(default)]
    pub write_manifest: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompilerSummary {
    pub modules: usize,
    pub imports: usize,
    pub resolved_imports: usize,
    pub errors: usize,
    pub warnings: usize,
    pub infos: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompilerOutput {
    pub ok: bool,
    pub project_root: String,
    pub config: ArunaConfig,
    pub diagnostics: Vec<ArunaDiagnostic>,
    pub manifest: ArunaManifest,
    pub summary: CompilerSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_path: Option<String>,
}

fn resolve_project_root(input: &CompilerInput) -> PathBuf {
    PathBuf::from(&input.project_root)
}

fn internal_error_output(input: &CompilerInput, message: String) -> CompilerOutput {
    let diagnostic = create_diagnostic(
        "aruna::900",
        "Aruna encountered an internal compiler error.",
        None,
        None,
        Some(message),
        Some("File a bug report with the project input and the stack trace.".to_string()),
    );
    CompilerOutput {
        ok: false,
        project_root: input.project_root.clone(),
        config: input.config.clone(),
        diagnostics: vec![diagnostic.clone()],
        manifest: ArunaManifest {
            version: 1,
            project_root: ".".to_string(),
            modules: Vec::new(),
            imports: Vec::new(),
            diagnostics: vec![diagnostic],
        },
        summary: CompilerSummary {
            modules: 0,
            imports: 0,
            resolved_imports: 0,
            errors: 1,
            warnings: 0,
            infos: 0,
        },
        manifest_path: None,
    }
}

fn boundary_suggestion(code: &str) -> &'static str {
    match code {
        "aruna::300" => "Move shared logic into shared/, or expose the operation through a future action.",
        "aruna::301" => "Move shared logic into shared/, or pass data from the client into a server entrypoint later.",
        "aruna::302" => "Keep shared modules free of client-only imports, or split client code into client/.",
        "aruna::303" => "Keep shared modules free of server-only imports, or split server code into server/.",
        _ => "Refactor the import so each module only reaches the boundaries it is allowed to use.",
    }
}

fn format_boundary_message(
    importer_path: &str,
    importer_kind: ModuleKind,
    imported_path: &str,
    imported_kind: ModuleKind,
) -> String {
    format!(
        "{importer_path} is classified as {}. It imports {imported_path}, which is classified as {}.",
        module_kind_label(importer_kind),
        module_kind_label(imported_kind)
    )
}

fn module_kind_label(kind: ModuleKind) -> &'static str {
    match kind {
        ModuleKind::Client => "client",
        ModuleKind::Server => "server",
        ModuleKind::Shared => "shared",
        ModuleKind::Unknown => "unknown",
    }
}

fn create_boundary_diagnostic(edge: &GraphImportRecord) -> Option<ArunaDiagnostic> {
    if !edge.edge.resolved {
        return None;
    }
    let imported_kind = edge.imported_kind?;
    let code = boundary_code(edge.importer_kind, imported_kind)?;
    Some(create_diagnostic(
        code,
        format_boundary_message(
            &edge.importer_path,
            edge.importer_kind,
            edge.edge.to.as_deref().unwrap_or(""),
            imported_kind,
        ),
        Some(edge.importer_path.clone()),
        edge.span.clone(),
        Some(format!(
            "importer: {}\nimporter kind: {}\nimported: {}\nimported kind: {}",
            edge.importer_path,
            module_kind_label(edge.importer_kind),
            edge.edge.to.as_deref().unwrap_or(""),
            module_kind_label(imported_kind)
        )),
        Some(boundary_suggestion(code).to_string()),
    ))
}

fn create_unresolved_import_diagnostic(edge: &GraphImportRecord) -> Option<ArunaDiagnostic> {
    if edge.edge.resolved || matches!(edge.importer_kind, ModuleKind::Unknown) {
        return None;
    }

    Some(create_diagnostic(
        "aruna::105",
        format!(
            "{} imports {}, but Aruna could not resolve it.",
            edge.importer_path, edge.edge.specifier
        ),
        Some(edge.importer_path.clone()),
        edge.span.clone(),
        Some(format!(
            "importer kind: {}",
            module_kind_label(edge.importer_kind)
        )),
        Some(
            "Check the relative path, tsconfig paths mapping, and file extension support."
                .to_string(),
        ),
    ))
}

fn create_unknown_module_diagnostics(
    modules: &[ArunaModuleRecord],
    touched_unknown_kinds: &BTreeSet<String>,
) -> Vec<ArunaDiagnostic> {
    modules
        .iter()
        .filter(|module| module.kind == ModuleKind::Unknown && touched_unknown_kinds.contains(&module.path))
        .map(|module| {
            create_diagnostic(
                "aruna::200",
                format!("{} could not be classified as client, server, or shared.", module.path),
                Some(module.path.clone()),
                None,
                Some(
                    "The module participates in a resolved import edge, so its boundary role matters."
                        .to_string(),
                ),
                Some(
                    "Place the file under client/, server/, or shared/, or adjust the convention patterns."
                        .to_string(),
                ),
            )
        })
        .collect()
}

fn build_diagnostics(
    graph_diagnostics: &[ArunaDiagnostic],
    imports: &[GraphImportRecord],
    modules: &[ArunaModuleRecord],
    config_diagnostics: &[ArunaDiagnostic],
    ignore: &[String],
) -> Vec<ArunaDiagnostic> {
    let mut diagnostics = Vec::new();
    diagnostics.extend(config_diagnostics.iter().cloned());
    diagnostics.extend(graph_diagnostics.iter().cloned());

    let mut touched_unknown_kinds = BTreeSet::new();
    for edge in imports {
        if !edge.edge.resolved {
            if let Some(unresolved) = create_unresolved_import_diagnostic(edge) {
                diagnostics.push(unresolved);
            }
            continue;
        }

        if matches!(edge.importer_kind, ModuleKind::Unknown) {
            touched_unknown_kinds.insert(edge.importer_path.clone());
        }
        if matches!(edge.imported_kind, Some(ModuleKind::Unknown)) {
            if let Some(to) = &edge.edge.to {
                touched_unknown_kinds.insert(to.clone());
            }
        }

        if let Some(boundary) = create_boundary_diagnostic(edge) {
            diagnostics.push(boundary);
        }
    }

    diagnostics.extend(create_unknown_module_diagnostics(
        modules,
        &touched_unknown_kinds,
    ));
    strip_ignored_diagnostics(&diagnostics, ignore)
}

fn write_manifest_file(
    project_root: &Path,
    manifest_path: &str,
    manifest: &ArunaManifest,
) -> Result<String, String> {
    let absolute_path = if Path::new(manifest_path).is_absolute() {
        PathBuf::from(manifest_path)
    } else {
        project_root.join(manifest_path)
    };
    if let Some(parent) = absolute_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let json = serde_json::to_string_pretty(manifest).map_err(|error| error.to_string())?;
    fs::write(&absolute_path, format!("{json}\n")).map_err(|error| error.to_string())?;
    Ok(absolute_path.to_string_lossy().to_string())
}

fn run_project_inner(
    input: &CompilerInput,
    write_manifest: bool,
) -> Result<CompilerOutput, String> {
    let project_root = resolve_project_root(input);
    let files = discover_source_files(&project_root, &input.config.source)?;
    let graph = build_project_graph(
        &project_root,
        &input.config,
        &files,
        &input.tsconfig_options,
    )?;

    let ignore = input.config.diagnostics.ignore.clone();
    let diagnostics = build_diagnostics(
        &graph.diagnostics,
        &graph.imports,
        &graph.modules,
        &input.config_diagnostics,
        &ignore,
    );
    let resolved_imports = graph
        .imports
        .iter()
        .filter(|edge| edge.edge.resolved)
        .count();
    let warnings_as_errors = input.config.diagnostics.warnings_as_errors;

    let mut mutable_diagnostics = diagnostics.clone();
    let manifest_for_output = create_manifest(
        ".",
        &graph.modules,
        &graph
            .imports
            .iter()
            .map(|edge| edge.edge.clone())
            .collect::<Vec<ArunaImportEdge>>(),
        &mutable_diagnostics,
    );

    let mut manifest_path = None;
    if write_manifest && input.config.manifest.enabled {
        let output_path = if input.config.manifest.output.is_empty() {
            ".aruna/manifest.json".to_string()
        } else {
            input.config.manifest.output.clone()
        };
        match write_manifest_file(&project_root, &output_path, &manifest_for_output) {
            Ok(path) => {
                manifest_path = Some(path);
            }
            Err(error) => {
                mutable_diagnostics.push(create_diagnostic(
                    "aruna::700",
                    "Failed to write the Aruna manifest.",
                    None,
                    None,
                    Some(error),
                    Some(
                        "Check the destination directory permissions or disable manifest emission."
                            .to_string(),
                    ),
                ));
            }
        }
    }

    let final_manifest = create_manifest(
        ".",
        &graph.modules,
        &graph
            .imports
            .iter()
            .map(|edge| edge.edge.clone())
            .collect::<Vec<ArunaImportEdge>>(),
        &mutable_diagnostics,
    );
    let summary = summarize_diagnostics(&mutable_diagnostics, warnings_as_errors);

    Ok(CompilerOutput {
        ok: summary.errors == 0,
        project_root: project_root.to_string_lossy().to_string(),
        config: input.config.clone(),
        diagnostics: mutable_diagnostics,
        manifest: final_manifest,
        summary: CompilerSummary {
            modules: graph.modules.len(),
            imports: graph.imports.len(),
            resolved_imports,
            errors: summary.errors,
            warnings: summary.warnings,
            infos: summary.infos,
        },
        manifest_path,
    })
}

fn run_project(input: CompilerInput, write_manifest: bool) -> CompilerOutput {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        run_project_inner(&input, write_manifest)
    })) {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => internal_error_output(&input, error),
        Err(payload) => {
            let message = if let Some(message) = payload.downcast_ref::<&str>() {
                message.to_string()
            } else if let Some(message) = payload.downcast_ref::<String>() {
                message.clone()
            } else {
                "unknown panic".to_string()
            };
            internal_error_output(&input, message)
        }
    }
}

pub fn check_project(input: CompilerInput) -> CompilerOutput {
    run_project(input, true)
}

pub fn inspect_project(input: CompilerInput) -> CompilerOutput {
    run_project(input, false)
}
