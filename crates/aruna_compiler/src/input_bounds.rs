// aruna::514: an action input with no upper bound on a string, array, or
// record. The wire walk caps how many values a payload holds, but not how long
// a string is, and an unbounded collection is validated entry by entry up to
// that cap. A declared bound is where the server refuses an oversized payload
// itself, and the contract records it.

use crate::config::StrictSeverity;
use crate::diagnostics::{create_diagnostic, ArunaDiagnostic, DiagnosticSeverity};
use crate::primitives::ArunaActionRecord;
use crate::schema_metadata::ArunaSchemaMetadata;

fn has_dynamic(schema: &ArunaSchemaMetadata, names: &[&str]) -> bool {
    schema
        .dynamic_constraints
        .iter()
        .any(|name| names.contains(&name.as_str()))
}

// What one unbounded value is missing, by kind.
fn missing_bound(schema: &ArunaSchemaMetadata) -> Option<&'static str> {
    match schema.kind.as_str() {
        "string"
            if schema.max_length.is_none()
                && schema.max_chars.is_none()
                && !has_dynamic(schema, &["maxLength", "length", "maxChars"]) =>
        {
            Some("a string with no .maxLength(n) or .maxChars(n)")
        }
        "array"
            if schema.max_items.is_none() && !has_dynamic(schema, &["maxItems", "length"]) =>
        {
            Some("an array with no .maxItems(n)")
        }
        "record" if schema.max_entries.is_none() && !has_dynamic(schema, &["maxEntries"]) => {
            Some("a record with no .maxEntries(n)")
        }
        _ => None,
    }
}

// Every unbounded value in `schema`, with its path (`input.tags[]`).
fn collect_unbounded(
    schema: &ArunaSchemaMetadata,
    path: &str,
    found: &mut Vec<(String, &'static str)>,
) {
    if let Some(missing) = missing_bound(schema) {
        found.push((path.to_string(), missing));
    }
    match schema.kind.as_str() {
        "object" => {
            for (key, field) in schema.properties.iter().flatten() {
                collect_unbounded(field, &format!("{path}.{key}"), found);
            }
        }
        "array" => {
            if let Some(items) = schema.items.as_deref() {
                collect_unbounded(items, &format!("{path}[]"), found);
            }
        }
        // A record's value schema rides the `items` slot.
        "record" => {
            if let Some(value) = schema.items.as_deref() {
                collect_unbounded(value, &format!("{path}.<value>"), found);
            }
        }
        "optional" => {
            if let Some(inner) = schema.inner.as_deref() {
                collect_unbounded(inner, path, found);
            }
        }
        "tuple" => {
            for (index, member) in schema.members.iter().flatten().enumerate() {
                collect_unbounded(member, &format!("{path}.{index}"), found);
            }
        }
        "union" => {
            for member in schema.members.iter().flatten() {
                collect_unbounded(member, path, found);
            }
        }
        _ => {}
    }
}

pub(crate) fn unbounded_input_paths(schema: &ArunaSchemaMetadata) -> Vec<(String, &'static str)> {
    let mut found = Vec::new();
    collect_unbounded(schema, "input", &mut found);
    found.dedup();
    found
}

// One diagnostic per action, listing every unbounded value in its input. None
// when the setting is off, the action has no readable input schema, or every
// value in it is bounded.
pub(crate) fn create_unbounded_input_diagnostic(
    action: &ArunaActionRecord,
    severity: &StrictSeverity,
) -> Option<ArunaDiagnostic> {
    if matches!(severity, StrictSeverity::Off) {
        return None;
    }
    let found = unbounded_input_paths(action.input_schema.as_ref()?);
    if found.is_empty() {
        return None;
    }

    let details = found
        .iter()
        .map(|(path, missing)| format!("{path}: {missing}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut diagnostic = create_diagnostic(
        "aruna::514",
        format!(
            "Server action {} accepts input with no size limit.",
            action.id
        ),
        Some(action.file.clone()),
        None,
        Some(format!("export name: {}\n{details}", action.export_name)),
        Some(
            "Bound every string with .maxLength(n) or .maxChars(n), every array with .maxItems(n), and every record with .maxEntries(n), so validation refuses an oversized payload. strict.unboundedInput sets this diagnostic's severity."
                .to_string(),
        ),
    );
    diagnostic.severity = match severity {
        StrictSeverity::Error => DiagnosticSeverity::Error,
        _ => DiagnosticSeverity::Warning,
    };
    Some(diagnostic)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(kind: &str) -> ArunaSchemaMetadata {
        ArunaSchemaMetadata {
            kind: kind.to_string(),
            ..Default::default()
        }
    }

    fn object(fields: Vec<(&str, ArunaSchemaMetadata)>) -> ArunaSchemaMetadata {
        ArunaSchemaMetadata {
            kind: "object".to_string(),
            properties: Some(
                fields
                    .into_iter()
                    .map(|(key, value)| (key.to_string(), value))
                    .collect(),
            ),
            ..Default::default()
        }
    }

    #[test]
    fn finds_every_unbounded_value_with_its_path() {
        let tags = ArunaSchemaMetadata {
            kind: "array".to_string(),
            items: Some(Box::new(leaf("string"))),
            ..Default::default()
        };
        let bounded_name = ArunaSchemaMetadata {
            max_chars: Some(20),
            ..leaf("string")
        };
        let scores = ArunaSchemaMetadata {
            kind: "record".to_string(),
            items: Some(Box::new(leaf("number"))),
            max_entries: Some(8),
            ..Default::default()
        };
        let note = ArunaSchemaMetadata {
            kind: "optional".to_string(),
            inner: Some(Box::new(leaf("string"))),
            ..Default::default()
        };
        let schema = object(vec![
            ("name", bounded_name),
            ("tags", tags),
            ("scores", scores),
            ("note", note),
            ("count", leaf("number")),
        ]);

        assert_eq!(
            unbounded_input_paths(&schema),
            vec![
                ("input.note".to_string(), "a string with no .maxLength(n) or .maxChars(n)"),
                ("input.tags".to_string(), "an array with no .maxItems(n)"),
                ("input.tags[]".to_string(), "a string with no .maxLength(n) or .maxChars(n)"),
            ]
        );
    }

    #[test]
    fn counts_a_bound_it_cannot_read_as_a_bound() {
        let computed = ArunaSchemaMetadata {
            dynamic_constraints: vec!["maxLength".to_string()],
            ..leaf("string")
        };
        assert!(unbounded_input_paths(&computed).is_empty());

        // A lower bound bounds nothing.
        let floor = ArunaSchemaMetadata {
            min_length: Some(3),
            dynamic_constraints: vec!["minLength".to_string()],
            ..leaf("string")
        };
        assert_eq!(unbounded_input_paths(&floor).len(), 1);
    }
}
