// Aruna roblox-ts native runtime — schema-driven binary codec.
//
// Mirror of the Node reference codec (src/runtime/binary.ts) over the Luau
// `buffer` library. Encodes a schema-conforming value into a packed buffer that
// RemoteEvents replicate natively, spending no bytes on field names.
//
// Every frame starts with a u32 **schema fingerprint** (a portable hash of the
// schema layout, identical across both runtimes). Decoding is positional, so a
// client and server holding different schema versions — the normal state
// mid-rollout — would otherwise silently mis-read each other's bytes; the
// fingerprint check turns that into an immediate, explicit error.
//
// Layout per schema typeName matches the reference codec exactly so a value
// encoded on one runtime decodes on the other:
//   string   u32 length prefix + UTF-8 bytes
//   number   f64
//   boolean  u8 (0 | 1)
//   literal  0 bytes
//   array    u32 count + each item
//   object   each field in sorted key order
//   optional u8 present flag + inner when present
//   enum     u32 index into the schema's values
//   union    u32 member index + the matching member's encoding
//   vector3  3 x f32 (X, Y, Z)
//   color3   3 x f32 (R, G, B)
//   cframe   12 x f32 (CFrame:GetComponents() order)

import type { NumberFormat, Schema, SchemaLiteral } from "./schema";

class BinaryWriter {
	private buf: buffer;
	private capacity: number;
	private offset = 0;

	constructor(initialCapacity: number) {
		this.capacity = initialCapacity;
		this.buf = buffer.create(initialCapacity);
	}

	private ensure(extra: number): void {
		const required = this.offset + extra;
		if (required <= this.capacity) {
			return;
		}
		let nextCapacity = this.capacity * 2;
		while (nextCapacity < required) {
			nextCapacity *= 2;
		}
		const grown = buffer.create(nextCapacity);
		buffer.copy(grown, 0, this.buf, 0, this.offset);
		this.buf = grown;
		this.capacity = nextCapacity;
	}

	writeU8(value: number): void {
		this.ensure(1);
		buffer.writeu8(this.buf, this.offset, value);
		this.offset += 1;
	}

	writeU32(value: number): void {
		this.ensure(4);
		buffer.writeu32(this.buf, this.offset, value);
		this.offset += 4;
	}

	writeF64(value: number): void {
		this.ensure(8);
		buffer.writef64(this.buf, this.offset, value);
		this.offset += 8;
	}

	writeF32(value: number): void {
		this.ensure(4);
		buffer.writef32(this.buf, this.offset, value);
		this.offset += 4;
	}

	writeNumber(value: number, format: NumberFormat): void {
		if (format === "f64") {
			this.writeF64(value);
		} else if (format === "f32") {
			this.writeF32(value);
		} else if (format === "u8") {
			this.writeU8(value);
		} else if (format === "u16") {
			this.ensure(2);
			buffer.writeu16(this.buf, this.offset, value);
			this.offset += 2;
		} else if (format === "u32") {
			this.writeU32(value);
		} else if (format === "i8") {
			this.ensure(1);
			buffer.writei8(this.buf, this.offset, value);
			this.offset += 1;
		} else if (format === "i16") {
			this.ensure(2);
			buffer.writei16(this.buf, this.offset, value);
			this.offset += 2;
		} else if (format === "i32") {
			this.ensure(4);
			buffer.writei32(this.buf, this.offset, value);
			this.offset += 4;
		} else {
			throw "Aruna binary encode: unsupported number format.";
		}
	}

	writeBool(value: boolean): void {
		this.writeU8(value ? 1 : 0);
	}

	writeString(value: string): void {
		const encoded = buffer.fromstring(value);
		const length = buffer.len(encoded);
		this.writeU32(length);
		this.ensure(length);
		buffer.copy(this.buf, this.offset, encoded, 0, length);
		this.offset += length;
	}

	finish(): buffer {
		const out = buffer.create(this.offset);
		buffer.copy(out, 0, this.buf, 0, this.offset);
		return out;
	}
}

class BinaryReader {
	private offset = 0;
	private readonly length: number;

	constructor(private readonly buf: buffer) {
		this.length = buffer.len(buf);
	}

	// Bounds guard before every read. The buffer on a client->server action is
	// untrusted input, so a truncated or corrupt frame must fail with a clear
	// error instead of an unguarded Luau buffer-access error (or worse, reading
	// adjacent bytes). Mirrors the Node reference reader.
	private require(extra: number): void {
		if (this.offset + extra > this.length) {
			throw "Aruna binary decode ran past the end of the buffer.";
		}
	}

	readU8(): number {
		this.require(1);
		const value = buffer.readu8(this.buf, this.offset);
		this.offset += 1;
		return value;
	}

	readU32(): number {
		this.require(4);
		const value = buffer.readu32(this.buf, this.offset);
		this.offset += 4;
		return value;
	}

	readF64(): number {
		this.require(8);
		const value = buffer.readf64(this.buf, this.offset);
		this.offset += 8;
		return value;
	}

	readF32(): number {
		this.require(4);
		const value = buffer.readf32(this.buf, this.offset);
		this.offset += 4;
		return value;
	}

	readNumber(format: NumberFormat): number {
		if (format === "f64") {
			return this.readF64();
		} else if (format === "f32") {
			return this.readF32();
		} else if (format === "u8") {
			return this.readU8();
		} else if (format === "u16") {
			this.require(2);
			const value = buffer.readu16(this.buf, this.offset);
			this.offset += 2;
			return value;
		} else if (format === "u32") {
			return this.readU32();
		} else if (format === "i8") {
			this.require(1);
			const value = buffer.readi8(this.buf, this.offset);
			this.offset += 1;
			return value;
		} else if (format === "i16") {
			this.require(2);
			const value = buffer.readi16(this.buf, this.offset);
			this.offset += 2;
			return value;
		} else if (format === "i32") {
			this.require(4);
			const value = buffer.readi32(this.buf, this.offset);
			this.offset += 4;
			return value;
		}
		throw "Aruna binary decode: unsupported number format.";
	}

	readBool(): boolean {
		return this.readU8() !== 0;
	}

	readString(): string {
		const length = this.readU32();
		this.require(length);
		const value = buffer.readstring(this.buf, this.offset, length);
		this.offset += length;
		return value;
	}
}

function sortedKeys(fields: { readonly [key: string]: Schema }): Array<string> {
	const keys: Array<string> = [];
	for (const [key] of pairs(fields as { [key: string]: Schema })) {
		keys.push(key as string);
	}
	keys.sort();
	return keys;
}

function encodeValue(schema: Schema, value: unknown, writer: BinaryWriter): void {
	const typeName = schema.typeName;
	if (typeName === "string") {
		writer.writeString(value as string);
	} else if (typeName === "number") {
		writer.writeNumber(value as number, schema.format ?? "f64");
	} else if (typeName === "boolean") {
		writer.writeBool(value as boolean);
	} else if (typeName === "literal") {
		// Recovered from the schema on decode.
	} else if (typeName === "array") {
		const item = schema.item;
		if (item === undefined) {
			throw "Aruna binary encode: array schema is missing its item.";
		}
		const items = value as Array<unknown>;
		writer.writeU32(items.size());
		for (const entry of items) {
			encodeValue(item, entry, writer);
		}
	} else if (typeName === "object") {
		const fields = schema.fields;
		if (fields === undefined) {
			throw "Aruna binary encode: object schema is missing its fields.";
		}
		const record = value as { [key: string]: unknown };
		for (const key of sortedKeys(fields)) {
			const fieldSchema = fields[key];
			if (fieldSchema !== undefined) {
				encodeValue(fieldSchema, record[key], writer);
			}
		}
	} else if (typeName === "optional") {
		const inner = schema.inner;
		if (inner === undefined) {
			throw "Aruna binary encode: optional schema is missing its inner.";
		}
		if (value === undefined) {
			writer.writeU8(0);
		} else {
			writer.writeU8(1);
			encodeValue(inner, value, writer);
		}
	} else if (typeName === "record") {
		// u32 entry count, then key/value pairs sorted by key — byte-identical to
		// the reference codec.
		const valueSchema = schema.item;
		if (valueSchema === undefined) {
			throw "Aruna binary encode: record schema is missing its value schema.";
		}
		const record = value as { [key: string]: unknown };
		const keys: Array<string> = [];
		for (const [key] of pairs(record)) {
			keys.push(key as string);
		}
		keys.sort();
		writer.writeU32(keys.size());
		for (const key of keys) {
			writer.writeString(key);
			encodeValue(valueSchema, record[key], writer);
		}
	} else if (typeName === "tuple") {
		// Fixed sequence — the length is part of the schema, nothing on the wire.
		const itemSchemas = schema.items;
		if (itemSchemas === undefined) {
			throw "Aruna binary encode: tuple schema is missing its items.";
		}
		const items = value as Array<unknown>;
		for (let i = 0; i < itemSchemas.size(); i++) {
			const itemSchema = itemSchemas[i];
			if (itemSchema !== undefined) {
				encodeValue(itemSchema, items[i], writer);
			}
		}
	} else if (typeName === "enum") {
		const values = schema.values;
		if (values === undefined) {
			throw "Aruna binary encode: enum schema is missing its values.";
		}
		let index = -1;
		for (let i = 0; i < values.size(); i++) {
			if (values[i] === value) {
				index = i;
				break;
			}
		}
		if (index < 0) {
			throw "Aruna binary encode: value is not a member of the enum schema.";
		}
		writer.writeU32(index);
	} else if (typeName === "union") {
		const members = schema.members;
		if (members === undefined) {
			throw "Aruna binary encode: union schema is missing its members.";
		}
		let matched: Schema | undefined;
		let index = -1;
		for (let i = 0; i < members.size(); i++) {
			const member = members[i];
			if (member !== undefined && member.validate(value)) {
				matched = member;
				index = i;
				break;
			}
		}
		if (matched === undefined) {
			throw "Aruna binary encode: value matches no union member.";
		}
		writer.writeU32(index);
		encodeValue(matched, value, writer);
	} else if (typeName === "vector3") {
		const vector = value as Vector3;
		writer.writeF32(vector.X);
		writer.writeF32(vector.Y);
		writer.writeF32(vector.Z);
	} else if (typeName === "color3") {
		const color = value as Color3;
		writer.writeF32(color.R);
		writer.writeF32(color.G);
		writer.writeF32(color.B);
	} else if (typeName === "cframe") {
		const [x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22] = (
			value as CFrame
		).GetComponents();
		writer.writeF32(x);
		writer.writeF32(y);
		writer.writeF32(z);
		writer.writeF32(r00);
		writer.writeF32(r01);
		writer.writeF32(r02);
		writer.writeF32(r10);
		writer.writeF32(r11);
		writer.writeF32(r12);
		writer.writeF32(r20);
		writer.writeF32(r21);
		writer.writeF32(r22);
	} else {
		throw "Aruna binary encode: unsupported schema kind.";
	}
}

function decodeValue(schema: Schema, reader: BinaryReader): unknown {
	const typeName = schema.typeName;
	if (typeName === "string") {
		return reader.readString();
	} else if (typeName === "number") {
		return reader.readNumber(schema.format ?? "f64");
	} else if (typeName === "boolean") {
		return reader.readBool();
	} else if (typeName === "literal") {
		return schema.value as SchemaLiteral;
	} else if (typeName === "array") {
		const item = schema.item;
		if (item === undefined) {
			throw "Aruna binary decode: array schema is missing its item.";
		}
		const count = reader.readU32();
		const items = new Array<defined>();
		for (let i = 0; i < count; i++) {
			items.push(decodeValue(item, reader) as defined);
		}
		return items;
	} else if (typeName === "object") {
		const fields = schema.fields;
		if (fields === undefined) {
			throw "Aruna binary decode: object schema is missing its fields.";
		}
		const record: { [key: string]: unknown } = {};
		for (const key of sortedKeys(fields)) {
			const fieldSchema = fields[key];
			if (fieldSchema === undefined) {
				continue;
			}
			const decoded = decodeValue(fieldSchema, reader);
			if (!(fieldSchema.typeName === "optional" && decoded === undefined)) {
				record[key] = decoded;
			}
		}
		return record;
	} else if (typeName === "optional") {
		const inner = schema.inner;
		if (inner === undefined) {
			throw "Aruna binary decode: optional schema is missing its inner.";
		}
		const present = reader.readU8();
		if (present === 0) {
			return undefined;
		}
		return decodeValue(inner, reader);
	} else if (typeName === "record") {
		const valueSchema = schema.item;
		if (valueSchema === undefined) {
			throw "Aruna binary decode: record schema is missing its value schema.";
		}
		const count = reader.readU32();
		const record: { [key: string]: unknown } = {};
		for (let i = 0; i < count; i++) {
			const key = reader.readString();
			record[key] = decodeValue(valueSchema, reader);
		}
		return record;
	} else if (typeName === "tuple") {
		const itemSchemas = schema.items;
		if (itemSchemas === undefined) {
			throw "Aruna binary decode: tuple schema is missing its items.";
		}
		const items = new Array<defined>();
		for (const itemSchema of itemSchemas) {
			items.push(decodeValue(itemSchema, reader) as defined);
		}
		return items;
	} else if (typeName === "enum") {
		const values = schema.values;
		if (values === undefined) {
			throw "Aruna binary decode: enum schema is missing its values.";
		}
		const index = reader.readU32();
		if (index >= values.size()) {
			throw "Aruna binary decode: enum index out of range.";
		}
		return values[index];
	} else if (typeName === "union") {
		const members = schema.members;
		if (members === undefined) {
			throw "Aruna binary decode: union schema is missing its members.";
		}
		const index = reader.readU32();
		const member = members[index];
		if (member === undefined) {
			throw "Aruna binary decode: union member index out of range.";
		}
		return decodeValue(member, reader);
	} else if (typeName === "vector3") {
		const x = reader.readF32();
		const y = reader.readF32();
		const z = reader.readF32();
		return new Vector3(x, y, z);
	} else if (typeName === "color3") {
		const r = reader.readF32();
		const g = reader.readF32();
		const b = reader.readF32();
		return new Color3(r, g, b);
	} else if (typeName === "cframe") {
		const x = reader.readF32();
		const y = reader.readF32();
		const z = reader.readF32();
		const r00 = reader.readF32();
		const r01 = reader.readF32();
		const r02 = reader.readF32();
		const r10 = reader.readF32();
		const r11 = reader.readF32();
		const r12 = reader.readF32();
		const r20 = reader.readF32();
		const r21 = reader.readF32();
		const r22 = reader.readF32();
		return new CFrame(x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22);
	}
	throw "Aruna binary decode: unsupported schema kind.";
}

function literalTag(value: unknown): string {
	if (value === undefined) {
		return "undefined:undefined";
	}
	if (typeIs(value, "string")) {
		return `string:${value}`;
	}
	if (typeIs(value, "number")) {
		return `number:${tostring(value)}`;
	}
	if (typeIs(value, "boolean")) {
		return `boolean:${tostring(value)}`;
	}
	throw "Aruna schema fingerprint: unsupported literal value.";
}

// Canonical layout string. MUST stay byte-identical with the Node reference
// runtime's schemaLayoutString — the fingerprint only works as a cross-version
// guard if both runtimes derive the same string for the same schema.
function schemaLayoutString(schema: Schema): string {
	const typeName = schema.typeName;
	if (typeName === "string") {
		return "s";
	} else if (typeName === "number") {
		return `n:${schema.format ?? "f64"}`;
	} else if (typeName === "boolean") {
		return "b";
	} else if (typeName === "literal") {
		return `l:${literalTag(schema.value)}`;
	} else if (typeName === "array") {
		if (schema.item === undefined) {
			throw "Aruna schema fingerprint: array schema is missing its item.";
		}
		return `a(${schemaLayoutString(schema.item)})`;
	} else if (typeName === "object") {
		const fields = schema.fields;
		if (fields === undefined) {
			throw "Aruna schema fingerprint: object schema is missing its fields.";
		}
		const parts: Array<string> = [];
		for (const key of sortedKeys(fields)) {
			const fieldSchema = fields[key];
			if (fieldSchema !== undefined) {
				parts.push(`${key}:${schemaLayoutString(fieldSchema)}`);
			}
		}
		return `o(${parts.join(",")})`;
	} else if (typeName === "optional") {
		if (schema.inner === undefined) {
			throw "Aruna schema fingerprint: optional schema is missing its inner.";
		}
		return `?(${schemaLayoutString(schema.inner)})`;
	} else if (typeName === "record") {
		if (schema.item === undefined) {
			throw "Aruna schema fingerprint: record schema is missing its value schema.";
		}
		return `r(${schemaLayoutString(schema.item)})`;
	} else if (typeName === "tuple") {
		const items = schema.items;
		if (items === undefined) {
			throw "Aruna schema fingerprint: tuple schema is missing its items.";
		}
		const parts: Array<string> = [];
		for (const item of items) {
			parts.push(schemaLayoutString(item));
		}
		return `t(${parts.join(",")})`;
	} else if (typeName === "enum") {
		const values = schema.values;
		if (values === undefined) {
			throw "Aruna schema fingerprint: enum schema is missing its values.";
		}
		return `e(${values.join("|")})`;
	} else if (typeName === "union") {
		const members = schema.members;
		if (members === undefined) {
			throw "Aruna schema fingerprint: union schema is missing its members.";
		}
		const parts: Array<string> = [];
		for (const member of members) {
			parts.push(schemaLayoutString(member));
		}
		return `u(${parts.join("|")})`;
	} else if (typeName === "vector3") {
		return "v3";
	} else if (typeName === "color3") {
		return "c3";
	} else if (typeName === "cframe") {
		return "cf";
	}
	throw "Aruna schema fingerprint: unsupported schema kind.";
}

// Deterministic 32-bit fingerprint of a schema's wire layout. djb2 over the
// canonical layout string, using only plain arithmetic (exact in doubles) so
// Node and Luau produce the identical value for the identical schema.
export function schemaFingerprint(schema: Schema): number {
	const layout = schemaLayoutString(schema);
	let hash = 5381;
	for (let index = 1; index <= layout.size(); index += 1) {
		const [code] = layout.byte(index);
		hash = (hash * 33 + (code ?? 0)) % 4294967296;
	}
	return hash;
}

export function encodeBinary(schema: Schema, value: unknown): buffer {
	const writer = new BinaryWriter(64);
	writer.writeU32(schemaFingerprint(schema));
	encodeValue(schema, value, writer);
	return writer.finish();
}

export function decodeBinary(schema: Schema, buf: buffer): unknown {
	const reader = new BinaryReader(buf);
	const expected = schemaFingerprint(schema);
	const actual = reader.readU32();
	if (actual !== expected) {
		throw `Aruna binary decode schema mismatch: payload fingerprint ${actual} does not match this schema (${expected}); the peer encoded with a different schema version.`;
	}
	return decodeValue(schema, reader);
}
