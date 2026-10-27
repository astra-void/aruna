// `defineStore` / `definePlayerStore`: persisted DataStore records.

use crate::diagnostics::{create_diagnostic, ArunaDiagnostic, DiagnosticSpan};
use crate::files::project_relative;
use oxc_ast::ast::{
    Argument, CallExpression, Expression, ObjectExpression,
};
use oxc_span::GetSpan;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use super::*;
use crate::module_kind::ModuleKind;
use crate::schema_metadata::*;
use crate::spans::*;
use crate::static_literals::*;

// Whether a store is a plain keyed store (`defineStore`) or a session-locked
// per-player document (`definePlayerStore`). The distinction is what tooling
// reports and what the boundary rules key off; both are server-only.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ArunaStoreKind {
    Store,
    PlayerStore,
}

// A persisted store discovered from `export const X = defineStore({...})` (or
// `definePlayerStore`). The id is the DataStore name, so it is recorded here and
// surfaced by `aruna inspect stores` without running the project's code.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArunaStoreRecord {
    pub id: String,
    pub file: String,
    pub export_name: String,
    pub kind: ArunaStoreKind,
    // The declared data version; defaults to 1 when omitted, matching the runtime.
    pub version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    // Whether a `migrate` was declared. A store at version > 1 without one cannot
    // read its own older records, which is worth reporting.
    #[serde(default, skip_serializing_if = "is_false")]
    pub has_migrate: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<ArunaSchemaMetadata>,
}

#[derive(Clone, Debug, Default)]
pub struct StoreDiscoveryResult {
    pub stores: Vec<ArunaStoreRecord>,
    pub store_files: BTreeSet<String>,
    pub diagnostics: Vec<ArunaDiagnostic>,
}

// Reads the optional numeric `version` off a store definition. Defaults to 1,
// matching `resolveStoreVersion` in both runtimes.
pub(crate) fn extract_store_version(
    file: &str,
    store_id: &str,
    export_name: &str,
    object: &ObjectExpression<'_>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> u32 {
    let Some(property) = find_object_property(object, "version") else {
        return 1;
    };

    match &property.value {
        Expression::NumericLiteral(literal)
            if literal.value >= 1.0 && literal.value.fract() == 0.0 =>
        {
            literal.value as u32
        }
        _ => {
            diagnostics.push(create_diagnostic(
                "aruna::575",
                format!("Store {store_id} in {file} has an invalid version."),
                Some(file.to_string()),
                Some(DiagnosticSpan {
                    start: property.value.span().start as usize,
                    end: property.value.span().end as usize,
                }),
                Some(format!("export name: {export_name}")),
                Some(
                    "Set version to a positive integer literal, and bump it when the stored shape changes."
                        .to_string(),
                ),
            ));
            1
        }
    }
}

pub(crate) fn extract_store_scope(object: &ObjectExpression<'_>) -> Option<String> {
    match &find_object_property(object, "scope")?.value {
        Expression::StringLiteral(literal) => Some(literal.value.to_string()),
        _ => None,
    }
}

pub(crate) fn analyze_define_store_call<'a>(
    file: &str,
    export_name: &str,
    kind: ArunaStoreKind,
    call: &'a CallExpression<'a>,
    scope: &SchemaScope<'a>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<ArunaStoreRecord> {
    let definer = match kind {
        ArunaStoreKind::Store => "defineStore",
        ArunaStoreKind::PlayerStore => "definePlayerStore",
    };

    let Some(Argument::ObjectExpression(object)) = call.arguments.first() else {
        diagnostics.push(create_diagnostic(
            "aruna::570",
            format!("Store {export_name} in {file} has an invalid {definer} definition."),
            Some(file.to_string()),
            Some(call_span(call)),
            Some(format!(
                "{definer} expects a single object literal with at least an id, a schema, and a defaultValue."
            )),
            Some(format!(
                "Use {definer}({{ id: \"domain.store\", schema: schema.object({{ ... }}), defaultValue: {{ ... }} }})."
            )),
        ));
        return None;
    };

    let Some(id_property) = find_object_property(object, "id") else {
        diagnostics.push(create_diagnostic(
            "aruna::570",
            format!("Store {export_name} in {file} is missing an id."),
            Some(file.to_string()),
            Some(object_span(object)),
            Some("Store ids are DataStore names and must be static string literals.".to_string()),
            Some("Add id: \"domain.storeName\" to the store definition.".to_string()),
        ));
        return None;
    };

    let Some(id) = (match &id_property.value {
        Expression::StringLiteral(literal) => Some(literal.value.to_string()),
        _ => None,
    }) else {
        diagnostics.push(create_diagnostic(
            "aruna::570",
            format!("Store {export_name} in {file} has an invalid id."),
            Some(file.to_string()),
            Some(DiagnosticSpan {
                start: id_property.span.start as usize,
                end: id_property.span.end as usize,
            }),
            Some("Store ids are DataStore names and must be static string literals.".to_string()),
            Some("Use id: \"domain.storeName\" with a literal string value.".to_string()),
        ));
        return None;
    };

    // The schema is what stops a corrupt record from reaching game code, so a
    // store without one is an error rather than a degraded-but-working store.
    let (has_schema, schema_metadata) = extract_action_schema(
        file,
        &id,
        export_name,
        SchemaRole::Store,
        object,
        "schema",
        scope,
        diagnostics,
    );
    if !has_schema {
        diagnostics.push(create_diagnostic(
            "aruna::571",
            format!("Store {id} in {file} is missing a schema."),
            Some(file.to_string()),
            Some(object_span(object)),
            Some(
                "A store validates every record it reads against its schema; without one a corrupt record would reach game code."
                    .to_string(),
            ),
            Some("Add schema: schema.object({ ... }) to the store definition.".to_string()),
        ));
        return None;
    }

    // Same reasoning for the default: it is what a never-written key resolves to,
    // and the runtime has nothing to fall back on without it.
    if find_object_property(object, "defaultValue").is_none() {
        diagnostics.push(create_diagnostic(
            "aruna::576",
            format!("Store {id} in {file} is missing a defaultValue."),
            Some(file.to_string()),
            Some(object_span(object)),
            Some("defaultValue is what a key that was never written resolves to.".to_string()),
            Some(
                "Add defaultValue: { ... } (or a factory returning it) to the store definition."
                    .to_string(),
            ),
        ));
        return None;
    }

    let version = extract_store_version(file, &id, export_name, object, diagnostics);
    let has_migrate = find_object_property(object, "migrate").is_some();

    // A bumped version with no migrate means every record written at the old
    // version fails to load — the store cannot read its own history.
    if version > 1 && !has_migrate {
        diagnostics.push(create_diagnostic(
            "aruna::577",
            format!("Store {id} in {file} is at version {version} but declares no migrate()."),
            Some(file.to_string()),
            Some(object_span(object)),
            Some(
                "Records written at an earlier version fail to load, and the runtime refuses to overwrite them."
                    .to_string(),
            ),
            Some("Add migrate: (stored, fromVersion) => ... to upgrade older records.".to_string()),
        ));
    }

    Some(ArunaStoreRecord {
        id,
        file: file.to_string(),
        export_name: export_name.to_string(),
        kind,
        version,
        scope: extract_store_scope(object),
        has_migrate,
        schema: schema_metadata,
    })
}

pub(crate) fn store_kind_for_callee(name: &str) -> Option<ArunaStoreKind> {
    match name {
        "defineStore" => Some(ArunaStoreKind::Store),
        "definePlayerStore" => Some(ArunaStoreKind::PlayerStore),
        _ => None,
    }
}

pub struct StorePrimitive;

impl Primitive for StorePrimitive {
    type Record = ArunaStoreRecord;

    const NAME: &'static str = "store";
    const CALLEES: &'static [&'static str] = &["defineStore", "definePlayerStore"];
    const DEFINING_MODULE: Option<DefiningModule> = Some(DefiningModule {
        kind: ModuleKind::ServerStore,
        reason_detail: "defineStore(...) export detected",
    });
    const IN_CONTRACT: bool = true;

    fn analyze(
        site: &DefinitionSite<'_, '_>,
        diagnostics: &mut Vec<ArunaDiagnostic>,
    ) -> Option<Self::Record> {
        let kind = store_kind_for_callee(site.callee)?;
        analyze_define_store_call(
            site.file,
            site.export_name,
            kind,
            site.call,
            site.schema_scope(),
            diagnostics,
        )
    }

    fn sort_key(record: &Self::Record) -> (&str, &str, &str) {
        (&record.id, &record.file, &record.export_name)
    }

    // A duplicated store id is two definitions pointed at the same DataStore
    // name, which is how two unrelated features end up overwriting each other's
    // records.
    fn finalize(
        mut records: Vec<Self::Record>,
        diagnostics: &mut Vec<ArunaDiagnostic>,
    ) -> Vec<Self::Record> {
        records.sort_by(|left, right| {
            left.id
                .cmp(&right.id)
                .then_with(|| left.file.cmp(&right.file))
                .then_with(|| left.export_name.cmp(&right.export_name))
        });

        let mut seen_store_ids = BTreeMap::new();
        for store in &records {
            if let Some(previous_file) = seen_store_ids.insert(store.id.clone(), store.file.clone()) {
                diagnostics.push(create_diagnostic(
                    "aruna::573",
                    format!("Store id {} is defined more than once.", store.id),
                    Some(store.file.clone()),
                    None,
                    Some(format!(
                        "First defined in {}, then again in {}. Both would read and write the same DataStore.",
                        previous_file, store.file
                    )),
                    Some("Use globally unique store ids such as domain.storeName.".to_string()),
                ));
            }
        }
        records
    }
}

pub fn collect_store_definitions(
    project_root: &Path,
    path: &Path,
    source_text: &str,
) -> Result<StoreDiscoveryResult, String> {
    let found = collect_definitions::<StorePrimitive>(project_root, path, source_text)?;
    let mut store_files = BTreeSet::new();
    if found.defines {
        store_files.insert(project_relative(project_root, path));
    }
    Ok(StoreDiscoveryResult {
        stores: found.records,
        store_files,
        diagnostics: found.diagnostics,
    })
}
