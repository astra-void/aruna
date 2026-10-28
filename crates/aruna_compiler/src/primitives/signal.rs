// `defineSignal`: server -> client pushes over the signal remotes.

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
use crate::payload_size::*;
use crate::schema_metadata::*;
use crate::spans::*;
use crate::static_literals::*;

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
    // Routed over the dedicated UnreliableRemoteEvent (no delivery/ordering
    // guarantee). Omitted from the manifest JSON when false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unreliable: bool,
    // "binary" when the payload travels as an `encodeBinary` buffer; omitted for
    // the default plain-table encoding.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wire: Option<String>,
    // The largest `encodeBinary` output for the payload, frame header included,
    // or omitted when the schema is unbounded. Exact for `wire: "binary"`; for
    // the table encoding it is a lower bound (Roblox adds type tags and keys).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_encoded_bytes: Option<u64>,
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

// Reads the optional `unreliable` flag off a defineSignal object. Accepts a
// boolean literal; anything else is a hard error so a typo'd value can't
// silently change which remote a signal travels over.
pub(crate) fn extract_signal_unreliable(
    file: &str,
    signal_id: &str,
    export_name: &str,
    object: &ObjectExpression<'_>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> bool {
    let Some(property) = find_object_property(object, "unreliable") else {
        return false;
    };

    match &property.value {
        Expression::BooleanLiteral(literal) => literal.value,
        _ => {
            diagnostics.push(create_diagnostic(
                "aruna::560",
                format!("Signal {signal_id} has an invalid unreliable option."),
                Some(file.to_string()),
                Some(DiagnosticSpan {
                    start: property.value.span().start as usize,
                    end: property.value.span().end as usize,
                }),
                Some(format!("export name: {export_name}")),
                Some("Set unreliable to a boolean literal (true or false).".to_string()),
            ));
            false
        }
    }
}

pub(crate) fn analyze_define_signal_call<'a>(
    file: &str,
    export_name: &str,
    call: &'a CallExpression<'a>,
    scope: &SchemaScope<'a>,
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
        scope,
        diagnostics,
    );

    let unreliable = extract_signal_unreliable(file, &id, export_name, object, diagnostics);
    let wire = extract_signal_wire(
        file,
        &id,
        export_name,
        object,
        payload_schema.as_ref(),
        diagnostics,
    );
    let max_encoded_bytes = payload_schema
        .as_ref()
        .and_then(max_encoded_payload_bytes)
        .map(|payload| payload + BINARY_FRAME_HEADER_BYTES);

    if unreliable {
        check_unreliable_payload_size(
            file,
            &id,
            export_name,
            object,
            wire.is_some(),
            max_encoded_bytes,
            diagnostics,
        );
    }

    Some(ArunaSignalRecord {
        id,
        file: file.to_string(),
        export_name: export_name.to_string(),
        has_payload_schema,
        unreliable,
        wire,
        max_encoded_bytes,
        serialization: ArunaActionSerializationMetadata::default(),
        payload_schema,
    })
}

// Reads the optional `wire` option off a defineSignal object. Only the string
// literal "binary" is accepted, and only with a payload schema the binary codec
// can encode: the codec lays the payload out from the schema, so without one
// (or with an Instance in it) there is nothing to encode against.
pub(crate) fn extract_signal_wire(
    file: &str,
    signal_id: &str,
    export_name: &str,
    object: &ObjectExpression<'_>,
    payload_schema: Option<&ArunaSchemaMetadata>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<String> {
    let property = find_object_property(object, "wire")?;
    let span = DiagnosticSpan {
        start: property.value.span().start as usize,
        end: property.value.span().end as usize,
    };
    let invalid = |diagnostics: &mut Vec<ArunaDiagnostic>, details: &str, suggestion: &str| {
        diagnostics.push(create_diagnostic(
            "aruna::512",
            format!("Signal {signal_id} has an invalid wire option."),
            Some(file.to_string()),
            Some(span.clone()),
            Some(format!("{details} (export name: {export_name})")),
            Some(suggestion.to_string()),
        ));
    };

    match &property.value {
        Expression::StringLiteral(literal) if literal.value.as_str() == "binary" => {}
        _ => {
            invalid(
                diagnostics,
                "wire must be the string literal \"binary\"",
                "Set wire: \"binary\", or remove it for the default table encoding.",
            );
            return None;
        }
    }

    let Some(schema) = payload_schema else {
        invalid(
            diagnostics,
            "a binary signal needs a payload schema to encode against",
            "Declare payload: schema.object({ ... }), or remove wire: \"binary\".",
        );
        return None;
    };
    if schema_contains_kind(schema, "instance") {
        invalid(
            diagnostics,
            "schema.instance() cannot be binary-encoded",
            "Send the Instance over the default table encoding, or remove it from the payload.",
        );
        return None;
    }

    Some("binary".to_string())
}

// An UnreliableRemoteEvent silently drops a payload over Roblox's limit, so an
// unreliable signal whose payload could exceed it is caught here instead.
pub(crate) fn check_unreliable_payload_size(
    file: &str,
    signal_id: &str,
    export_name: &str,
    object: &ObjectExpression<'_>,
    binary: bool,
    max_encoded_bytes: Option<u64>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) {
    let span = find_object_property(object, "payload")
        .map(|property| DiagnosticSpan {
            start: property.span.start as usize,
            end: property.span.end as usize,
        })
        .unwrap_or_else(|| object_span(object));

    let Some(encoded) = max_encoded_bytes else {
        diagnostics.push(create_diagnostic(
            "aruna::510",
            format!(
                "Unreliable signal {signal_id} has no bound on its payload size; Roblox drops an unreliable payload over {UNRELIABLE_PAYLOAD_LIMIT_BYTES} bytes without an error."
            ),
            Some(file.to_string()),
            Some(span),
            Some(format!(
                "A payload is bounded when every string has .maxLength(n) or .maxChars(n), every array .maxItems(n), and it holds no record (export name: {export_name})."
            )),
            Some("Bound the payload schema, or make the signal reliable.".to_string()),
        ));
        return;
    };

    // The table encoding has no frame header, and its true size is larger than
    // the binary layout, so the binary size without the header is a floor.
    // Either way the wire frame around the payload counts toward the limit.
    let payload = if binary {
        encoded
    } else {
        encoded - BINARY_FRAME_HEADER_BYTES
    };
    let compared = signal_message_bytes(signal_id, payload);
    let frame = compared - payload;
    if compared > UNRELIABLE_PAYLOAD_LIMIT_BYTES {
        diagnostics.push(create_diagnostic(
            "aruna::511",
            format!(
                "Unreliable signal {signal_id} can carry up to {compared} bytes, over Roblox's {UNRELIABLE_PAYLOAD_LIMIT_BYTES}-byte unreliable limit; larger payloads are dropped without an error."
            ),
            Some(file.to_string()),
            Some(span),
            Some(if binary {
                format!(
                    "Largest binary frame ({payload} bytes, 4-byte header included) plus its wire frame ({frame} bytes) (export name: {export_name})."
                )
            } else {
                format!(
                    "Largest payload by the binary layout ({payload} bytes) plus its wire frame ({frame} bytes); the table encoding is larger still (export name: {export_name})."
                )
            }),
            Some("Lower the payload's maxLength / maxItems bounds, split it, or make the signal reliable.".to_string()),
        ));
        return;
    }

    // Under the limit by the floor, but the table encoding adds type tags and
    // keys the floor does not count, so close to it is not safe either.
    let warn_at = UNRELIABLE_PAYLOAD_LIMIT_BYTES * UNRELIABLE_TABLE_ENCODING_WARN_PERCENT / 100;
    if !binary && compared > warn_at {
        diagnostics.push(create_diagnostic(
            "aruna::513",
            format!(
                "Unreliable signal {signal_id} is at least {compared} bytes with the table encoding, over {UNRELIABLE_TABLE_ENCODING_WARN_PERCENT}% of Roblox's {UNRELIABLE_PAYLOAD_LIMIT_BYTES}-byte unreliable limit; its real size is larger and may be over it."
            ),
            Some(file.to_string()),
            Some(span),
            Some(format!(
                "Largest payload by the binary layout ({payload} bytes) plus its wire frame ({frame} bytes). The table encoding adds a type tag and key per value on top, which the compiler cannot size (export name: {export_name})."
            )),
            Some("Set wire: \"binary\": its size is exact, and the publisher checks each frame against the limit before firing.".to_string()),
        ));
    }
}

pub struct SignalPrimitive;

impl Primitive for SignalPrimitive {
    type Record = ArunaSignalRecord;

    const NAME: &'static str = "signal";
    const CALLEES: &'static [&'static str] = &["defineSignal"];
    const DEFINING_MODULE: Option<DefiningModule> = None;
    const IN_CONTRACT: bool = true;
    // Kept after the import pass, where the duplicate check always ran, so
    // diagnostic order stays byte-stable.
    const FINALIZE_STAGE: FinalizeStage = FinalizeStage::AfterImports;

    fn analyze(
        site: &DefinitionSite<'_, '_>,
        diagnostics: &mut Vec<ArunaDiagnostic>,
    ) -> Option<Self::Record> {
        analyze_define_signal_call(site.file, site.export_name, site.call, site.schema_scope(), diagnostics)
    }

    fn sort_key(record: &Self::Record) -> (&str, &str, &str) {
        (&record.id, &record.file, &record.export_name)
    }

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

        let mut seen_signal_ids = BTreeMap::new();
        for signal in &records {
            if let Some(previous_file) = seen_signal_ids.insert(signal.id.clone(), signal.file.clone()) {
                diagnostics.push(create_diagnostic(
                    "aruna::563",
                    format!("Signal id {} is defined more than once.", signal.id),
                    Some(signal.file.clone()),
                    None,
                    Some(format!(
                        "First defined in {}, then again in {}.",
                        previous_file, signal.file
                    )),
                    Some("Use globally unique signal ids such as domain.signalName.".to_string()),
                ));
            }
        }
        records
    }
}

pub fn collect_signal_definitions(
    project_root: &Path,
    path: &Path,
    source_text: &str,
) -> Result<SignalDiscoveryResult, String> {
    let found = collect_definitions::<SignalPrimitive>(project_root, path, source_text)?;
    let mut signal_files = BTreeSet::new();
    if found.defines {
        signal_files.insert(project_relative(project_root, path));
    }
    Ok(SignalDiscoveryResult {
        signals: found.records,
        signal_files,
        diagnostics: found.diagnostics,
    })
}
