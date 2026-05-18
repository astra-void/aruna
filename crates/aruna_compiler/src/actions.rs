use crate::diagnostics::{create_diagnostic, ArunaDiagnostic, DiagnosticSpan};
use crate::files::project_relative;
use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, ArrayExpression, ArrayExpressionElement, BindingPattern, CallExpression,
    Declaration, Expression, ObjectExpression, ObjectPropertyKind, PropertyKey, Statement,
    VariableDeclarationKind,
};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArunaSchemaMetadata {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub properties: Option<BTreeMap<String, ArunaSchemaMetadata>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Box<ArunaSchemaMetadata>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inner: Option<Box<ArunaSchemaMetadata>>,
}

#[derive(Clone, Debug, Copy, PartialEq, Eq)]
enum SchemaRole {
    Input,
    Output,
}

impl SchemaRole {
    fn code(self) -> &'static str {
        match self {
            SchemaRole::Input => "aruna::553",
            SchemaRole::Output => "aruna::554",
        }
    }

    fn label(self) -> &'static str {
        match self {
            SchemaRole::Input => "input",
            SchemaRole::Output => "output",
        }
    }
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

fn source_type_for_path(path: &Path) -> Result<SourceType, String> {
    SourceType::from_path(path).map_err(|error| error.to_string())
}

fn call_span(call: &CallExpression<'_>) -> DiagnosticSpan {
    DiagnosticSpan {
        start: call.span.start as usize,
        end: call.span.end as usize,
    }
}

fn object_span(object: &ObjectExpression<'_>) -> DiagnosticSpan {
    DiagnosticSpan {
        start: object.span.start as usize,
        end: object.span.end as usize,
    }
}

fn property_name(key: &PropertyKey<'_>) -> Option<String> {
    match key {
        PropertyKey::StaticIdentifier(ident) => Some(ident.name.as_str().to_string()),
        PropertyKey::StringLiteral(literal) => Some(literal.value.to_string()),
        _ => None,
    }
}

fn is_function_like(expression: &Expression<'_>) -> bool {
    matches!(
        expression,
        Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_)
    )
}

fn has_valid_run_handler(property: &oxc_ast::ast::ObjectProperty<'_>) -> bool {
    property.method || is_function_like(&property.value)
}

fn schema_invalid_diagnostic(
    file: &str,
    action_id: &str,
    export_name: &str,
    role: SchemaRole,
    span: DiagnosticSpan,
    details: String,
) -> ArunaDiagnostic {
    create_diagnostic(
        role.code(),
        format!("Server action {action_id} has an invalid {} schema.", role.label()),
        Some(file.to_string()),
        Some(span),
        Some(format!("export name: {export_name}\n{details}")),
        Some(
            "Use schema.string(), schema.number(), schema.boolean(), schema.literal(...), schema.array(...), schema.object({...}), schema.optional(...), or schema.enum([...])."
                .to_string(),
        ),
    )
}

fn schema_span_from_expression(expression: &Expression<'_>) -> DiagnosticSpan {
    DiagnosticSpan {
        start: expression.span().start as usize,
        end: expression.span().end as usize,
    }
}

fn unwrap_schema_expression<'a>(expression: &'a Expression<'a>) -> &'a Expression<'a> {
    match expression {
        Expression::ParenthesizedExpression(parenthesized) => {
            unwrap_schema_expression(&parenthesized.expression)
        }
        Expression::TSAsExpression(expr) => unwrap_schema_expression(&expr.expression),
        Expression::TSSatisfiesExpression(expr) => unwrap_schema_expression(&expr.expression),
        Expression::TSNonNullExpression(expr) => unwrap_schema_expression(&expr.expression),
        Expression::TSTypeAssertion(expr) => unwrap_schema_expression(&expr.expression),
        Expression::TSInstantiationExpression(expr) => unwrap_schema_expression(&expr.expression),
        Expression::ChainExpression(expr) => match &expr.expression {
            oxc_ast::ast::ChainElement::CallExpression(call) => {
                unwrap_schema_expression(&call.callee)
            }
            oxc_ast::ast::ChainElement::ComputedMemberExpression(member) => {
                unwrap_schema_expression(&member.object)
            }
            oxc_ast::ast::ChainElement::StaticMemberExpression(member) => {
                unwrap_schema_expression(&member.object)
            }
            oxc_ast::ast::ChainElement::PrivateFieldExpression(member) => {
                unwrap_schema_expression(&member.object)
            }
            oxc_ast::ast::ChainElement::TSNonNullExpression(expr) => {
                unwrap_schema_expression(&expr.expression)
            }
        },
        _ => expression,
    }
}

fn literal_value_from_argument(argument: &Argument<'_>) -> Option<String> {
    match argument {
        Argument::StringLiteral(literal) => Some(literal.value.to_string()),
        Argument::NumericLiteral(literal) => Some(literal.value.to_string()),
        Argument::BooleanLiteral(literal) => Some(literal.value.to_string()),
        Argument::NullLiteral(_) => Some("null".to_string()),
        _ => None,
    }
}

fn literal_value_from_array_element(element: &ArrayExpressionElement<'_>) -> Option<String> {
    match element {
        ArrayExpressionElement::StringLiteral(literal) => Some(literal.value.to_string()),
        ArrayExpressionElement::NumericLiteral(literal) => Some(literal.value.to_string()),
        ArrayExpressionElement::BooleanLiteral(literal) => Some(literal.value.to_string()),
        ArrayExpressionElement::NullLiteral(_) => Some("null".to_string()),
        _ => None,
    }
}

fn parse_schema_expression(
    file: &str,
    action_id: &str,
    export_name: &str,
    role: SchemaRole,
    expression: &Expression<'_>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<ArunaSchemaMetadata> {
    match unwrap_schema_expression(expression) {
        Expression::CallExpression(call) => parse_schema_call(
            file,
            action_id,
            export_name,
            role,
            call,
            diagnostics,
        ),
        _ => {
            diagnostics.push(schema_invalid_diagnostic(
                file,
                action_id,
                export_name,
                role,
                schema_span_from_expression(expression),
                "The schema expression must be a call such as schema.string() or schema.object({...})."
                    .to_string(),
            ));
            None
        }
    }
}

fn parse_schema_argument(
    file: &str,
    action_id: &str,
    export_name: &str,
    role: SchemaRole,
    argument: &Argument<'_>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<ArunaSchemaMetadata> {
    match argument {
        Argument::CallExpression(call) => parse_schema_call(
            file,
            action_id,
            export_name,
            role,
            call,
            diagnostics,
        ),
        Argument::SpreadElement(_) => {
            diagnostics.push(schema_invalid_diagnostic(
                file,
                action_id,
                export_name,
                role,
                DiagnosticSpan {
                    start: argument.span().start as usize,
                    end: argument.span().end as usize,
                },
                "Spread arguments are not valid schema expressions.".to_string(),
            ));
            None
        }
        _ => {
            diagnostics.push(schema_invalid_diagnostic(
                file,
                action_id,
                export_name,
                role,
                DiagnosticSpan {
                    start: argument.span().start as usize,
                    end: argument.span().end as usize,
                },
                "The schema argument must be a schema call such as schema.string().".to_string(),
            ));
            None
        }
    }
}

fn parse_schema_array_values(
    file: &str,
    action_id: &str,
    export_name: &str,
    role: SchemaRole,
    array: &ArrayExpression<'_>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<Vec<String>> {
    let mut values = Vec::new();

    for element in &array.elements {
        let value = match element {
            ArrayExpressionElement::SpreadElement(_) | ArrayExpressionElement::Elision(_) => {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: element.span().start as usize,
                        end: element.span().end as usize,
                    },
                    "Enum values must be a flat array of literal values.".to_string(),
                ));
                return None;
            }
            _ => match literal_value_from_array_element(element) {
                Some(value) => value,
                None => {
                    diagnostics.push(schema_invalid_diagnostic(
                        file,
                        action_id,
                        export_name,
                        role,
                        DiagnosticSpan {
                            start: element.span().start as usize,
                            end: element.span().end as usize,
                        },
                        "Enum values must be literal values such as strings, numbers, booleans, or null."
                            .to_string(),
                    ));
                    return None;
                }
            },
        };
        values.push(value);
    }

    Some(values)
}

fn parse_schema_object(
    file: &str,
    action_id: &str,
    export_name: &str,
    role: SchemaRole,
    object: &ObjectExpression<'_>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<ArunaSchemaMetadata> {
    let mut properties = BTreeMap::new();

    for property in &object.properties {
        let ObjectPropertyKind::ObjectProperty(object_property) = property else {
            diagnostics.push(schema_invalid_diagnostic(
                file,
                action_id,
                export_name,
                role,
                DiagnosticSpan {
                    start: property.span().start as usize,
                    end: property.span().end as usize,
                },
                "Object schemas cannot use spread properties.".to_string(),
            ));
            return None;
        };

        let Some(name) = (match &object_property.key {
            PropertyKey::StaticIdentifier(ident) => Some(ident.name.as_str().to_string()),
            PropertyKey::StringLiteral(literal) => Some(literal.value.to_string()),
            _ => None,
        }) else {
            diagnostics.push(schema_invalid_diagnostic(
                file,
                action_id,
                export_name,
                role,
                DiagnosticSpan {
                    start: object_property.span.start as usize,
                    end: object_property.span.end as usize,
                },
                "Object schema keys must be static identifiers or string literals.".to_string(),
            ));
            return None;
        };

        let Some(child) = parse_schema_expression(
            file,
            action_id,
            export_name,
            role,
            &object_property.value,
            diagnostics,
        ) else {
            return None;
        };

        properties.insert(name, child);
    }

    Some(ArunaSchemaMetadata {
        kind: "object".to_string(),
        properties: Some(properties),
        items: None,
        value: None,
        values: None,
        inner: None,
    })
}

fn parse_schema_call(
    file: &str,
    action_id: &str,
    export_name: &str,
    role: SchemaRole,
    call: &CallExpression<'_>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<ArunaSchemaMetadata> {
    let Expression::StaticMemberExpression(member) = unwrap_schema_expression(&call.callee) else {
        diagnostics.push(schema_invalid_diagnostic(
            file,
            action_id,
            export_name,
            role,
            DiagnosticSpan {
                start: call.span.start as usize,
                end: call.span.end as usize,
            },
            "Schema calls must use the schema.<name>() form.".to_string(),
        ));
        return None;
    };

    let Expression::Identifier(object) = &member.object else {
        diagnostics.push(schema_invalid_diagnostic(
            file,
            action_id,
            export_name,
            role,
            DiagnosticSpan {
                start: call.span.start as usize,
                end: call.span.end as usize,
            },
            "Schema calls must be invoked from the schema namespace.".to_string(),
        ));
        return None;
    };

    if object.name.as_str() != "schema" {
        diagnostics.push(schema_invalid_diagnostic(
            file,
            action_id,
            export_name,
            role,
            DiagnosticSpan {
                start: call.span.start as usize,
                end: call.span.end as usize,
            },
            "Schema calls must be invoked from the schema namespace.".to_string(),
        ));
        return None;
    }

    let kind = member.property.name.as_str();
    match kind {
        "string" | "number" | "boolean" => {
            if !call.arguments.is_empty() {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    format!("{kind} schemas do not accept arguments."),
                ));
                return None;
            }

            Some(ArunaSchemaMetadata {
                kind: kind.to_string(),
                properties: None,
                items: None,
                value: None,
                values: None,
                inner: None,
            })
        }
        "literal" => {
            let Some(argument) = call.arguments.first() else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "literal schemas require exactly one literal argument.".to_string(),
                ));
                return None;
            };

            if call.arguments.len() != 1 {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "literal schemas require exactly one literal argument.".to_string(),
                ));
                return None;
            }

            let Some(value) = literal_value_from_argument(argument) else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: argument.span().start as usize,
                        end: argument.span().end as usize,
                    },
                    "literal schemas only accept string, number, boolean, or null values."
                        .to_string(),
                ));
                return None;
            };

            Some(ArunaSchemaMetadata {
                kind: kind.to_string(),
                properties: None,
                items: None,
                value: Some(value),
                values: None,
                inner: None,
            })
        }
        "array" => {
            let Some(argument) = call.arguments.first() else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "array schemas require exactly one schema argument.".to_string(),
                ));
                return None;
            };

            if call.arguments.len() != 1 {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "array schemas require exactly one schema argument.".to_string(),
                ));
                return None;
            }

            let Some(items) = parse_schema_argument(
                file,
                action_id,
                export_name,
                role,
                argument,
                diagnostics,
            ) else {
                return None;
            };

            Some(ArunaSchemaMetadata {
                kind: kind.to_string(),
                properties: None,
                items: Some(Box::new(items)),
                value: None,
                values: None,
                inner: None,
            })
        }
        "object" => {
            let Some(argument) = call.arguments.first() else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "object schemas require exactly one object literal argument.".to_string(),
                ));
                return None;
            };

            if call.arguments.len() != 1 {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "object schemas require exactly one object literal argument.".to_string(),
                ));
                return None;
            }

            let Argument::ObjectExpression(object) = argument else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: argument.span().start as usize,
                        end: argument.span().end as usize,
                    },
                    "object schemas require a plain object literal argument.".to_string(),
                ));
                return None;
            };

            parse_schema_object(file, action_id, export_name, role, object, diagnostics)
        }
        "optional" => {
            let Some(argument) = call.arguments.first() else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "optional schemas require exactly one schema argument.".to_string(),
                ));
                return None;
            };

            if call.arguments.len() != 1 {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "optional schemas require exactly one schema argument.".to_string(),
                ));
                return None;
            }

            let Some(inner) = parse_schema_argument(
                file,
                action_id,
                export_name,
                role,
                argument,
                diagnostics,
            ) else {
                return None;
            };

            Some(ArunaSchemaMetadata {
                kind: kind.to_string(),
                properties: None,
                items: None,
                value: None,
                values: None,
                inner: Some(Box::new(inner)),
            })
        }
        "enum" => {
            let Some(argument) = call.arguments.first() else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "enum schemas require exactly one array literal argument.".to_string(),
                ));
                return None;
            };

            if call.arguments.len() != 1 {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "enum schemas require exactly one array literal argument.".to_string(),
                ));
                return None;
            }

            let Argument::ArrayExpression(array) = argument else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: argument.span().start as usize,
                        end: argument.span().end as usize,
                    },
                    "enum schemas require an array literal of schema.literal(...) values."
                        .to_string(),
                ));
                return None;
            };

            let Some(values) = parse_schema_array_values(
                file,
                action_id,
                export_name,
                role,
                array,
                diagnostics,
            ) else {
                return None;
            };

            Some(ArunaSchemaMetadata {
                kind: kind.to_string(),
                properties: None,
                items: None,
                value: None,
                values: Some(values),
                inner: None,
            })
        }
        _ => {
            diagnostics.push(schema_invalid_diagnostic(
                file,
                action_id,
                export_name,
                role,
                DiagnosticSpan {
                    start: call.span.start as usize,
                    end: call.span.end as usize,
                },
                format!("Unsupported schema helper: schema.{kind}()"),
            ));
            None
        }
    }
}

fn extract_action_schema(
    file: &str,
    action_id: &str,
    export_name: &str,
    role: SchemaRole,
    object: &ObjectExpression<'_>,
    property_name: &str,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> (bool, Option<ArunaSchemaMetadata>) {
    let Some(property) = find_object_property(object, property_name) else {
        return (false, None);
    };

    (
        true,
        parse_schema_expression(
            file,
            action_id,
            export_name,
            role,
            &property.value,
            diagnostics,
        ),
    )
}

fn find_object_property<'a>(
    object: &'a ObjectExpression<'a>,
    name: &str,
) -> Option<&'a oxc_ast::ast::ObjectProperty<'a>> {
    object.properties.iter().find_map(|property| match property {
        ObjectPropertyKind::ObjectProperty(object_property) => {
            property_name(&object_property.key).and_then(|property_name| {
                if property_name == name {
                    Some(object_property.as_ref())
                } else {
                    None
                }
            })
        }
        ObjectPropertyKind::SpreadProperty(_) => None,
    })
}

fn analyze_define_action_call(
    file: &str,
    export_name: &str,
    call: &CallExpression<'_>,
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
        diagnostics,
    );
    let (has_output_schema, output_schema) = extract_action_schema(
        file,
        &id,
        export_name,
        SchemaRole::Output,
        object,
        "output",
        diagnostics,
    );

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
        input_schema,
        output_schema,
    })
}

fn collect_action_candidates(
    file: &str,
    program: &oxc_ast::ast::Program<'_>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> (Vec<ArunaActionRecord>, bool) {
    let mut actions = Vec::new();
    let mut saw_define_action = false;

    for statement in &program.body {
        let Statement::ExportNamedDeclaration(export_decl) = statement else {
            continue;
        };

        let Some(Declaration::VariableDeclaration(variable_decl)) = &export_decl.declaration else {
            continue;
        };

        if variable_decl.kind != VariableDeclarationKind::Const {
            continue;
        }

        for declarator in &variable_decl.declarations {
            let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
                continue;
            };

            let Some(Expression::CallExpression(call)) = declarator.init.as_ref() else {
                continue;
            };

            let Expression::Identifier(callee) = &call.callee else {
                continue;
            };

            if callee.name.as_str() != "defineAction" {
                continue;
            }

            saw_define_action = true;

            let Some(candidate) = analyze_define_action_call(
                file,
                binding.name.as_str(),
                call,
                diagnostics,
            ) else {
                continue;
            };
            actions.push(candidate);
        }
    }

    (actions, saw_define_action)
}

pub fn collect_action_definitions(
    project_root: &Path,
    path: &Path,
    source_text: &str,
) -> Result<ActionDiscoveryResult, String> {
    let file = project_relative(project_root, path);
    let allocator = Allocator::default();
    let source_type = source_type_for_path(path)?;
    let parser_return = Parser::new(&allocator, source_text, source_type).parse();

    if parser_return.panicked || !parser_return.errors.is_empty() {
        let errors = parser_return
            .errors
            .into_iter()
            .map(|error| error.to_string())
            .collect::<Vec<_>>();
        return Err(if errors.is_empty() {
            "Oxc parser panicked without reporting a recoverable error.".to_string()
        } else {
            errors.join("\n")
        });
    }

    let mut diagnostics = Vec::new();
    let (mut actions, saw_define_action) =
        collect_action_candidates(&file, &parser_return.program, &mut diagnostics);
    let mut action_files = BTreeSet::new();

    if saw_define_action {
        action_files.insert(file.clone());
    }

    actions.sort_by(|left, right| {
        left.id
            .cmp(&right.id)
            .then_with(|| left.file.cmp(&right.file))
            .then_with(|| left.export_name.cmp(&right.export_name))
    });

    Ok(ActionDiscoveryResult {
        actions,
        action_files,
        diagnostics,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use tempfile::TempDir;

    fn write_file(root: &Path, relative: &str, contents: &str) -> std::path::PathBuf {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, contents).unwrap();
        path
    }

    fn collect_single_action(source: &str) -> (ArunaActionRecord, Vec<ArunaDiagnostic>) {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        let path = write_file(root, "src/action.ts", source);

        let result = collect_action_definitions(root, &path, &std::fs::read_to_string(&path).unwrap())
            .unwrap();

        assert_eq!(result.actions.len(), 1);
        (result.actions[0].clone(), result.diagnostics)
    }

    fn schema(kind: &str) -> ArunaSchemaMetadata {
        ArunaSchemaMetadata {
            kind: kind.to_string(),
            properties: None,
            items: None,
            value: None,
            values: None,
            inner: None,
        }
    }

    fn object_schema(properties: &[(&str, ArunaSchemaMetadata)]) -> ArunaSchemaMetadata {
        ArunaSchemaMetadata {
            kind: "object".to_string(),
            properties: Some(
                properties
                    .iter()
                    .map(|(key, value)| (key.to_string(), value.clone()))
                    .collect::<BTreeMap<_, _>>(),
            ),
            items: None,
            value: None,
            values: None,
            inner: None,
        }
    }

    #[test]
    fn collects_define_action_with_method_run_handler() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        let path = write_file(
            root,
            "src/action.ts",
            r#"
import { defineAction } from "aruna/server";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  async run(ctx, input) {
    return { ok: true };
  },
});
"#,
        );

        let result = collect_action_definitions(root, &path, &std::fs::read_to_string(&path).unwrap())
            .unwrap();

        assert_eq!(result.actions.len(), 1);
        assert!(result.diagnostics.is_empty());
        assert_eq!(result.actions[0].has_run, true);
        assert_eq!(result.actions[0].id, "shop.purchaseItem");
    }

    #[test]
    fn collects_define_action_with_arrow_run_handler_property() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        let path = write_file(
            root,
            "src/action.ts",
            r#"
import { defineAction } from "aruna/server";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  run: async (ctx, input) => {
    return { ok: true };
  },
});
"#,
        );

        let result = collect_action_definitions(root, &path, &std::fs::read_to_string(&path).unwrap())
            .unwrap();

        assert_eq!(result.actions.len(), 1);
        assert!(result.diagnostics.is_empty());
        assert_eq!(result.actions[0].has_run, true);
        assert_eq!(result.actions[0].id, "shop.purchaseItem");
    }

    #[test]
    fn extracts_string_schema_metadata() {
        let (action, diagnostics) = collect_single_action(
            r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: schema.string(),
  output: schema.boolean(),
  run(ctx, input) {
    return true;
  },
});
"#,
        );

        assert!(diagnostics.is_empty());
        assert!(action.has_input_schema);
        assert!(action.has_output_schema);
        assert_eq!(action.input_schema, Some(schema("string")));
        assert_eq!(action.output_schema, Some(schema("boolean")));
    }

    #[test]
    fn extracts_number_and_boolean_schema_metadata() {
        let (action, diagnostics) = collect_single_action(
            r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: schema.number(),
  output: schema.boolean(),
  run(ctx, input) {
    return true;
  },
});
"#,
        );

        assert!(diagnostics.is_empty());
        assert_eq!(action.input_schema, Some(schema("number")));
        assert_eq!(action.output_schema, Some(schema("boolean")));
    }

    #[test]
    fn extracts_array_schema_metadata() {
        let (action, diagnostics) = collect_single_action(
            r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: schema.array(schema.string()),
  run(ctx, input) {
    return input;
  },
});
"#,
        );

        assert!(diagnostics.is_empty());
        assert!(action.has_input_schema);
        assert_eq!(
            action.input_schema,
            Some(ArunaSchemaMetadata {
                kind: "array".to_string(),
                properties: None,
                items: Some(Box::new(schema("string"))),
                value: None,
                values: None,
                inner: None,
            })
        );
    }

    #[test]
    fn extracts_object_schema_metadata() {
        let (action, diagnostics) = collect_single_action(
            r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: schema.object({
    itemId: schema.string(),
  }),
  run(ctx, input) {
    return input;
  },
});
"#,
        );

        assert!(diagnostics.is_empty());
        assert_eq!(
            action.input_schema,
            Some(object_schema(&[("itemId", schema("string"))]))
        );
    }

    #[test]
    fn reports_unsupported_schema_expressions() {
        let (action, diagnostics) = collect_single_action(
            r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

function getSchema() {
  return schema.string();
}

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: schema.array(getSchema()),
  run(ctx, input) {
    return input;
  },
});
"#,
        );

        assert!(action.input_schema.is_none());
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].code, "aruna::553");
        assert_eq!(diagnostics[0].name, "action-input-schema-invalid");
        assert_eq!(diagnostics[0].severity, crate::diagnostics::DiagnosticSeverity::Warning);
        assert!(diagnostics[0].message.contains("invalid input schema"));
    }
}
