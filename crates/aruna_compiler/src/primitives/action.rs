// `defineAction`: server actions the client invokes over the action remote.

use crate::diagnostics::{create_diagnostic, ArunaDiagnostic, DiagnosticSpan};
use crate::files::project_relative;
use oxc_ast::ast::{
    Argument, CallExpression, Expression, ObjectExpression, ObjectPropertyKind,
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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArunaActionRateLimitMetadata {
    pub key: String,
    pub window_ms: u32,
    pub max: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArunaActionRecord {
    pub id: String,
    pub file: String,
    pub export_name: String,
    pub has_input_schema: bool,
    pub has_output_schema: bool,
    pub has_run: bool,
    // A fire-and-forget action is one-way: the client does not wait for an ack
    // and the server skips the response, trading delivery confirmation for
    // throughput on high-frequency commands. Omitted from JSON when false so
    // pre-fire-and-forget manifest snapshots stay byte-stable.
    #[serde(default, skip_serializing_if = "is_false")]
    pub fire_and_forget: bool,
    // Declared safe to run twice. The generated client stub passes
    // `{ idempotent: true }`, which is what lets the default retry policy retry
    // a timeout. Omitted from JSON when false, like fire_and_forget.
    #[serde(default, skip_serializing_if = "is_false")]
    pub idempotent: bool,
    pub serialization: ArunaActionSerializationMetadata,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limit: Option<ArunaActionRateLimitMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<ArunaSchemaMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<ArunaSchemaMetadata>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ActionDiscoveryResult {
    pub actions: Vec<ArunaActionRecord>,
    pub action_files: BTreeSet<String>,
    pub diagnostics: Vec<ArunaDiagnostic>,
}

pub(crate) fn has_valid_run_handler(property: &oxc_ast::ast::ObjectProperty<'_>) -> bool {
    property.method || is_function_like(&property.value)
}

pub(crate) fn rate_limit_invalid_diagnostic(
    file: &str,
    action_id: &str,
    export_name: &str,
    span: DiagnosticSpan,
    details: String,
) -> ArunaDiagnostic {
    create_diagnostic(
        "aruna::560",
        format!("Server action {action_id} has an invalid rateLimit declaration."),
        Some(file.to_string()),
        Some(span),
        Some(format!("export name: {export_name}\n{details}")),
        Some(
            "Use rateLimit: { key: \"player\", windowMs: 1000, max: 5 } with positive integer literals."
                .to_string(),
        ),
    )
}

pub(crate) fn rate_limit_positive_integer_message(property_name: &str, compiler_discovery: bool) -> String {
    if compiler_discovery {
        format!(
            "rateLimit.{property_name} must be a positive integer numeric literal. The current compiler discovery path only reads literal values."
        )
    } else {
        format!("rateLimit.{property_name} must be a positive integer numeric literal.")
    }
}

pub(crate) fn parse_rate_limit_object(
    file: &str,
    action_id: &str,
    export_name: &str,
    object: &ObjectExpression<'_>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<ArunaActionRateLimitMetadata> {
    let mut key: Option<String> = None;
    let mut window_ms: Option<u32> = None;
    let mut max: Option<u32> = None;

    for property in &object.properties {
        let ObjectPropertyKind::ObjectProperty(object_property) = property else {
            diagnostics.push(rate_limit_invalid_diagnostic(
                file,
                action_id,
                export_name,
                DiagnosticSpan {
                    start: property.span().start as usize,
                    end: property.span().end as usize,
                },
                "rateLimit must be a plain object literal without spread properties.".to_string(),
            ));
            return None;
        };

        let Some(property_name) = property_name(&object_property.key) else {
            diagnostics.push(rate_limit_invalid_diagnostic(
                file,
                action_id,
                export_name,
                DiagnosticSpan {
                    start: object_property.span.start as usize,
                    end: object_property.span.end as usize,
                },
                "rateLimit keys must be static identifiers or string literals.".to_string(),
            ));
            return None;
        };

        match property_name.as_str() {
            "key" => match &object_property.value {
                Expression::StringLiteral(string_literal) => {
                    let key_value = string_literal.value.as_str();
                    if key_value != "player" && key_value != "global" {
                        diagnostics.push(rate_limit_invalid_diagnostic(
                            file,
                            action_id,
                            export_name,
                            DiagnosticSpan {
                                start: object_property.value.span().start as usize,
                                end: object_property.value.span().end as usize,
                            },
                            "rateLimit.key must be \"player\", \"global\", or a key function."
                                .to_string(),
                        ));
                        return None;
                    }

                    key = Some(key_value.to_string());
                }
                // A per-action custom key function `(info) => string`: recorded as
                // the "custom" sentinel for tooling (contract diff / inspect). The
                // function itself is applied at runtime and never serialized.
                Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => {
                    key = Some("custom".to_string());
                }
                _ => {
                    diagnostics.push(rate_limit_invalid_diagnostic(
                        file,
                        action_id,
                        export_name,
                        DiagnosticSpan {
                            start: object_property.value.span().start as usize,
                            end: object_property.value.span().end as usize,
                        },
                        "rateLimit.key must be \"player\", \"global\", or a key function."
                            .to_string(),
                    ));
                    return None;
                }
            },
            "windowMs" | "max" => {
                let Expression::NumericLiteral(numeric_literal) = &object_property.value else {
                    diagnostics.push(rate_limit_invalid_diagnostic(
                        file,
                        action_id,
                        export_name,
                        DiagnosticSpan {
                            start: object_property.value.span().start as usize,
                            end: object_property.value.span().end as usize,
                        },
                        rate_limit_positive_integer_message(&property_name, true),
                    ));
                    return None;
                };

                let Some(integer_value) = positive_integer_from_numeric_literal(numeric_literal.value) else {
                    diagnostics.push(rate_limit_invalid_diagnostic(
                        file,
                        action_id,
                        export_name,
                        DiagnosticSpan {
                            start: object_property.value.span().start as usize,
                            end: object_property.value.span().end as usize,
                        },
                        rate_limit_positive_integer_message(&property_name, false),
                    ));
                    return None;
                };

                if property_name == "windowMs" {
                    window_ms = Some(integer_value);
                } else {
                    max = Some(integer_value);
                }
            }
            _ => {
                let details = if property_name == "limit" {
                    "rateLimit.limit is not supported in the pre-public final API. Use max instead."
                        .to_string()
                } else {
                    format!("rateLimit does not support the {property_name} key.")
                };
                diagnostics.push(rate_limit_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    DiagnosticSpan {
                        start: object_property.span.start as usize,
                        end: object_property.span.end as usize,
                    },
                    details,
                ));
                return None;
            }
        }
    }

    let Some(key) = key else {
        diagnostics.push(rate_limit_invalid_diagnostic(
            file,
            action_id,
            export_name,
            object_span(object),
            "Missing rateLimit.key. Use \"player\", \"global\", or a key function.".to_string(),
        ));
        return None;
    };

    let Some(max) = max else {
        diagnostics.push(rate_limit_invalid_diagnostic(
            file,
            action_id,
            export_name,
            object_span(object),
            "Missing rateLimit.max.".to_string(),
        ));
        return None;
    };

    let Some(window_ms) = window_ms else {
        diagnostics.push(rate_limit_invalid_diagnostic(
            file,
            action_id,
            export_name,
            object_span(object),
            "Missing rateLimit.windowMs.".to_string(),
        ));
        return None;
    };

    Some(ArunaActionRateLimitMetadata {
        key,
        window_ms,
        max,
    })
}

pub(crate) fn extract_action_rate_limit(
    file: &str,
    action_id: &str,
    export_name: &str,
    object: &ObjectExpression<'_>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<ArunaActionRateLimitMetadata> {
    let Some(property) = find_object_property(object, "rateLimit") else {
        return None;
    };

    let Expression::ObjectExpression(rate_limit_object) = &property.value else {
        diagnostics.push(rate_limit_invalid_diagnostic(
            file,
            action_id,
            export_name,
            DiagnosticSpan {
                start: property.value.span().start as usize,
                end: property.value.span().end as usize,
            },
            "rateLimit must be a plain object literal.".to_string(),
        ));
        return None;
    };

    parse_rate_limit_object(file, action_id, export_name, rate_limit_object, diagnostics)
}

// Reads the optional `fireAndForget` flag off a defineAction object. Accepts a
// boolean literal (`true`/`false`); anything else is a hard error so a typo'd
// value can't silently leave an action request/response when the author meant it
// to be one-way.
pub(crate) fn extract_action_fire_and_forget(
    file: &str,
    action_id: &str,
    export_name: &str,
    object: &ObjectExpression<'_>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> bool {
    let Some(property) = find_object_property(object, "fireAndForget") else {
        return false;
    };

    match &property.value {
        Expression::BooleanLiteral(literal) => literal.value,
        _ => {
            diagnostics.push(create_diagnostic(
                "aruna::559",
                format!("Server action {action_id} has an invalid fireAndForget option."),
                Some(file.to_string()),
                Some(DiagnosticSpan {
                    start: property.value.span().start as usize,
                    end: property.value.span().end as usize,
                }),
                Some(format!("export name: {export_name}")),
                Some("Set fireAndForget to a boolean literal (true or false).".to_string()),
            ));
            false
        }
    }
}

// Reads the optional `idempotent` flag off a defineAction object. Accepts a
// boolean literal only: the flag decides whether a timed-out call may be sent
// again, so a value the compiler cannot read must not quietly become `false`
// (or `true`).
pub(crate) fn extract_action_idempotent(
    file: &str,
    action_id: &str,
    export_name: &str,
    object: &ObjectExpression<'_>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> bool {
    let Some(property) = find_object_property(object, "idempotent") else {
        return false;
    };

    match &property.value {
        Expression::BooleanLiteral(literal) => literal.value,
        _ => {
            diagnostics.push(create_diagnostic(
                "aruna::569",
                format!("Server action {action_id} has an invalid idempotent option."),
                Some(file.to_string()),
                Some(DiagnosticSpan {
                    start: property.value.span().start as usize,
                    end: property.value.span().end as usize,
                }),
                Some(format!("export name: {export_name}")),
                Some("Set idempotent to a boolean literal (true or false).".to_string()),
            ));
            false
        }
    }
}

pub(crate) fn analyze_define_action_call<'a>(
    file: &str,
    export_name: &str,
    call: &'a CallExpression<'a>,
    scope: &SchemaScope<'a>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<ArunaActionRecord> {
    let Some(first_argument) = call.arguments.first() else {
        diagnostics.push(create_diagnostic(
            "aruna::550",
            format!("Server action {export_name} in {file} has an invalid defineAction definition."),
            Some(file.to_string()),
            Some(call_span(call)),
            Some("defineAction expects a single object literal with at least an id and run handler.".to_string()),
            Some("Use defineAction({ id: \"domain.action\", run(ctx, input) { ... } }).".to_string()),
        ));
        return None;
    };

    let Argument::ObjectExpression(object) = first_argument else {
        diagnostics.push(create_diagnostic(
            "aruna::550",
            format!("Server action {export_name} in {file} has an invalid defineAction definition."),
            Some(file.to_string()),
            Some(call_span(call)),
            Some("defineAction expects an object literal as its first argument.".to_string()),
            Some("Use defineAction({ id: \"domain.action\", run(ctx, input) { ... } }).".to_string()),
        ));
        return None;
    };

    let Some(id_property) = find_object_property(object, "id") else {
        diagnostics.push(create_diagnostic(
            "aruna::550",
            format!("Server action {export_name} in {file} is missing an id."),
            Some(file.to_string()),
            Some(object_span(object)),
            Some("Action ids must be declared as a static string literal.".to_string()),
            Some("Add id: \"domain.actionName\" to the defineAction object.".to_string()),
        ));
        return None;
    };

    let Some(id) = (match &id_property.value {
        Expression::StringLiteral(literal) => Some(literal.value.to_string()),
        _ => None,
    }) else {
        diagnostics.push(create_diagnostic(
            "aruna::550",
            format!("Server action {export_name} in {file} has an invalid id."),
            Some(file.to_string()),
            Some(DiagnosticSpan {
                start: id_property.span.start as usize,
                end: id_property.span.end as usize,
            }),
            Some("Action ids must be static string literals.".to_string()),
            Some("Use id: \"domain.actionName\" with a literal string value.".to_string()),
        ));
        return None;
    };

    let (has_input_schema, input_schema) = extract_action_schema(
        file,
        &id,
        export_name,
        SchemaRole::Input,
        object,
        "input",
        scope,
        diagnostics,
    );
    let (has_output_schema, output_schema) = extract_action_schema(
        file,
        &id,
        export_name,
        SchemaRole::Output,
        object,
        "output",
        scope,
        diagnostics,
    );
    let rate_limit = extract_action_rate_limit(file, &id, export_name, object, diagnostics);
    let fire_and_forget =
        extract_action_fire_and_forget(file, &id, export_name, object, diagnostics);
    let idempotent = extract_action_idempotent(file, &id, export_name, object, diagnostics);

    let Some(run_property) = find_object_property(object, "run") else {
        diagnostics.push(create_diagnostic(
            "aruna::551",
            format!("Server action {id} is missing a run handler."),
            Some(file.to_string()),
            Some(object_span(object)),
            Some(format!("export name: {export_name}")),
            Some("Add a run(ctx, input) function to the defineAction object.".to_string()),
        ));
        return Some(ArunaActionRecord {
            id,
            file: file.to_string(),
            export_name: export_name.to_string(),
            has_input_schema,
            has_output_schema,
            has_run: false,
            fire_and_forget,
            idempotent,
            serialization: ArunaActionSerializationMetadata::default(),
            rate_limit,
            input_schema,
            output_schema,
        });
    };

    let has_run = has_valid_run_handler(run_property);
    if !has_run {
        diagnostics.push(create_diagnostic(
            "aruna::552",
            format!("Server action {id} has a run handler, but it is not a function."),
            Some(file.to_string()),
            Some(DiagnosticSpan {
                start: run_property.span.start as usize,
                end: run_property.span.end as usize,
            }),
            Some(format!("export name: {export_name}")),
            Some("Make run a function or async function.".to_string()),
        ));
    }

    Some(ArunaActionRecord {
        id,
        file: file.to_string(),
        export_name: export_name.to_string(),
        has_input_schema,
        has_output_schema,
        has_run,
        fire_and_forget,
        idempotent,
        serialization: ArunaActionSerializationMetadata::default(),
        rate_limit,
        input_schema,
        output_schema,
    })
}

pub struct ActionPrimitive;

impl Primitive for ActionPrimitive {
    type Record = ArunaActionRecord;

    const NAME: &'static str = "action";
    const CALLEES: &'static [&'static str] = &["defineAction"];
    const DEFINING_MODULE: Option<DefiningModule> = Some(DefiningModule {
        kind: ModuleKind::ServerAction,
        reason_detail: "defineAction(...) export detected",
    });
    const IN_CONTRACT: bool = true;

    fn analyze(
        site: &DefinitionSite<'_, '_>,
        diagnostics: &mut Vec<ArunaDiagnostic>,
    ) -> Option<Self::Record> {
        analyze_define_action_call(site.file, site.export_name, site.call, site.schema_scope(), diagnostics)
    }

    fn sort_key(record: &Self::Record) -> (&str, &str, &str) {
        (&record.id, &record.file, &record.export_name)
    }

    // A duplicated action id makes the generated registry ambiguous.
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

        let mut seen_action_ids = BTreeMap::new();
        for action in &records {
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
        records
    }
}

pub fn collect_action_definitions(
    project_root: &Path,
    path: &Path,
    source_text: &str,
) -> Result<ActionDiscoveryResult, String> {
    let found = collect_definitions::<ActionPrimitive>(project_root, path, source_text)?;
    let mut action_files = BTreeSet::new();
    if found.defines {
        action_files.insert(project_relative(project_root, path));
    }
    Ok(ActionDiscoveryResult {
        actions: found.records,
        action_files,
        diagnostics: found.diagnostics,
    })
}
