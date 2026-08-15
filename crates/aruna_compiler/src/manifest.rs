use crate::diagnostics::{stable_sort_diagnostics, ArunaDiagnostic};
use crate::actions::{ArunaActionRecord, ArunaRuntimeRecord, ArunaSignalRecord, ArunaStoreRecord};
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
    pub actions: Vec<ArunaActionRecord>,
    // Omitted from JSON when empty so manifests without signals stay byte-stable
    // with pre-signal snapshots.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub signals: Vec<ArunaSignalRecord>,
    // Same treatment as signals: omitted when empty so a project without stores
    // produces the same manifest bytes it did before stores existed.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub stores: Vec<ArunaStoreRecord>,
    // Already in resolved boot order, so this is deliberately NOT re-sorted:
    // the order is the record. Omitted when empty, like signals and stores.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub runtimes: Vec<ArunaRuntimeRecord>,
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

fn sort_actions(actions: &[ArunaActionRecord]) -> Vec<ArunaActionRecord> {
    let mut sorted = actions.to_vec();
    sorted.sort_by(|left, right| {
        left.id
            .cmp(&right.id)
            .then_with(|| left.file.cmp(&right.file))
            .then_with(|| left.export_name.cmp(&right.export_name))
    });
    sorted
}

fn sort_stores(stores: &[ArunaStoreRecord]) -> Vec<ArunaStoreRecord> {
    let mut sorted = stores.to_vec();
    sorted.sort_by(|left, right| {
        left.id
            .cmp(&right.id)
            .then_with(|| left.file.cmp(&right.file))
            .then_with(|| left.export_name.cmp(&right.export_name))
    });
    sorted
}

fn sort_signals(signals: &[ArunaSignalRecord]) -> Vec<ArunaSignalRecord> {
    let mut sorted = signals.to_vec();
    sorted.sort_by(|left, right| {
        left.id
            .cmp(&right.id)
            .then_with(|| left.file.cmp(&right.file))
            .then_with(|| left.export_name.cmp(&right.export_name))
    });
    sorted
}

pub fn create_manifest(
    project_root: &str,
    modules: &[ArunaModuleRecord],
    imports: &[ArunaImportEdge],
    actions: &[ArunaActionRecord],
    signals: &[ArunaSignalRecord],
    stores: &[ArunaStoreRecord],
    runtimes: &[ArunaRuntimeRecord],
    diagnostics: &[ArunaDiagnostic],
) -> ArunaManifest {
    ArunaManifest {
        version: 1,
        project_root: project_root.to_string(),
        modules: sort_modules(modules),
        imports: sort_imports(imports),
        actions: sort_actions(actions),
        signals: sort_signals(signals),
        stores: sort_stores(stores),
        runtimes: runtimes.to_vec(),
        diagnostics: stable_sort_diagnostics(diagnostics),
    }
}
