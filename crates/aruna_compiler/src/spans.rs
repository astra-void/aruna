// Spans, source types, and the schema diagnostics every primitive reports.

use crate::diagnostics::{create_diagnostic, ArunaDiagnostic, DiagnosticSpan};
use oxc_ast::ast::{
    CallExpression, Expression, ObjectExpression,
};
use oxc_span::{GetSpan, SourceType};
use std::path::Path;
use crate::schema_metadata::*;

pub(crate) fn source_type_for_path(path: &Path) -> Result<SourceType, String> {
    SourceType::from_path(path).map_err(|error| error.to_string())
}

pub(crate) fn call_span(call: &CallExpression<'_>) -> DiagnosticSpan {
    DiagnosticSpan {
        start: call.span.start as usize,
        end: call.span.end as usize,
    }
}

pub(crate) fn object_span(object: &ObjectExpression<'_>) -> DiagnosticSpan {
    DiagnosticSpan {
        start: object.span.start as usize,
        end: object.span.end as usize,
    }
}

pub(crate) fn schema_invalid_diagnostic(
    file: &str,
    action_id: &str,
    export_name: &str,
    role: SchemaRole,
    span: DiagnosticSpan,
    details: String,
) -> ArunaDiagnostic {
    let subject = match role {
        SchemaRole::Resource => "Resource",
        _ => "Server action",
    };
    create_diagnostic(
        role.code(),
        format!("{subject} {action_id} has an invalid {} schema.", role.label()),
        Some(file.to_string()),
        Some(span),
        Some(format!("export name: {export_name}\n{details}")),
        Some(
            "Use schema.string(), schema.number(), schema.boolean(), schema.literal(...), schema.array(...), schema.object({...}), schema.optional(...), schema.record(...), schema.tuple([...]), schema.enum([...]), schema.union([...]), schema.discriminatedUnion(key, [...]), or a Roblox userdata schema (vector3/vector2/color3/cframe/udim/udim2/dateTime/brickColor/instance)."
                .to_string(),
        ),
    )
}

// An identifier used as a schema that resolves to nothing — locally or through
// one import hop. Unlike the shape warnings (aruna::553/554/564) this is an
// Error: the author clearly meant a named schema, and degrading silently would
// produce `unknown`-typed clients and an empty contract entry.
pub(crate) fn schema_unresolved_diagnostic(
    file: &str,
    action_id: &str,
    export_name: &str,
    role: SchemaRole,
    span: DiagnosticSpan,
    details: String,
) -> ArunaDiagnostic {
    let subject = match role {
        SchemaRole::Payload => "Signal",
        SchemaRole::Resource => "Resource",
        _ => "Server action",
    };
    create_diagnostic(
        "aruna::565",
        format!(
            "{subject} {action_id} references an unresolved {} schema.",
            role.label()
        ),
        Some(file.to_string()),
        Some(span),
        Some(format!("export name: {export_name}\n{details}")),
        Some(
            "Declare the schema as a module-level `const` in this file, or import it (one hop) from the module that declares it as a module-level `const` schema."
                .to_string(),
        ),
    )
}

pub(crate) fn schema_span_from_expression(expression: &Expression<'_>) -> DiagnosticSpan {
    DiagnosticSpan {
        start: expression.span().start as usize,
        end: expression.span().end as usize,
    }
}
