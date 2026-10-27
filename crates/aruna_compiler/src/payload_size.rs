// The largest payload the binary codec can produce for a schema: what the
// signal size checks compare against Roblox's unreliable-remote limit.

use crate::schema_metadata::ArunaSchemaMetadata;

// Every binary frame starts with a u32 schema fingerprint.
pub const BINARY_FRAME_HEADER_BYTES: u64 = 4;

// Roblox drops an UnreliableRemoteEvent payload over this size without an
// error on either side, so the compiler checks it instead.
pub const UNRELIABLE_PAYLOAD_LIMIT_BYTES: u64 = 900;

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
