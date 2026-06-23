use crate::config::ArunaConfig;
use crate::codegen::{generate_action_files, generate_signal_files, GeneratedFile};
use crate::diagnostics::{
    create_diagnostic, strip_ignored_diagnostics, summarize_diagnostics, ArunaDiagnostic,
};
use crate::files::discover_source_files;
use crate::graph::{build_project_graph, ArunaImportEdge, GraphImportRecord};
use crate::manifest::{create_manifest, ArunaManifest, ArunaModuleRecord};
use crate::module_kind::ModuleKind;
use crate::resolver::{
    is_bare_specifier, resolve_virtual_generated_action_module,
    resolve_virtual_generated_signal_module, TsconfigResolverOptions,
};
use crate::rules::boundary_code;
use serde::{Deserialize, Serialize};
use serde_json;
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
    #[serde(default)]
    pub write_generated: bool,
    #[serde(default)]
    pub warnings_as_errors: bool,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_files: Option<Vec<GeneratedFile>>,
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
            actions: Vec::new(),
            signals: Vec::new(),
            diagnostics: vec![diagnostic],
        },
        generated_files: None,
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
        "aruna::556" => "Keep server actions on the server side, and import client-safe stubs from $aruna/actions/client.",
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
        ModuleKind::ClientEntry => "client entry",
        ModuleKind::ServerEntry => "server entry",
        ModuleKind::ServerAction => "server action",
        ModuleKind::Unknown => "unknown",
    }
}

fn write_text_file(absolute_path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = absolute_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(absolute_path, contents).map_err(|error| error.to_string())
}

fn create_boundary_diagnostic(edge: &GraphImportRecord) -> Option<ArunaDiagnostic> {
    if !edge.edge.resolved {
        return None;
    }
    let imported_kind = edge.imported_kind?;
    let code = boundary_code(edge.importer_kind, imported_kind)?;
    let imported_display_path = if edge.edge.specifier.starts_with("$aruna/") {
        edge.edge.specifier.as_str()
    } else {
        edge.edge.to.as_deref().unwrap_or("")
    };
    Some(create_diagnostic(
        code,
        format_boundary_message(
            &edge.importer_path,
            edge.importer_kind,
            imported_display_path,
            imported_kind,
        ),
        Some(edge.importer_path.clone()),
        edge.span.clone(),
        Some(format!(
            "importer: {}\nimporter kind: {}\nimported: {}\nimported kind: {}",
            edge.importer_path,
            module_kind_label(edge.importer_kind),
            imported_display_path,
            module_kind_label(imported_kind)
        )),
        Some(boundary_suggestion(code).to_string()),
    ))
}

fn create_unresolved_import_diagnostic(edge: &GraphImportRecord) -> Option<ArunaDiagnostic> {
    if edge.edge.resolved
        || matches!(edge.importer_kind, ModuleKind::Unknown)
        || Path::new(&edge.edge.specifier).is_absolute()
    {
        return None;
    }

    if is_bare_specifier(&edge.edge.specifier) && !edge.edge.specifier.starts_with("$aruna/") {
        return None;
    }

    let (message, suggestion) = if edge.edge.specifier.starts_with("$aruna/") {
        let is_known_virtual = resolve_virtual_generated_action_module(&edge.edge.specifier)
            .is_some()
            || resolve_virtual_generated_signal_module(&edge.edge.specifier).is_some();
        if is_known_virtual {
            (
                format!(
                    "{} imports {}, but Aruna could not resolve the virtual module.",
                    edge.importer_path, edge.edge.specifier
                ),
                "Verify the Aruna-generated module mapping or rebuild the project.".to_string(),
            )
        } else {
            (
                format!(
                    "{} imports {}, but {} is not a known Aruna virtual module.",
                    edge.importer_path, edge.edge.specifier, edge.edge.specifier
                ),
                "Use $aruna/actions/client, $aruna/actions/server, or $aruna/signals, or import a real source file."
                    .to_string(),
            )
        }
    } else {
        (
            format!(
                "{} imports {}, but Aruna could not resolve it.",
                edge.importer_path, edge.edge.specifier
            ),
            "Check the relative path, tsconfig paths mapping, and file extension support."
                .to_string(),
        )
    };

    Some(create_diagnostic(
        "aruna::105",
        message,
        Some(edge.importer_path.clone()),
        edge.span.clone(),
        Some(format!(
            "importer kind: {}",
            module_kind_label(edge.importer_kind)
        )),
        Some(suggestion),
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

fn create_manifest_generated_file(manifest_path: &str, manifest: &ArunaManifest) -> Result<GeneratedFile, String> {
    let contents = serde_json::to_string_pretty(manifest).map_err(|error| error.to_string())?;

    Ok(GeneratedFile {
        path: manifest_path.to_string(),
        contents: format!("{contents}\n"),
    })
}

fn write_generated_files(project_root: &Path, generated_files: &[GeneratedFile]) -> Result<(), String> {
    for generated_file in generated_files {
        let absolute_path = if Path::new(&generated_file.path).is_absolute() {
            PathBuf::from(&generated_file.path)
        } else {
            project_root.join(&generated_file.path)
        };
        write_text_file(&absolute_path, &generated_file.contents)?;
    }

    Ok(())
}

fn run_project_inner(
    input: &CompilerInput,
    write_manifest: bool,
) -> Result<CompilerOutput, String> {
    let project_root = resolve_project_root(input);
    let files = discover_source_files(&project_root, &input.config)?;
    let graph = build_project_graph(
        &project_root,
        &input.config,
        &files,
        &input.tsconfig_options,
    )?;

    let ignore: Vec<String> = Vec::new();
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
    let warnings_as_errors = input.warnings_as_errors;

    let mut mutable_diagnostics = diagnostics.clone();
    let generated_output = if input.write_generated {
        let generated = generate_action_files(
            &input.config.generated_dir,
            &graph.actions,
            &input.config.actions.default_rate_limit,
            input.config.compiler.preserve_generated_comments,
        );
        mutable_diagnostics.extend(strip_ignored_diagnostics(
            &generated.diagnostics,
            &ignore,
        ));

        let mut files = generated.files;
        if !graph.signals.is_empty() {
            let generated_signals = generate_signal_files(
                &input.config.generated_dir,
                &graph.signals,
                input.config.compiler.preserve_generated_comments,
            );
            mutable_diagnostics.extend(strip_ignored_diagnostics(
                &generated_signals.diagnostics,
                &ignore,
            ));
            files.extend(generated_signals.files);
        }

        Some(files)
    } else {
        None
    };

    if let Some(generated_files) = &generated_output {
        if input.write_generated {
            if let Err(error) = write_generated_files(&project_root, generated_files) {
                mutable_diagnostics.push(create_diagnostic(
                    "aruna::701",
                    "Failed to write generated Aruna action files.",
                    None,
                    None,
                    Some(error),
                    Some(
                        "Check the destination directory permissions or disable generated output emission."
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
        &graph.actions,
        &graph.signals,
        &mutable_diagnostics,
    );

    let mut manifest_path = None;
    let mut generated_files = generated_output;
    if write_manifest {
        let output_path = if input.config.manifest_output.is_empty() {
            ".aruna/manifest.json".to_string()
        } else {
            input.config.manifest_output.clone()
        };
        if input.write_generated {
            if let Some(files) = generated_files.as_mut() {
                match create_manifest_generated_file(&output_path, &final_manifest) {
                    Ok(file) => files.push(file),
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
        }
        match write_manifest_file(&project_root, &output_path, &final_manifest) {
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
        &graph.actions,
        &graph.signals,
        &mutable_diagnostics,
    );
    let summary = summarize_diagnostics(&mutable_diagnostics, warnings_as_errors);

    Ok(CompilerOutput {
        ok: summary.errors == 0,
        project_root: project_root.to_string_lossy().to_string(),
        config: input.config.clone(),
        diagnostics: mutable_diagnostics,
        manifest: final_manifest,
        generated_files,
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
    run_project_with(input, write_manifest, |input, write_manifest| {
        run_project_inner(input, write_manifest)
    })
}

fn run_project_with(
    input: CompilerInput,
    write_manifest: bool,
    runner: impl FnOnce(&CompilerInput, bool) -> Result<CompilerOutput, String> + std::panic::UnwindSafe,
) -> CompilerOutput {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| runner(&input, write_manifest))) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ArunaConfig, CompilerConfig};
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn converts_panics_into_aruna_900_diagnostics() {
        let temp = TempDir::new().unwrap();
        let input = CompilerInput {
            project_root: temp.path().to_string_lossy().to_string(),
            ..CompilerInput::default()
        };

        let output = run_project_with(input, false, |_input, _write_manifest| -> Result<CompilerOutput, String> {
            panic!("forced internal error");
        });

        assert!(!output.ok);
        assert_eq!(output.diagnostics, output.manifest.diagnostics);
        assert_eq!(output.diagnostics[0].code, "aruna::900");
        assert_eq!(output.diagnostics[0].name, "internal-compiler-error");
        assert_eq!(output.diagnostics[0].severity, crate::diagnostics::DiagnosticSeverity::Error);
        assert_eq!(
            output.diagnostics[0].message,
            "Aruna encountered an internal compiler error."
        );
        assert_eq!(
            output.diagnostics[0].suggestion.as_deref(),
            Some("File a bug report with the project input and the stack trace.")
        );
        assert_eq!(output.summary.errors, 1);
    }

    #[test]
    fn converts_manifest_write_failures_into_aruna_700_diagnostics() {
        let temp = TempDir::new().unwrap();
        let project_root = temp.path();
        let manifest_output = project_root.join(".aruna");
        fs::write(&manifest_output, "occupied").unwrap();

        let input = CompilerInput {
            project_root: project_root.to_string_lossy().to_string(),
            config: ArunaConfig {
                manifest_output: ".aruna/manifest.json".to_string(),
                compiler: CompilerConfig {
                    preserve_generated_comments: true,
                },
                ..ArunaConfig::default()
            },
            ..CompilerInput::default()
        };

        let source = project_root.join("src/client/main.ts");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(source, "export const main = 1;\n").unwrap();
        fs::write(project_root.join("tsconfig.json"), "{\n  \"compilerOptions\": {}\n}\n").unwrap();

        let output = check_project(input);

        assert!(!output.ok);
        assert_eq!(output.diagnostics[0].code, "aruna::700");
        assert_eq!(output.diagnostics[0].name, "manifest-write-failed");
        assert_eq!(output.diagnostics[0].severity, crate::diagnostics::DiagnosticSeverity::Error);
        assert_eq!(output.diagnostics[0].message, "Failed to write the Aruna manifest.");
        assert!(!output.diagnostics[0].details.as_deref().unwrap_or("").is_empty());
        assert_eq!(
            output.diagnostics[0].suggestion.as_deref(),
            Some("Check the destination directory permissions or disable manifest emission.")
        );
    }

    #[test]
    fn writes_generated_action_files_when_requested() {
        let temp = TempDir::new().unwrap();
        let project_root = temp.path();

        let source_root = project_root.join("src/domains");
        fs::create_dir_all(source_root.join("shop")).unwrap();
        fs::create_dir_all(source_root.join("inventory")).unwrap();
        fs::write(
            project_root.join("src/client.tsx"),
            "export const client = 1;\n",
        )
        .unwrap();
        fs::write(
            project_root.join("src/server.ts"),
            "export const server = 1;\n",
        )
        .unwrap();
        fs::write(
            source_root.join("shop/actions.ts"),
            r#"
import { defineAction } from "aruna/server";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  run(ctx, input) {
    return { ctx, input };
  },
});
"#,
        )
        .unwrap();
        fs::write(
            source_root.join("inventory/actions.ts"),
            r#"
import { defineAction } from "aruna/server";

export const restockItem = defineAction({
  id: "inventory.restockItem",
  run(ctx, input) {
    return { ctx, input };
  },
});
"#,
        )
        .unwrap();
        fs::write(project_root.join("tsconfig.json"), "{\n  \"compilerOptions\": {}\n}\n").unwrap();

        let output = check_project(CompilerInput {
            project_root: project_root.to_string_lossy().to_string(),
            write_generated: true,
            ..CompilerInput::default()
        });

        assert!(output.ok);
        let generated = output.generated_files.as_ref().expect("generated files");
        assert_eq!(generated.len(), 3);
        assert_eq!(generated[0].path, "src/.aruna/actions.client.generated.ts");
        assert_eq!(generated[1].path, "src/.aruna/actions.server.generated.ts");
        assert_eq!(generated[2].path, "src/.aruna/manifest.json");
        assert_eq!(
            generated[0].contents,
            fs::read_to_string(project_root.join("src/.aruna/actions.client.generated.ts")).unwrap()
        );
        assert_eq!(
            generated[1].contents,
            fs::read_to_string(project_root.join("src/.aruna/actions.server.generated.ts")).unwrap()
        );
        assert_eq!(
            generated[2].contents,
            fs::read_to_string(project_root.join("src/.aruna/manifest.json")).unwrap()
        );
        assert!(generated[0]
            .contents
            .contains("export type RestockItemInput = unknown;"));
        assert!(generated[0]
            .contents
            .contains("export type RestockItemOutput = unknown;"));
        assert!(generated[0]
            .contents
            .contains("return invokeAction(\"inventory.restockItem\", input) as Promise<RestockItemOutput>;"));
        assert!(generated[0]
            .contents
            .contains("export type PurchaseItemInput = unknown;"));
        assert!(generated[0]
            .contents
            .contains("export type PurchaseItemOutput = unknown;"));
        assert!(generated[0]
            .contents
            .contains("return invokeAction(\"shop.purchaseItem\", input) as Promise<PurchaseItemOutput>;"));
        assert!(generated[1]
            .contents
            .contains("import { restockItem as src_domains_inventory_actions_restockItem } from \"../domains/inventory/actions\";"));
        assert!(generated[1]
            .contents
            .contains("import { purchaseItem as src_domains_shop_actions_purchaseItem } from \"../domains/shop/actions\";"));
    }
}
