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
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ArunaSerializationPolicy {
    PlainDataV1,
}

impl Default for ArunaSerializationPolicy {
    fn default() -> Self {
        Self::PlainDataV1
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArunaActionSerializationMetadata {
    pub policy: ArunaSerializationPolicy,
}

impl Default for ArunaActionSerializationMetadata {
    fn default() -> Self {
        Self {
            policy: ArunaSerializationPolicy::default(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArunaActionRateLimitMetadata {
    pub key: String,
    pub window_ms: u32,
    pub max: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ArunaSchemaLiteralMetadata {
    String { value: String },
    Number { value: String },
    Boolean { value: bool },
    Undefined,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArunaSchemaMetadata {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub numeric_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub properties: Option<BTreeMap<String, ArunaSchemaMetadata>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Box<ArunaSchemaMetadata>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub literal: Option<ArunaSchemaLiteralMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<ArunaSchemaLiteralMetadata>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inner: Option<Box<ArunaSchemaMetadata>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<ArunaSchemaMetadata>>,
}

#[derive(Clone, Debug, Copy, PartialEq, Eq)]
enum SchemaRole {
    Input,
    Output,
    Payload,
}

impl SchemaRole {
    fn code(self) -> &'static str {
        match self {
            SchemaRole::Input => "aruna::553",
            SchemaRole::Output => "aruna::554",
            SchemaRole::Payload => "aruna::564",
        }
    }

    fn label(self) -> &'static str {
        match self {
            SchemaRole::Input => "input",
            SchemaRole::Output => "output",
            SchemaRole::Payload => "payload",
        }
    }
}

// serde predicate: skip serializing boolean fields that are false so manifests
// without the field stay byte-identical to pre-feature snapshots.
fn is_false(value: &bool) -> bool {
    !*value
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

// A server -> client signal discovered from `export const X = defineSignal({...})`.
// Signals are the push counterpart to actions: an id plus an optional payload
// schema, no run handler and no response.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArunaSignalRecord {
    pub id: String,
    pub file: String,
    pub export_name: String,
    pub has_payload_schema: bool,
    pub serialization: ArunaActionSerializationMetadata,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_schema: Option<ArunaSchemaMetadata>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SignalDiscoveryResult {
    pub signals: Vec<ArunaSignalRecord>,
    pub signal_files: BTreeSet<String>,
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
            "Use schema.string(), schema.number(), schema.boolean(), schema.literal(...), schema.array(...), schema.object({...}), schema.optional(...), schema.record(...), schema.tuple([...]), schema.enum([...]), schema.union([...]), or a Roblox userdata schema (vector3/color3/cframe)."
                .to_string(),
        ),
    )
}

fn rate_limit_invalid_diagnostic(
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

fn rate_limit_positive_integer_message(property_name: &str, compiler_discovery: bool) -> String {
    if compiler_discovery {
        format!(
            "rateLimit.{property_name} must be a positive integer numeric literal. The current compiler discovery path only reads literal values."
        )
    } else {
        format!("rateLimit.{property_name} must be a positive integer numeric literal.")
    }
}

fn schema_span_from_expression(expression: &Expression<'_>) -> DiagnosticSpan {
    DiagnosticSpan {
        start: expression.span().start as usize,
        end: expression.span().end as usize,
    }
}

/// Module-level `const NAME = <schema expr>` bindings within a single file.
/// Lets a schema extracted to a variable resolve to the same metadata as if it
/// were written inline, instead of being rejected as a non-call expression.
type SchemaEnv<'a> = HashMap<&'a str, &'a Expression<'a>>;

fn collect_schema_bindings<'a>(program: &'a oxc_ast::ast::Program<'a>) -> SchemaEnv<'a> {
    let mut env: SchemaEnv<'a> = HashMap::new();

    for statement in &program.body {
        let variable_decl = match statement {
            Statement::VariableDeclaration(decl) => decl,
            Statement::ExportNamedDeclaration(export_decl) => {
                match &export_decl.declaration {
                    Some(Declaration::VariableDeclaration(decl)) => decl,
                    _ => continue,
                }
            }
            _ => continue,
        };

        if variable_decl.kind != VariableDeclarationKind::Const {
            continue;
        }

        for declarator in &variable_decl.declarations {
            let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
                continue;
            };
            let Some(init) = declarator.init.as_ref() else {
                continue;
            };
            // A later binding with the same name shadows an earlier one, matching
            // how the value would resolve at runtime.
            env.insert(binding.name.as_str(), init);
        }
    }

    env
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

fn literal_metadata_from_argument(argument: &Argument<'_>) -> Option<ArunaSchemaLiteralMetadata> {
    match argument {
        Argument::StringLiteral(literal) => Some(ArunaSchemaLiteralMetadata::String {
            value: literal.value.to_string(),
        }),
        Argument::NumericLiteral(literal) => Some(ArunaSchemaLiteralMetadata::Number {
            value: literal.value.to_string(),
        }),
        Argument::BooleanLiteral(literal) => Some(ArunaSchemaLiteralMetadata::Boolean {
            value: literal.value,
        }),
        Argument::Identifier(identifier) if identifier.name.as_str() == "undefined" => {
            Some(ArunaSchemaLiteralMetadata::Undefined)
        }
        _ => None,
    }
}

fn literal_metadata_from_array_element(
    element: &ArrayExpressionElement<'_>,
) -> Option<ArunaSchemaLiteralMetadata> {
    match element {
        ArrayExpressionElement::StringLiteral(literal) => Some(ArunaSchemaLiteralMetadata::String {
            value: literal.value.to_string(),
        }),
        ArrayExpressionElement::NumericLiteral(literal) => Some(ArunaSchemaLiteralMetadata::Number {
            value: literal.value.to_string(),
        }),
        ArrayExpressionElement::BooleanLiteral(literal) => Some(ArunaSchemaLiteralMetadata::Boolean {
            value: literal.value,
        }),
        ArrayExpressionElement::Identifier(identifier) if identifier.name.as_str() == "undefined" => {
            Some(ArunaSchemaLiteralMetadata::Undefined)
        }
        _ => None,
    }
}

fn parse_schema_expression<'a>(
    file: &str,
    action_id: &str,
    export_name: &str,
    role: SchemaRole,
    expression: &'a Expression<'a>,
    env: &SchemaEnv<'a>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<ArunaSchemaMetadata> {
    let mut current = unwrap_schema_expression(expression);
    // Follow `const a = b; const b = schema.string()` chains, guarding against a
    // binding that refers (directly or transitively) back to itself.
    let mut seen: Vec<&'a str> = Vec::new();

    loop {
        match current {
            Expression::CallExpression(call) => {
                return parse_schema_call(file, action_id, export_name, role, call, env, diagnostics);
            }
            Expression::Identifier(identifier) => {
                let name = identifier.name.as_str();

                let Some(resolved) = env.get(name).copied() else {
                    diagnostics.push(schema_invalid_diagnostic(
                        file,
                        action_id,
                        export_name,
                        role,
                        schema_span_from_expression(current),
                        format!(
                            "The schema variable `{name}` could not be resolved. Declare it as a module-level `const` schema in the same file."
                        ),
                    ));
                    return None;
                };

                if seen.contains(&name) {
                    diagnostics.push(schema_invalid_diagnostic(
                        file,
                        action_id,
                        export_name,
                        role,
                        schema_span_from_expression(current),
                        format!("The schema variable `{name}` refers to itself."),
                    ));
                    return None;
                }

                seen.push(name);
                current = unwrap_schema_expression(resolved);
            }
            _ => {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    schema_span_from_expression(current),
                    "The schema expression must be a call such as schema.string() or schema.object({...})."
                        .to_string(),
                ));
                return None;
            }
        }
    }
}

fn parse_schema_union_members<'a>(
    file: &str,
    action_id: &str,
    export_name: &str,
    role: SchemaRole,
    array: &'a ArrayExpression<'a>,
    env: &SchemaEnv<'a>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<Vec<ArunaSchemaMetadata>> {
    if array.elements.is_empty() {
        diagnostics.push(schema_invalid_diagnostic(
            file,
            action_id,
            export_name,
            role,
            DiagnosticSpan {
                start: array.span.start as usize,
                end: array.span.end as usize,
            },
            "union schemas require at least one member schema.".to_string(),
        ));
        return None;
    }

    let mut members = Vec::new();
    for element in &array.elements {
        let Some(expression) = element.as_expression() else {
            diagnostics.push(schema_invalid_diagnostic(
                file,
                action_id,
                export_name,
                role,
                DiagnosticSpan {
                    start: element.span().start as usize,
                    end: element.span().end as usize,
                },
                "union members must be schema expressions such as schema.string().".to_string(),
            ));
            return None;
        };

        let Some(member) = parse_schema_expression(
            file,
            action_id,
            export_name,
            role,
            expression,
            env,
            diagnostics,
        ) else {
            return None;
        };
        members.push(member);
    }

    Some(members)
}

fn parse_schema_argument<'a>(
    file: &str,
    action_id: &str,
    export_name: &str,
    role: SchemaRole,
    argument: &'a Argument<'a>,
    env: &SchemaEnv<'a>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<ArunaSchemaMetadata> {
    if let Argument::SpreadElement(_) = argument {
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
        return None;
    }

    let Some(expression) = argument.as_expression() else {
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
        return None;
    };

    parse_schema_expression(file, action_id, export_name, role, expression, env, diagnostics)
}

fn parse_schema_array_values(
    file: &str,
    action_id: &str,
    export_name: &str,
    role: SchemaRole,
    array: &ArrayExpression<'_>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<Vec<ArunaSchemaLiteralMetadata>> {
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
            _ => match literal_metadata_from_array_element(element) {
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
                    "Enum values must be literal values such as strings, numbers, booleans, or undefined."
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

fn parse_schema_object<'a>(
    file: &str,
    action_id: &str,
    export_name: &str,
    role: SchemaRole,
    object: &'a ObjectExpression<'a>,
    env: &SchemaEnv<'a>,
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
            env,
            diagnostics,
        ) else {
            return None;
        };

        properties.insert(name, child);
    }

    Some(ArunaSchemaMetadata {
        kind: "object".to_string(),
        properties: Some(properties),
        ..Default::default()
    })
}

fn parse_schema_call<'a>(
    file: &str,
    action_id: &str,
    export_name: &str,
    role: SchemaRole,
    call: &'a CallExpression<'a>,
    env: &SchemaEnv<'a>,
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
        // Argument-less leaf schemas. The Roblox userdata kinds (vector3/color3/
        // cframe) map to native Vector3/Color3/CFrame and travel over the wire
        // natively or as packed f32 components via the binary codec.
        "string" | "number" | "boolean" | "vector3" | "color3" | "cframe" => {
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
                ..Default::default()
            })
        }
        "f32" | "u8" | "u16" | "u32" | "i8" | "i16" | "i32" => {
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

            // Numeric width hints render as plain `number` in TypeScript; the
            // width is preserved as metadata for the binary codec, inspect, and
            // contract diffs. Plain `schema.number()` stays format-less (f64).
            Some(ArunaSchemaMetadata {
                kind: "number".to_string(),
                numeric_format: Some(kind.to_string()),
                ..Default::default()
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

            let Some(value) = literal_metadata_from_argument(argument) else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: argument.span().start as usize,
                        end: argument.span().end as usize,
                    },
                    "literal schemas only accept string, number, boolean, or undefined values."
                        .to_string(),
                ));
                return None;
            };

            Some(ArunaSchemaMetadata {
                kind: kind.to_string(),
                literal: Some(value),
                ..Default::default()
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
                env,
                diagnostics,
            ) else {
                return None;
            };

            Some(ArunaSchemaMetadata {
                kind: kind.to_string(),
                items: Some(Box::new(items)),
                ..Default::default()
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

            parse_schema_object(file, action_id, export_name, role, object, env, diagnostics)
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
                env,
                diagnostics,
            ) else {
                return None;
            };

            Some(ArunaSchemaMetadata {
                kind: kind.to_string(),
                inner: Some(Box::new(inner)),
                ..Default::default()
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
                values: Some(values),
                ..Default::default()
            })
        }
        "union" => {
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
                    "union schemas require exactly one array literal argument.".to_string(),
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
                    "union schemas require exactly one array literal argument.".to_string(),
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
                    "union schemas require an array literal of schema members.".to_string(),
                ));
                return None;
            };

            let Some(members) = parse_schema_union_members(
                file,
                action_id,
                export_name,
                role,
                array,
                env,
                diagnostics,
            ) else {
                return None;
            };

            Some(ArunaSchemaMetadata {
                kind: kind.to_string(),
                members: Some(members),
                ..Default::default()
            })
        }
        // A homogeneous string-keyed map. The value schema rides the `items`
        // metadata slot (like an array's element), so no new metadata field is
        // needed and existing snapshot consumers stay parseable.
        "record" => {
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
                    "record schemas require exactly one schema argument.".to_string(),
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
                    "record schemas require exactly one schema argument.".to_string(),
                ));
                return None;
            }

            let Some(items) = parse_schema_argument(
                file,
                action_id,
                export_name,
                role,
                argument,
                env,
                diagnostics,
            ) else {
                return None;
            };

            Some(ArunaSchemaMetadata {
                kind: kind.to_string(),
                items: Some(Box::new(items)),
                ..Default::default()
            })
        }
        // A fixed-length heterogeneous array. Element schemas ride the `members`
        // metadata slot (like a union's members), in positional order.
        "tuple" => {
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
                    "tuple schemas require exactly one array literal argument.".to_string(),
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
                    "tuple schemas require exactly one array literal argument.".to_string(),
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
                    "tuple schemas require an array literal of element schemas.".to_string(),
                ));
                return None;
            };

            let Some(members) = parse_schema_union_members(
                file,
                action_id,
                export_name,
                role,
                array,
                env,
                diagnostics,
            ) else {
                return None;
            };

            Some(ArunaSchemaMetadata {
                kind: kind.to_string(),
                members: Some(members),
                ..Default::default()
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

fn extract_action_schema<'a>(
    file: &str,
    action_id: &str,
    export_name: &str,
    role: SchemaRole,
    object: &'a ObjectExpression<'a>,
    property_name: &str,
    env: &SchemaEnv<'a>,
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
            env,
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

fn positive_integer_from_numeric_literal(value: f64) -> Option<u32> {
    if !value.is_finite() || value <= 0.0 || value.fract() != 0.0 || value > u32::MAX as f64 {
        return None;
    }

    Some(value as u32)
}

fn parse_rate_limit_object(
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
            "key" => {
                let Expression::StringLiteral(string_literal) = &object_property.value else {
                    diagnostics.push(rate_limit_invalid_diagnostic(
                        file,
                        action_id,
                        export_name,
                        DiagnosticSpan {
                            start: object_property.value.span().start as usize,
                            end: object_property.value.span().end as usize,
                        },
                        "rateLimit.key must be the string literal \"player\". Only \"player\" is supported for now."
                            .to_string(),
                    ));
                    return None;
                };

                if string_literal.value.as_str() != "player" {
                    diagnostics.push(rate_limit_invalid_diagnostic(
                        file,
                        action_id,
                        export_name,
                        DiagnosticSpan {
                            start: object_property.value.span().start as usize,
                            end: object_property.value.span().end as usize,
                        },
                        "rateLimit.key must be the string literal \"player\". Only \"player\" is supported for now."
                            .to_string(),
                    ));
                    return None;
                }

                key = Some("player".to_string());
            }
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
            "Missing rateLimit.key. Only \"player\" is supported for now.".to_string(),
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

fn extract_action_rate_limit(
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
fn extract_action_fire_and_forget(
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

fn analyze_define_action_call<'a>(
    file: &str,
    export_name: &str,
    call: &'a CallExpression<'a>,
    env: &SchemaEnv<'a>,
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
        env,
        diagnostics,
    );
    let (has_output_schema, output_schema) = extract_action_schema(
        file,
        &id,
        export_name,
        SchemaRole::Output,
        object,
        "output",
        env,
        diagnostics,
    );
    let rate_limit = extract_action_rate_limit(file, &id, export_name, object, diagnostics);
    let fire_and_forget =
        extract_action_fire_and_forget(file, &id, export_name, object, diagnostics);

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
        serialization: ArunaActionSerializationMetadata::default(),
        rate_limit,
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
    let env = collect_schema_bindings(program);

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
                &env,
                diagnostics,
            ) else {
                continue;
            };
            actions.push(candidate);
        }
    }

    (actions, saw_define_action)
}

fn analyze_define_signal_call<'a>(
    file: &str,
    export_name: &str,
    call: &'a CallExpression<'a>,
    env: &SchemaEnv<'a>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<ArunaSignalRecord> {
    let Some(Argument::ObjectExpression(object)) = call.arguments.first() else {
        diagnostics.push(create_diagnostic(
            "aruna::560",
            format!("Signal {export_name} in {file} has an invalid defineSignal definition."),
            Some(file.to_string()),
            Some(call_span(call)),
            Some("defineSignal expects a single object literal with at least an id.".to_string()),
            Some("Use defineSignal({ id: \"domain.signal\", payload: schema.object({ ... }) }).".to_string()),
        ));
        return None;
    };

    let Some(id_property) = find_object_property(object, "id") else {
        diagnostics.push(create_diagnostic(
            "aruna::560",
            format!("Signal {export_name} in {file} is missing an id."),
            Some(file.to_string()),
            Some(object_span(object)),
            Some("Signal ids must be declared as a static string literal.".to_string()),
            Some("Add id: \"domain.signalName\" to the defineSignal object.".to_string()),
        ));
        return None;
    };

    let Some(id) = (match &id_property.value {
        Expression::StringLiteral(literal) => Some(literal.value.to_string()),
        _ => None,
    }) else {
        diagnostics.push(create_diagnostic(
            "aruna::560",
            format!("Signal {export_name} in {file} has an invalid id."),
            Some(file.to_string()),
            Some(DiagnosticSpan {
                start: id_property.span.start as usize,
                end: id_property.span.end as usize,
            }),
            Some("Signal ids must be static string literals.".to_string()),
            Some("Use id: \"domain.signalName\" with a literal string value.".to_string()),
        ));
        return None;
    };

    let (has_payload_schema, payload_schema) = extract_action_schema(
        file,
        &id,
        export_name,
        SchemaRole::Payload,
        object,
        "payload",
        env,
        diagnostics,
    );

    Some(ArunaSignalRecord {
        id,
        file: file.to_string(),
        export_name: export_name.to_string(),
        has_payload_schema,
        serialization: ArunaActionSerializationMetadata::default(),
        payload_schema,
    })
}

fn collect_signal_candidates(
    file: &str,
    program: &oxc_ast::ast::Program<'_>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> (Vec<ArunaSignalRecord>, bool) {
    let mut signals = Vec::new();
    let mut saw_define_signal = false;
    let env = collect_schema_bindings(program);

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

            if callee.name.as_str() != "defineSignal" {
                continue;
            }

            saw_define_signal = true;

            let Some(candidate) =
                analyze_define_signal_call(file, binding.name.as_str(), call, &env, diagnostics)
            else {
                continue;
            };
            signals.push(candidate);
        }
    }

    (signals, saw_define_signal)
}

pub fn collect_signal_definitions(
    project_root: &Path,
    path: &Path,
    source_text: &str,
) -> Result<SignalDiscoveryResult, String> {
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
    let (mut signals, saw_define_signal) =
        collect_signal_candidates(&file, &parser_return.program, &mut diagnostics);
    let mut signal_files = BTreeSet::new();

    if saw_define_signal {
        signal_files.insert(file.clone());
    }

    signals.sort_by(|left, right| {
        left.id
            .cmp(&right.id)
            .then_with(|| left.file.cmp(&right.file))
            .then_with(|| left.export_name.cmp(&right.export_name))
    });

    Ok(SignalDiscoveryResult {
        signals,
        signal_files,
        diagnostics,
    })
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

    fn collect_signals(source: &str) -> SignalDiscoveryResult {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        let path = write_file(root, "src/signals.ts", source);
        collect_signal_definitions(root, &path, &std::fs::read_to_string(&path).unwrap()).unwrap()
    }

    #[test]
    fn collects_define_signal_with_payload_schema() {
        let result = collect_signals(
            r#"
import { defineSignal } from "aruna/server";
import { schema } from "aruna/schema";

export const damaged = defineSignal({
  id: "combat.damaged",
  payload: schema.object({ amount: schema.u16(), source: schema.string() }),
});

export const tick = defineSignal({ id: "world.tick" });
"#,
        );

        assert!(result.diagnostics.is_empty());
        assert_eq!(result.signals.len(), 2);

        let damaged = &result.signals[0];
        assert_eq!(damaged.id, "combat.damaged");
        assert_eq!(damaged.export_name, "damaged");
        assert!(damaged.has_payload_schema);

        let tick = &result.signals[1];
        assert_eq!(tick.id, "world.tick");
        assert!(!tick.has_payload_schema);
        assert_eq!(tick.payload_schema, None);
    }

    #[test]
    fn parses_record_and_tuple_schemas() {
        let (action, diagnostics) = collect_single_action(
            r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const syncInventory = defineAction({
  id: "inventory.sync",
  input: schema.object({
    counts: schema.record(schema.u16()),
    position: schema.tuple([schema.number(), schema.number()]),
  }),
  run() {
    return undefined;
  },
});
"#,
        );

        assert!(diagnostics.is_empty());
        let input = action.input_schema.expect("input schema");
        let properties = input.properties.expect("object properties");

        let counts = properties.get("counts").expect("counts field");
        assert_eq!(counts.kind, "record");
        assert_eq!(counts.items.as_deref().map(|item| item.kind.as_str()), Some("number"));

        let position = properties.get("position").expect("position field");
        assert_eq!(position.kind, "tuple");
        let members = position.members.as_ref().expect("tuple members");
        assert_eq!(members.len(), 2);
        assert!(members.iter().all(|member| member.kind == "number"));
    }

    #[test]
    fn reports_record_without_value_schema() {
        let (_, diagnostics) = collect_single_action_allow_empty(
            r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const broken = defineAction({
  id: "inventory.broken",
  input: schema.record(),
  run() {
    return undefined;
  },
});
"#,
        );

        assert!(diagnostics.iter().any(|d| d
            .details
            .as_deref()
            .is_some_and(|details| details.contains("record schemas require exactly one schema argument"))));
    }

    fn collect_single_action_allow_empty(source: &str) -> (Option<ArunaActionRecord>, Vec<ArunaDiagnostic>) {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        let path = write_file(root, "src/action.ts", source);

        let result = collect_action_definitions(root, &path, &std::fs::read_to_string(&path).unwrap())
            .unwrap();

        (result.actions.first().cloned(), result.diagnostics)
    }

    #[test]
    fn reports_signal_missing_id() {
        let result = collect_signals(
            r#"
import { defineSignal } from "aruna/server";

export const broken = defineSignal({});
"#,
        );

        assert!(result.signals.is_empty());
        assert!(result.diagnostics.iter().any(|d| d.code == "aruna::560"));
    }

    fn schema(kind: &str) -> ArunaSchemaMetadata {
        ArunaSchemaMetadata {
            kind: kind.to_string(),
            ..Default::default()
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
            ..Default::default()
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
    fn extracts_roblox_userdata_schema_metadata() {
        let result = collect_signals(
            r#"
import { defineSignal } from "aruna/server";
import { schema } from "aruna/schema";

export const moved = defineSignal({
  id: "world.moved",
  payload: schema.object({
    position: schema.vector3(),
    tint: schema.color3(),
    pivot: schema.cframe(),
  }),
});
"#,
        );

        assert!(result.diagnostics.is_empty());
        let moved = &result.signals[0];
        assert_eq!(
            moved.payload_schema,
            Some(object_schema(&[
                ("pivot", schema("cframe")),
                ("position", schema("vector3")),
                ("tint", schema("color3")),
            ]))
        );
    }

    #[test]
    fn rejects_arguments_to_userdata_schemas() {
        let (action, diagnostics) = collect_single_action(
            r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: schema.vector3(schema.number()),
  run(ctx, input) {
    return true;
  },
});
"#,
        );

        assert!(action.input_schema.is_none());
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].code, "aruna::553");
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
    fn extracts_numeric_width_hint_metadata() {
        let (action, diagnostics) = collect_single_action(
            r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const move = defineAction({
  id: "player.move",
  input: schema.object({ x: schema.i16(), team: schema.u8() }),
  output: schema.f32(),
  run(ctx, input) {
    return 1.0;
  },
});
"#,
        );

        assert!(diagnostics.is_empty());

        let numeric = |format: &str| ArunaSchemaMetadata {
            kind: "number".to_string(),
            numeric_format: Some(format.to_string()),
            ..Default::default()
        };

        assert_eq!(
            action.input_schema,
            Some(object_schema(&[("team", numeric("u8")), ("x", numeric("i16"))]))
        );
        assert_eq!(action.output_schema, Some(numeric("f32")));
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
                items: Some(Box::new(schema("string"))),
                ..Default::default()
            })
        );
    }

    #[test]
    fn extracts_union_schema_metadata() {
        let (action, diagnostics) = collect_single_action(
            r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: schema.union([schema.string(), schema.number()]),
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
                kind: "union".to_string(),
                members: Some(vec![schema("string"), schema("number")]),
                ..Default::default()
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

    #[test]
    fn resolves_action_schema_extracted_to_a_const() {
        let (action, diagnostics) = collect_single_action(
            r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

const purchaseInput = schema.object({ itemId: schema.string() });

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: purchaseInput,
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
            Some(object_schema(&[("itemId", schema("string"))]))
        );
    }

    #[test]
    fn resolves_signal_payload_schema_extracted_to_a_const() {
        let result = collect_signals(
            r#"
import { defineSignal } from "aruna/server";
import { schema } from "aruna/schema";

const damagePayload = schema.object({ amount: schema.u16() });

export const damaged = defineSignal({
  id: "combat.damaged",
  payload: damagePayload,
});
"#,
        );

        assert!(result.diagnostics.is_empty());
        assert_eq!(result.signals.len(), 1);

        let damaged = &result.signals[0];
        assert!(damaged.has_payload_schema);

        let amount = ArunaSchemaMetadata {
            kind: "number".to_string(),
            numeric_format: Some("u16".to_string()),
            ..Default::default()
        };
        assert_eq!(
            damaged.payload_schema,
            Some(object_schema(&[("amount", amount)]))
        );
    }

    #[test]
    fn resolves_schema_variable_nested_inside_a_schema() {
        let (action, _diagnostics) = collect_single_action(
            r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

const tag = schema.string();

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: schema.object({ tags: schema.array(tag) }),
  run(ctx, input) {
    return input;
  },
});
"#,
        );

        let tags = ArunaSchemaMetadata {
            kind: "array".to_string(),
            items: Some(Box::new(schema("string"))),
            ..Default::default()
        };
        assert_eq!(action.input_schema, Some(object_schema(&[("tags", tags)])));
    }

    #[test]
    fn follows_a_chain_of_schema_variables() {
        let (action, diagnostics) = collect_single_action(
            r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

const base = schema.string();
const alias = base;

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: alias,
  run(ctx, input) {
    return input;
  },
});
"#,
        );

        assert!(diagnostics.is_empty());
        assert_eq!(action.input_schema, Some(schema("string")));
    }

    #[test]
    fn reports_unresolved_schema_variable() {
        let (action, diagnostics) = collect_single_action(
            r#"
import { defineAction } from "aruna/server";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: missingSchema,
  run(ctx, input) {
    return input;
  },
});
"#,
        );

        assert!(action.input_schema.is_none());
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].code, "aruna::553");
        assert!(diagnostics[0]
            .details
            .as_ref()
            .is_some_and(|details| details.contains("could not be resolved")));
    }

    #[test]
    fn reports_self_referential_schema_variable() {
        let result = collect_signals(
            r#"
import { defineSignal } from "aruna/server";

const loopSchema = loopSchema;

export const ticked = defineSignal({
  id: "world.ticked",
  payload: loopSchema,
});
"#,
        );

        let signal = &result.signals[0];
        assert!(signal.payload_schema.is_none());
        assert_eq!(result.diagnostics.len(), 1);
        assert_eq!(result.diagnostics[0].code, "aruna::564");
        assert!(result.diagnostics[0]
            .details
            .as_ref()
            .is_some_and(|details| details.contains("refers to itself")));
    }
}
