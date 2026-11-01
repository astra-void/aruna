// `defineResource`: server-owned state clients observe (docs/rfcs/resources.md).

use crate::diagnostics::{create_diagnostic, ArunaDiagnostic, DiagnosticSpan};
use crate::files::project_relative;
use oxc_ast::ast::{Argument, CallExpression, Expression};
use oxc_span::GetSpan;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use super::*;
use crate::module_kind::ModuleKind;
use crate::schema_metadata::*;
use crate::spans::*;
use crate::static_literals::*;

// A resource discovered from `export const X = defineResource({...})`. The id is
// its identity on the wire and in the contract; the schema is what every
// snapshot the server sends is checked against.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArunaResourceRecord {
    pub id: String,
    pub file: String,
    pub export_name: String,
    // "player" (the default) or "global".
    pub scope: String,
    // Whether subscriptions go through an `authorize` check. Omitted when false.
    #[serde(default, skip_serializing_if = "is_false")]
    pub has_authorize: bool,
    pub serialization: ArunaActionSerializationMetadata,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<ArunaSchemaMetadata>,
}

#[derive(Clone, Debug, Default)]
pub struct ResourceDiscoveryResult {
    pub resources: Vec<ArunaResourceRecord>,
    pub resource_files: BTreeSet<String>,
    pub diagnostics: Vec<ArunaDiagnostic>,
}

fn invalid_definition(
    file: &str,
    message: String,
    span: DiagnosticSpan,
    details: String,
    suggestion: &str,
) -> ArunaDiagnostic {
    create_diagnostic(
        "aruna::586",
        message,
        Some(file.to_string()),
        Some(span),
        Some(details),
        Some(suggestion.to_string()),
    )
}

pub(crate) fn analyze_define_resource_call<'a>(
    file: &str,
    export_name: &str,
    call: &'a CallExpression<'a>,
    scope: &SchemaScope<'a>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<ArunaResourceRecord> {
    let Some(Argument::ObjectExpression(object)) = call.arguments.first() else {
        diagnostics.push(invalid_definition(
            file,
            format!("Resource {export_name} in {file} has an invalid defineResource definition."),
            call_span(call),
            "defineResource expects a single object literal with an id, a schema, and a load function.".to_string(),
            "Use defineResource({ id: \"domain.resource\", schema: schema.object({ ... }), load(ctx) { ... } }).",
        ));
        return None;
    };

    let Some(id_property) = find_object_property(object, "id") else {
        diagnostics.push(invalid_definition(
            file,
            format!("Resource {export_name} in {file} is missing an id."),
            object_span(object),
            "Resource ids are their identity on the wire and must be static string literals.".to_string(),
            "Add id: \"domain.resourceName\" to the defineResource object.",
        ));
        return None;
    };
    let Expression::StringLiteral(id_literal) = &id_property.value else {
        diagnostics.push(invalid_definition(
            file,
            format!("Resource {export_name} in {file} has an invalid id."),
            DiagnosticSpan {
                start: id_property.span.start as usize,
                end: id_property.span.end as usize,
            },
            "Resource ids must be static string literals: the build resolves them without running the project.".to_string(),
            "Use id: \"domain.resourceName\" with a literal string value.",
        ));
        return None;
    };
    let id = id_literal.value.to_string();

    let resource_scope = match find_object_property(object, "scope") {
        None => "player".to_string(),
        Some(property) => match &property.value {
            Expression::StringLiteral(literal)
                if literal.value.as_str() == "player" || literal.value.as_str() == "global" =>
            {
                literal.value.to_string()
            }
            _ => {
                diagnostics.push(invalid_definition(
                    file,
                    format!("Resource {id} has an invalid scope."),
                    DiagnosticSpan {
                        start: property.value.span().start as usize,
                        end: property.value.span().end as usize,
                    },
                    format!("export name: {export_name}\nscope must be the string literal \"player\" or \"global\"."),
                    "Set scope: \"player\" (one value per player, the default) or scope: \"global\" (one value for everyone).",
                ));
                return None;
            }
        },
    };

    let (has_schema, schema) = extract_action_schema(
        file,
        &id,
        export_name,
        SchemaRole::Resource,
        object,
        "schema",
        scope,
        diagnostics,
    );
    if !has_schema {
        diagnostics.push(create_diagnostic(
            "aruna::589",
            format!("Resource {id} has no schema."),
            Some(file.to_string()),
            Some(object_span(object)),
            Some(format!(
                "export name: {export_name}\nEvery snapshot is checked against the schema before it is sent, and the generated client type is built from it."
            )),
            Some("Add schema: schema.object({ ... }) to the defineResource object.".to_string()),
        ));
        return None;
    }

    let has_load = find_object_property(object, "load").is_some_and(has_valid_run_handler);
    if !has_load {
        diagnostics.push(invalid_definition(
            file,
            format!("Resource {id} has no load function."),
            object_span(object),
            format!("export name: {export_name}\nload(ctx) is the authoritative read the server runs on subscribe and on every invalidation."),
            "Add a load(ctx) function (it may be async) to the defineResource object.",
        ));
        return None;
    }

    let has_authorize = match find_object_property(object, "authorize") {
        None => false,
        Some(property) if has_valid_run_handler(property) => true,
        Some(property) => {
            diagnostics.push(invalid_definition(
                file,
                format!("Resource {id} has an authorize option that is not a function."),
                DiagnosticSpan {
                    start: property.span.start as usize,
                    end: property.span.end as usize,
                },
                format!("export name: {export_name}"),
                "Make authorize a function: authorize: (ctx) => boolean.",
            ));
            return None;
        }
    };

    Some(ArunaResourceRecord {
        id,
        file: file.to_string(),
        export_name: export_name.to_string(),
        scope: resource_scope,
        has_authorize,
        serialization: ArunaActionSerializationMetadata::default(),
        schema,
    })
}

pub struct ResourcePrimitive;

impl Primitive for ResourcePrimitive {
    type Record = ArunaResourceRecord;

    const NAME: &'static str = "resource";
    const CALLEES: &'static [&'static str] = &["defineResource"];
    // `load` reads server state, so a defining file is server code and the
    // client reaches a resource only through `$aruna/resources/client`.
    const DEFINING_MODULE: Option<DefiningModule> = Some(DefiningModule {
        kind: ModuleKind::Server,
        reason_detail: "defineResource(...) export detected",
    });
    const IN_CONTRACT: bool = true;

    fn analyze(
        site: &DefinitionSite<'_, '_>,
        diagnostics: &mut Vec<ArunaDiagnostic>,
    ) -> Option<Self::Record> {
        analyze_define_resource_call(site.file, site.export_name, site.call, site.schema_scope(), diagnostics)
    }

    fn sort_key(record: &Self::Record) -> (&str, &str, &str) {
        (&record.id, &record.file, &record.export_name)
    }

    fn finalize(
        mut records: Vec<Self::Record>,
        diagnostics: &mut Vec<ArunaDiagnostic>,
    ) -> Vec<Self::Record> {
        records.sort_by(|left, right| {
            Self::sort_key(left).cmp(&Self::sort_key(right))
        });
        let mut seen = BTreeMap::new();
        let mut kept = Vec::with_capacity(records.len());
        for resource in records {
            if let Some(previous_file) = seen.insert(resource.id.clone(), resource.file.clone()) {
                diagnostics.push(create_diagnostic(
                    "aruna::587",
                    format!("Resource id {} is defined more than once.", resource.id),
                    Some(resource.file.clone()),
                    None,
                    Some(format!(
                        "First defined in {}, then again in {}.",
                        previous_file, resource.file
                    )),
                    Some("Use globally unique resource ids such as domain.resourceName.".to_string()),
                ));
                continue;
            }
            kept.push(resource);
        }
        kept
    }
}

pub fn collect_resource_definitions(
    project_root: &Path,
    path: &Path,
    source_text: &str,
) -> Result<ResourceDiscoveryResult, String> {
    let found = collect_definitions::<ResourcePrimitive>(project_root, path, source_text)?;
    let mut resource_files = BTreeSet::new();
    if found.defines {
        resource_files.insert(project_relative(project_root, path));
    }
    Ok(ResourceDiscoveryResult {
        resources: found.records,
        resource_files,
        diagnostics: found.diagnostics,
    })
}
