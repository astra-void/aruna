// The largest payload the binary codec can produce for a schema: what the
// signal size checks compare against Roblox's unreliable-remote limit.

use crate::schema_metadata::ArunaSchemaMetadata;

// Every binary frame starts with a u32 schema fingerprint.
pub const BINARY_FRAME_HEADER_BYTES: u64 = 4;

// Roblox drops an UnreliableRemoteEvent payload over this size without an
// error on either side, so the compiler checks it instead.
pub const UNRELIABLE_PAYLOAD_LIMIT_BYTES: u64 = 900;

// What a signal message costs on top of its payload. The remote carries
// `{ signalId, payload }`, so the limit applies to that table, not the payload
// alone: the two key strings ("signalId" + "payload", 15 bytes), the signal id
// itself (added per signal), and an allowance for each of the five values the
// table holds (the table, two keys, two values). Roblox does not document its
// remote encoding; a value there costs a type tag plus a length or count, and
// 8 bytes each covers a tag and a length prefix of up to 7 bytes with room to
// spare. Erring high only means warning a little early. Mirrored by the
// runtime's publisher (SIGNAL_ENVELOPE_OVERHEAD_BYTES), which checks a binary
// frame against the same total before firing it.
pub const SIGNAL_ENVELOPE_KEY_BYTES: u64 = 15;
pub const SIGNAL_ENVELOPE_VALUE_ALLOWANCE_BYTES: u64 = 8;
pub const SIGNAL_ENVELOPE_VALUES: u64 = 5;
pub const SIGNAL_ENVELOPE_OVERHEAD_BYTES: u64 =
    SIGNAL_ENVELOPE_KEY_BYTES + SIGNAL_ENVELOPE_VALUES * SIGNAL_ENVELOPE_VALUE_ALLOWANCE_BYTES;

// For the table encoding the compiler knows only a floor; past this share of the
// limit, the real size is likely over it, so binary is recommended.
pub const UNRELIABLE_TABLE_ENCODING_WARN_PERCENT: u64 = 75;

// A signal message's size: the payload plus its `{ signalId, payload }` envelope.
pub fn signal_message_bytes(signal_id: &str, payload_bytes: u64) -> u64 {
    payload_bytes + signal_id.len() as u64 + SIGNAL_ENVELOPE_OVERHEAD_BYTES
}

// The largest payload `encodeBinary` can produce for a schema, frame header
// excluded, or None when nothing bounds it. Follows the codec's layout
// (packages/aruna/roblox/binary.ts): a string needs `.maxLength` or `.maxChars`, an
// array `.maxItems`;
// a record has no size bound at all; optionals and unions take their largest
// branch.
pub fn max_encoded_payload_bytes(schema: &ArunaSchemaMetadata) -> Option<u64> {
    match schema.kind.as_str() {
        "string" => schema.max_length.map(|length| 4 + u64::from(length)),
        "number" => Some(match schema.numeric_format.as_deref() {
            Some("u8") | Some("i8") => 1,
            Some("u16") | Some("i16") => 2,
            Some("u32") | Some("i32") | Some("f32") => 4,
            _ => 8,
        }),
        "boolean" => Some(1),
        "literal" => Some(0),
        "enum" => Some(4),
        "array" => {
            let items = u64::from(schema.max_items?);
            let item = max_encoded_payload_bytes(schema.items.as_deref()?)?;
            Some(4 + items * item)
        }
        "object" => schema
            .properties
            .as_ref()?
            .values()
            .map(max_encoded_payload_bytes)
            .sum::<Option<u64>>(),
        "tuple" => schema
            .members
            .as_ref()?
            .iter()
            .map(max_encoded_payload_bytes)
            .sum::<Option<u64>>(),
        "optional" => Some(1 + max_encoded_payload_bytes(schema.inner.as_deref()?)?),
        "union" => {
            let mut largest = 0;
            for member in schema.members.as_ref()? {
                largest = largest.max(max_encoded_payload_bytes(member)?);
            }
            Some(4 + largest)
        }
        "vector2" => Some(8),
        "vector3" | "color3" => Some(12),
        "cframe" => Some(48),
        "udim" => Some(8),
        "udim2" => Some(16),
        "dateTime" => Some(8),
        "brickColor" => Some(2),
        // `record` has no bound; `instance` cannot be binary-encoded at all.
        _ => None,
    }
}
