use crate::config::ArunaConfig;
use crate::diagnostics::{create_diagnostic, ArunaDiagnostic, DiagnosticSpan};
use crate::files::{normalize_path, project_relative};
use crate::manifest::ArunaModuleRecord;
use crate::module_kind::{classify_module, ModuleKind, ModuleReason};
use crate::parser::collect_static_imports;
use crate::resolver::{resolve_import_specifier, TsconfigResolverOptions};
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
        Some(format!("SWC parser error: {error}")),
        Some("Check the TypeScript/TSX syntax in this file.".to_string()),
    )
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
    let discovered_files: BTreeSet<String> = files
        .iter()
        .map(|path| project_relative(project_root, path))
        .collect();

    for absolute_path in files {
        let classification = classify_module(project_root, absolute_path, config);
        let relative_path = project_relative(project_root, absolute_path);
        let reason = if classification.matched_kinds.is_empty() {
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

    let mut imports = Vec::new();

    for absolute_path in files {
        let relative_from = project_relative(project_root, absolute_path);
        let importer_record = module_map.get(&relative_from);
        let source_text = fs::read_to_string(absolute_path).map_err(|error| error.to_string())?;
        let static_imports = match collect_static_imports(absolute_path, &source_text) {
            Ok(imports) => imports,
            Err(error) => {
                diagnostics.push(create_parse_failed_diagnostic(&relative_from, error));
                continue;
            }
        };

        for entry in static_imports {
            let resolved = resolve_import_specifier(
                project_root,
                absolute_path,
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

    Ok(BuildGraphResult {
        modules: module_records,
        imports,
        module_map,
        diagnostics,
    })
}
