use crate::diagnostics::{stable_sort_diagnostics, ArunaDiagnostic};
use crate::files::normalize_path;
use crate::graph::ArunaImportEdge;
use crate::module_kind::{ModuleKind, ModuleReason};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArunaModuleRecord {
    pub id: String,
    pub path: String,
    pub kind: ModuleKind,
    pub reason: ModuleReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_detail: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArunaManifest {
    pub version: u8,
    pub project_root: String,
    pub modules: Vec<ArunaModuleRecord>,
    pub imports: Vec<ArunaImportEdge>,
    pub diagnostics: Vec<ArunaDiagnostic>,
}

fn sort_modules(modules: &[ArunaModuleRecord]) -> Vec<ArunaModuleRecord> {
    let mut sorted = modules.to_vec();
    sorted.sort_by(|left, right| {
        normalize_path(&left.path)
            .cmp(&normalize_path(&right.path))
            .then_with(|| left.id.cmp(&right.id))
    });
    sorted
}

fn sort_imports(imports: &[ArunaImportEdge]) -> Vec<ArunaImportEdge> {
    let mut sorted = imports.to_vec();
    sorted.sort_by(|left, right| {
        left.from
            .cmp(&right.from)
            .then_with(|| left.specifier.cmp(&right.specifier))
            .then_with(|| {
                left.to
                    .as_deref()
                    .unwrap_or("")
                    .cmp(right.to.as_deref().unwrap_or(""))
            })
    });
    sorted
}

pub fn create_manifest(
    project_root: &str,
    modules: &[ArunaModuleRecord],
    imports: &[ArunaImportEdge],
    diagnostics: &[ArunaDiagnostic],
) -> ArunaManifest {
    ArunaManifest {
        version: 1,
        project_root: project_root.to_string(),
        modules: sort_modules(modules),
        imports: sort_imports(imports),
        diagnostics: stable_sort_diagnostics(diagnostics),
    }
}
