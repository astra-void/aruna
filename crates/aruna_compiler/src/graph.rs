use crate::config::ArunaConfig;
use crate::actions::{
    collect_action_definitions, collect_signal_definitions, ArunaActionRecord, ArunaSignalRecord,
};
use crate::diagnostics::{create_diagnostic, ArunaDiagnostic, DiagnosticSpan};
use crate::files::{normalize_path, project_absolute, project_relative};
use crate::manifest::ArunaModuleRecord;
use crate::module_kind::{classify_module, ModuleKind, ModuleReason};
use crate::parser::collect_static_imports;
use crate::resolver::{
    resolve_import_specifier, TsconfigResolverOptions, VirtualGeneratedActionModule,
    VirtualGeneratedSignalModule,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ImportKind {
    Static,
    Dynamic,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArunaImportEdge {
    pub from: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    pub specifier: String,
    pub resolved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<ImportKind>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphImportRecord {
    #[serde(flatten)]
    pub edge: ArunaImportEdge,
    pub importer_kind: ModuleKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imported_kind: Option<ModuleKind>,
    pub importer_path: String,
    pub importer_absolute_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imported_absolute_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span: Option<DiagnosticSpan>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BuildGraphResult {
    pub modules: Vec<ArunaModuleRecord>,
    pub imports: Vec<GraphImportRecord>,
    pub actions: Vec<ArunaActionRecord>,
    #[serde(default)]
    pub signals: Vec<ArunaSignalRecord>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty", default)]
    pub module_map: BTreeMap<String, ArunaModuleRecord>,
    pub diagnostics: Vec<ArunaDiagnostic>,
}

fn create_parse_failed_diagnostic(relative_path: &str, error: String) -> ArunaDiagnostic {
    create_diagnostic(
        "aruna::106",
        format!("Aruna could not parse {relative_path}."),
        Some(relative_path.to_string()),
        None,
        Some(format!("Oxc parser error: {error}")),
        Some("Check the TypeScript/TSX syntax in this file.".to_string()),
    )
}

fn push_parse_failed_diagnostic(
    diagnostics: &mut Vec<ArunaDiagnostic>,
    parse_failed_files: &mut BTreeSet<String>,
    relative_path: &str,
    error: String,
) {
    if parse_failed_files.insert(relative_path.to_string()) {
        diagnostics.push(create_parse_failed_diagnostic(relative_path, error));
    }
}

fn virtual_generated_action_module_record(
    project_root: &Path,
    generated_dir: &str,
    module: VirtualGeneratedActionModule,
) -> ArunaModuleRecord {
    let absolute_path = project_absolute(project_root, generated_dir).join(module.filename());
    let relative_path = project_relative(project_root, &absolute_path);
    ArunaModuleRecord {
        id: relative_path.clone(),
        path: relative_path,
        kind: match module {
            VirtualGeneratedActionModule::Client => ModuleKind::Client,
            VirtualGeneratedActionModule::Server => ModuleKind::ServerAction,
        },
        reason: ModuleReason::Directive,
        reason_detail: Some("virtual $aruna/actions module".to_string()),
    }
}

fn virtual_generated_signal_module_record(
    project_root: &Path,
    generated_dir: &str,
    module: VirtualGeneratedSignalModule,
) -> ArunaModuleRecord {
    let absolute_path = project_absolute(project_root, generated_dir).join(module.filename());
    let relative_path = project_relative(project_root, &absolute_path);
    ArunaModuleRecord {
        id: relative_path.clone(),
        path: relative_path,
        // Signals are shared contracts, importable from both the client
        // subscriber and the server publisher.
        kind: ModuleKind::Shared,
        reason: ModuleReason::Directive,
        reason_detail: Some("virtual $aruna/signals module".to_string()),
    }
}

pub fn build_project_graph(
    project_root: &Path,
    config: &ArunaConfig,
    files: &[PathBuf],
    resolver_options: &TsconfigResolverOptions,
) -> Result<BuildGraphResult, String> {
    let mut module_records = Vec::new();
    let mut module_map = BTreeMap::new();
    let mut diagnostics = Vec::new();
    let mut parse_failed_files = BTreeSet::new();
    let discovered_files: BTreeSet<String> = files
        .iter()
        .map(|path| project_relative(project_root, path))
        .collect();

    for absolute_path in files {
        let classification = classify_module(project_root, absolute_path, config);
        let relative_path = project_relative(project_root, absolute_path);
        let reason = if classification.kind == ModuleKind::Unknown
            && classification.matched_kinds.is_empty()
        {
            ModuleReason::Fallback
        } else {
            ModuleReason::Path
        };
        let record = ArunaModuleRecord {
            id: relative_path.clone(),
            path: relative_path.clone(),
            kind: classification.kind,
            reason,
            reason_detail: classification.reason_detail.clone(),
        };

        if classification.matched_kinds.len() > 1 {
            diagnostics.push(create_diagnostic(
                "aruna::203",
                format!("{relative_path} matches more than one module convention."),
                Some(relative_path.clone()),
                None,
                classification.reason_detail.clone(),
                Some(
                    "Narrow the matching conventions so each file maps to exactly one module kind."
                        .to_string(),
                ),
            ));
        }

        module_map.insert(relative_path.clone(), record.clone());
        module_records.push(record);
    }

    let mut action_records = Vec::new();
    let mut action_files = BTreeSet::new();
    let mut signal_records = Vec::new();

    for absolute_path in files {
        let source_text = fs::read_to_string(absolute_path).map_err(|error| error.to_string())?;
        match collect_action_definitions(project_root, absolute_path, &source_text) {
            Ok(result) => {
                action_records.extend(result.actions);
                action_files.extend(result.action_files);
                diagnostics.extend(result.diagnostics);
            }
            Err(error) => {
                let relative_path = project_relative(project_root, absolute_path);
                push_parse_failed_diagnostic(
                    &mut diagnostics,
                    &mut parse_failed_files,
                    &relative_path,
                    error,
                );
            }
        }

        // Signal discovery shares the per-file parse pattern. A parse failure was
        // already reported by the action pass above, so only the Ok case adds work.
        if let Ok(result) = collect_signal_definitions(project_root, absolute_path, &source_text) {
            signal_records.extend(result.signals);
            diagnostics.extend(result.diagnostics);
        }
    }

    action_records.sort_by(|left, right| {
        left.id
            .cmp(&right.id)
            .then_with(|| left.file.cmp(&right.file))
            .then_with(|| left.export_name.cmp(&right.export_name))
    });

    let mut seen_action_ids = BTreeMap::new();
    for action in &action_records {
        if let Some(previous_file) = seen_action_ids.insert(action.id.clone(), action.file.clone()) {
            diagnostics.push(create_diagnostic(
                "aruna::555",
                format!("Server action id {} is defined more than once.", action.id),
                Some(action.file.clone()),
                None,
                Some(format!(
                    "First defined in {}, then again in {}.",
                    previous_file, action.file
                )),
                Some("Use globally unique action ids such as domain.actionName.".to_string()),
            ));
        }
    }

    for module in &mut module_records {
        if action_files.contains(&module.path) {
            module.kind = ModuleKind::ServerAction;
            module.reason = ModuleReason::Directive;
            module.reason_detail = Some("defineAction(...) export detected".to_string());
        }
    }
    for module in module_map.values_mut() {
        if action_files.contains(&module.path) {
            module.kind = ModuleKind::ServerAction;
            module.reason = ModuleReason::Directive;
            module.reason_detail = Some("defineAction(...) export detected".to_string());
        }
    }

    if !action_records.is_empty() {
        for virtual_module in [
            VirtualGeneratedActionModule::Client,
            VirtualGeneratedActionModule::Server,
        ] {
            let record = virtual_generated_action_module_record(
                project_root,
                &config.generated_dir,
                virtual_module,
            );
            module_map.insert(record.path.clone(), record.clone());
            module_records.push(record);
        }
    }

    if !signal_records.is_empty() {
        let record = virtual_generated_signal_module_record(
            project_root,
            &config.generated_dir,
            VirtualGeneratedSignalModule,
        );
        module_map.insert(record.path.clone(), record.clone());
        module_records.push(record);
    }

    let mut imports = Vec::new();

    for absolute_path in files {
        let relative_from = project_relative(project_root, absolute_path);
        let importer_record = module_map.get(&relative_from);
        let source_text = fs::read_to_string(absolute_path).map_err(|error| error.to_string())?;
        let static_imports = match collect_static_imports(absolute_path, &source_text) {
            Ok(imports) => imports,
            Err(error) => {
                push_parse_failed_diagnostic(
                    &mut diagnostics,
                    &mut parse_failed_files,
                    &relative_from,
                    error,
                );
                continue;
            }
        };

        for entry in static_imports {
            let resolved = resolve_import_specifier(
                project_root,
                absolute_path,
                &config.generated_dir,
                &entry.specifier,
                resolver_options,
                &discovered_files,
            );

            if !resolved.resolved {
                imports.push(GraphImportRecord {
                    edge: ArunaImportEdge {
                        from: relative_from.clone(),
                        to: None,
                        specifier: entry.specifier,
                        resolved: false,
                        kind: Some(ImportKind::Static),
                    },
                    importer_kind: importer_record
                        .map(|record| record.kind)
                        .unwrap_or(ModuleKind::Unknown),
                    imported_kind: None,
                    importer_path: relative_from.clone(),
                    importer_absolute_path: normalize_path(&absolute_path.to_string_lossy()),
                    imported_absolute_path: None,
                    span: Some(DiagnosticSpan {
                        start: entry.start,
                        end: entry.end,
                    }),
                });
                continue;
            }

            let imported_absolute_path = resolved
                .absolute_path
                .map(|path| normalize_path(&path.to_string_lossy()));
            let imported_relative = imported_absolute_path
                .as_ref()
                .map(|path| {
                    Path::new(path)
                        .strip_prefix(project_root)
                        .map(|value| normalize_path(&value.to_string_lossy()))
                        .unwrap_or_else(|_| path.clone())
                })
                .unwrap_or_default();
            let imported_kind = module_map
                .get(imported_relative.as_str())
                .map(|record| record.kind);

            imports.push(GraphImportRecord {
                edge: ArunaImportEdge {
                    from: relative_from.clone(),
                    to: Some(imported_relative.clone()),
                    specifier: entry.specifier,
                    resolved: true,
                    kind: Some(ImportKind::Static),
                },
                importer_kind: importer_record
                    .map(|record| record.kind)
                    .unwrap_or(ModuleKind::Unknown),
                imported_kind,
                importer_path: relative_from.clone(),
                importer_absolute_path: normalize_path(&absolute_path.to_string_lossy()),
                imported_absolute_path,
                span: Some(DiagnosticSpan {
                    start: entry.start,
                    end: entry.end,
                }),
            });
        }
    }

    module_records
        .sort_by(|left, right| normalize_path(&left.path).cmp(&normalize_path(&right.path)));
    imports.sort_by(|left, right| {
        left.edge
            .from
            .cmp(&right.edge.from)
            .then_with(|| left.edge.specifier.cmp(&right.edge.specifier))
            .then_with(|| {
                left.edge
                    .to
                    .as_deref()
                    .unwrap_or("")
                    .cmp(right.edge.to.as_deref().unwrap_or(""))
            })
    });

    signal_records.sort_by(|left, right| {
        left.id
            .cmp(&right.id)
            .then_with(|| left.file.cmp(&right.file))
            .then_with(|| left.export_name.cmp(&right.export_name))
    });

    let mut seen_signal_ids = BTreeMap::new();
    for signal in &signal_records {
        if let Some(previous_file) = seen_signal_ids.insert(signal.id.clone(), signal.file.clone()) {
            diagnostics.push(create_diagnostic(
                "aruna::563",
                format!("Signal id {} is defined more than once.", signal.id),
                Some(signal.file.clone()),
                None,
                Some(format!(
                    "First defined in {}, then again in {}.",
                    previous_file, signal.file
                )),
                Some("Use globally unique signal ids such as domain.signalName.".to_string()),
            ));
        }
    }

    Ok(BuildGraphResult {
        modules: module_records,
        imports,
        actions: action_records,
        signals: signal_records,
        module_map,
        diagnostics,
    })
}
