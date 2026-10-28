// The largest payload the binary codec can produce for a schema: what the
// signal size checks compare against Roblox's unreliable-remote limit.

use crate::schema_metadata::ArunaSchemaMetadata;

// Every binary frame starts with a u32 schema fingerprint.
pub const BINARY_FRAME_HEADER_BYTES: u64 = 4;

// Roblox drops an UnreliableRemoteEvent payload over this size without an
// error on either side, so the compiler checks it instead.
pub const UNRELIABLE_PAYLOAD_LIMIT_BYTES: u64 = 900;

// What an unreliable signal's wire frame costs on top of its payload
// (docs/wire-protocol.md). An unreliable signal goes out alone in its frame,
// `[1, { s = signalId, d = payload }]`, so the limit applies to that frame, not
// the payload alone. Roblox does not document its remote encoding; a value there
// costs a type tag plus a length or count, and 8 bytes each covers a tag and a
// length prefix of up to 7 bytes with room to spare. The frame holds seven
// values (the frame array, the protocol version, the item table, the keys "s"
// and "d", the signal id, the payload), plus the two one-byte key strings and
// the signal id's own bytes (added per signal). Erring high only means warning a
// little early. Mirrored by the runtime's publisher
// (SIGNAL_FRAME_OVERHEAD_BYTES), which checks a binary frame against the same
// total before firing it.
pub const WIRE_VALUE_ALLOWANCE_BYTES: u64 = 8;
pub const WIRE_SIGNAL_FRAME_VALUES: u64 = 7;
pub const WIRE_SIGNAL_FRAME_KEY_BYTES: u64 = 2;
pub const WIRE_SIGNAL_FRAME_OVERHEAD_BYTES: u64 =
    WIRE_SIGNAL_FRAME_VALUES * WIRE_VALUE_ALLOWANCE_BYTES + WIRE_SIGNAL_FRAME_KEY_BYTES;

// For the table encoding the compiler knows only a floor; past this share of the
// limit, the real size is likely over it, so binary is recommended.
pub const UNRELIABLE_TABLE_ENCODING_WARN_PERCENT: u64 = 75;

// An unreliable signal's size on the wire: the payload plus its frame.
pub fn signal_message_bytes(signal_id: &str, payload_bytes: u64) -> u64 {
    payload_bytes + signal_id.len() as u64 + WIRE_SIGNAL_FRAME_OVERHEAD_BYTES
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
