// Aruna Node reference runtime — schema-driven binary codec.
//
// Encodes a value into a tightly packed byte buffer using its schema as the
// layout, and decodes it back. Because both sides share the schema, no field
// names, type tags, or framing travel on the wire — only the payload bytes.
// This is the bandwidth-saving counterpart to the plain-data table transport.
//
// Layout per schema kind:
//   string   u32 length prefix + UTF-8 bytes
//   number   f64 (8 bytes)
//   boolean  u8 (0 | 1)
//   literal  0 bytes (value is recovered from the schema)
//   array    u32 count + each item
//   object   each field encoded in sorted key order
//   optional u8 present flag + inner when present
//   enum     u32 index into the schema's values
//   union    u32 member index + the matching member's encoding
//   vector3  3 x f32 (x, y, z)
//   color3   3 x f32 (r, g, b)
//   cframe   12 x f32 (CFrame:GetComponents() order)
//
// The encoder assumes the value already matches the schema (the action and
// signal boundaries validate before encoding). Mismatches throw rather than
// emit a corrupt buffer.

import {
  validateSchema,
  type CFrameValue,
  type Color3Value,
  type NumberFormat,
  type Schema,
  type SchemaLiteral,
  type Vector3Value,
} from "../schema/index.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

class BinaryWriter {
  private bytes: Uint8Array;
  private view: DataView;
  private offset = 0;

  constructor(initialCapacity = 64) {
    this.bytes = new Uint8Array(initialCapacity);
    this.view = new DataView(this.bytes.buffer);
  }

  private ensure(extra: number): void {
    const required = this.offset + extra;

    if (required <= this.bytes.length) {
      return;
    }

    let capacity = this.bytes.length * 2;
    while (capacity < required) {
      capacity *= 2;
    }

    const grown = new Uint8Array(capacity);
    // Manual copy rather than grown.set(this.bytes): @rbxts/types is loaded
    // globally in this project and shadows the lib `ArrayLike`, which breaks the
    // typed-array .set() overload here.
    for (let index = 0; index < this.offset; index += 1) {
      grown[index] = this.bytes[index] as number;
    }
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }

  writeU8(value: number): void {
    this.ensure(1);
    this.view.setUint8(this.offset, value & 0xff);
    this.offset += 1;
  }

  writeU32(value: number): void {
    this.ensure(4);
    this.view.setUint32(this.offset, value >>> 0, true);
    this.offset += 4;
  }

  writeF64(value: number): void {
    this.ensure(8);
    this.view.setFloat64(this.offset, value, true);
    this.offset += 8;
  }

  writeF32(value: number): void {
    this.ensure(4);
    this.view.setFloat32(this.offset, value, true);
    this.offset += 4;
  }

  writeU16(value: number): void {
    this.ensure(2);
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
  }

  writeI8(value: number): void {
    this.ensure(1);
    this.view.setInt8(this.offset, value);
    this.offset += 1;
  }

  writeI16(value: number): void {
    this.ensure(2);
    this.view.setInt16(this.offset, value, true);
    this.offset += 2;
  }

  writeI32(value: number): void {
    this.ensure(4);
    this.view.setInt32(this.offset, value, true);
    this.offset += 4;
  }

  writeNumber(value: number, format: NumberFormat): void {
    switch (format) {
      case "f64":
        this.writeF64(value);
        return;
      case "f32":
        this.writeF32(value);
        return;
      case "u8":
        this.writeU8(value);
        return;
      case "u16":
        this.writeU16(value);
        return;
      case "u32":
        this.writeU32(value);
        return;
      case "i8":
        this.writeI8(value);
        return;
      case "i16":
        this.writeI16(value);
        return;
      case "i32":
        this.writeI32(value);
        return;
      default:
        throw new Error("Aruna binary encode: unsupported number format.");
    }
  }

  writeBool(value: boolean): void {
    this.writeU8(value ? 1 : 0);
  }

  writeString(value: string): void {
    const encoded = textEncoder.encode(value);
    this.writeU32(encoded.length);
    this.ensure(encoded.length);
    for (let index = 0; index < encoded.length; index += 1) {
      this.view.setUint8(this.offset + index, encoded[index] as number);
    }
    this.offset += encoded.length;
  }

  toBytes(): Uint8Array {
    return this.bytes.slice(0, this.offset);
  }
}

class BinaryReader {
  private readonly view: DataView;
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private require(extra: number): void {
    if (this.offset + extra > this.bytes.byteLength) {
      throw new Error("Aruna binary decode ran past the end of the buffer.");
    }
  }

  readU8(): number {
    this.require(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  readU32(): number {
    this.require(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readF64(): number {
    this.require(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  readF32(): number {
    this.require(4);
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readU16(): number {
    this.require(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  readI8(): number {
    this.require(1);
    const value = this.view.getInt8(this.offset);
    this.offset += 1;
    return value;
  }

  readI16(): number {
    this.require(2);
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  readI32(): number {
    this.require(4);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readNumber(format: NumberFormat): number {
    switch (format) {
      case "f64":
        return this.readF64();
      case "f32":
        return this.readF32();
      case "u8":
        return this.readU8();
      case "u16":
        return this.readU16();
      case "u32":
        return this.readU32();
      case "i8":
        return this.readI8();
      case "i16":
        return this.readI16();
      case "i32":
        return this.readI32();
      default:
        throw new Error("Aruna binary decode: unsupported number format.");
    }
  }

  readBool(): boolean {
    return this.readU8() !== 0;
  }

  readString(): string {
    const length = this.readU32();
    this.require(length);
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return textDecoder.decode(slice);
  }
}

function encodeValue(schema: Schema, value: unknown, writer: BinaryWriter): void {
  switch (schema.kind) {
    case "string":
      writer.writeString(value as string);
      return;
    case "number":
      writer.writeNumber(value as number, schema.format);
      return;
    case "boolean":
      writer.writeBool(value as boolean);
      return;
    case "literal":
      // Recovered from the schema on decode; nothing travels on the wire.
      return;
    case "array": {
      const items = value as readonly unknown[];
      writer.writeU32(items.length);
      for (const item of items) {
        encodeValue(schema.item, item, writer);
      }
      return;
    }
    case "object": {
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(schema.shape).sort()) {
        const fieldSchema = schema.shape[key];
        if (fieldSchema !== undefined) {
          encodeValue(fieldSchema, record[key], writer);
        }
      }
      return;
    }
    case "optional": {
      if (value === undefined) {
        writer.writeU8(0);
        return;
      }
      writer.writeU8(1);
      encodeValue(schema.inner, value, writer);
      return;
    }
    case "record": {
      // u32 entry count, then key/value pairs sorted by key so the encoding is
      // deterministic and byte-identical across runtimes.
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      writer.writeU32(keys.length);
      for (const key of keys) {
        writer.writeString(key);
        encodeValue(schema.value, record[key], writer);
      }
      return;
    }
    case "tuple": {
      // Fixed sequence — the length is part of the schema, nothing on the wire.
      const items = value as readonly unknown[];
      for (let index = 0; index < schema.items.length; index += 1) {
        const itemSchema = schema.items[index];
        if (itemSchema !== undefined) {
          encodeValue(itemSchema, items[index], writer);
        }
      }
      return;
    }
    case "enum": {
      const index = schema.values.findIndex((candidate) => Object.is(candidate, value));
      if (index < 0) {
        throw new Error("Aruna binary encode: value is not a member of the enum schema.");
      }
      writer.writeU32(index);
      return;
    }
    case "union": {
      const index = schema.members.findIndex(
        (member) => validateSchema(member, value).ok,
      );
      if (index < 0) {
        throw new Error("Aruna binary encode: value matches no union member.");
      }
      writer.writeU32(index);
      const member = schema.members[index];
      if (member !== undefined) {
        encodeValue(member, value, writer);
      }
      return;
    }
    case "vector3": {
      const vector = value as Vector3Value;
      writer.writeF32(vector.x);
      writer.writeF32(vector.y);
      writer.writeF32(vector.z);
      return;
    }
    case "color3": {
      const color = value as Color3Value;
      writer.writeF32(color.r);
      writer.writeF32(color.g);
      writer.writeF32(color.b);
      return;
    }
    case "cframe": {
      const cframe = value as CFrameValue;
      for (const component of cframe.components) {
        writer.writeF32(component);
      }
      return;
    }
    default:
      throw new Error("Aruna binary encode: unsupported schema kind.");
  }
}

function decodeValue(schema: Schema, reader: BinaryReader): unknown {
  switch (schema.kind) {
    case "string":
      return reader.readString();
    case "number":
      return reader.readNumber(schema.format);
    case "boolean":
      return reader.readBool();
    case "literal":
      return (schema.value as SchemaLiteral);
    case "array": {
      const count = reader.readU32();
      const items: unknown[] = [];
      for (let index = 0; index < count; index += 1) {
        items.push(decodeValue(schema.item, reader));
      }
      return items;
    }
    case "object": {
      const record: Record<string, unknown> = {};
      for (const key of Object.keys(schema.shape).sort()) {
        const fieldSchema = schema.shape[key];
        if (fieldSchema !== undefined) {
          const decoded = decodeValue(fieldSchema, reader);
          // Preserve "absent" optionals as missing keys rather than undefined
          // values so decoded objects match the encoder's input shape.
          if (!(fieldSchema.kind === "optional" && decoded === undefined)) {
            record[key] = decoded;
          }
        }
      }
      return record;
    }
    case "optional": {
      const present = reader.readU8();
      if (present === 0) {
        return undefined;
      }
      return decodeValue(schema.inner, reader);
    }
    case "record": {
      const count = reader.readU32();
      const record: Record<string, unknown> = {};
      for (let index = 0; index < count; index += 1) {
        const key = reader.readString();
        record[key] = decodeValue(schema.value, reader);
      }
      return record;
    }
    case "tuple": {
      const items: unknown[] = [];
      for (const itemSchema of schema.items) {
        items.push(decodeValue(itemSchema, reader));
      }
      return items;
    }
    case "enum": {
      const index = reader.readU32();
      const value = schema.values[index];
      if (value === undefined && index >= schema.values.length) {
        throw new Error("Aruna binary decode: enum index out of range.");
      }
      return value;
    }
    case "union": {
      const index = reader.readU32();
      const member = schema.members[index];
      if (member === undefined) {
        throw new Error("Aruna binary decode: union member index out of range.");
      }
      return decodeValue(member, reader);
    }
    case "vector3": {
      const x = reader.readF32();
      const y = reader.readF32();
      const z = reader.readF32();
      return { x, y, z } satisfies Vector3Value;
    }
    case "color3": {
      const r = reader.readF32();
      const g = reader.readF32();
      const b = reader.readF32();
      return { r, g, b } satisfies Color3Value;
    }
    case "cframe": {
      const components: number[] = [];
      for (let index = 0; index < 12; index += 1) {
        components.push(reader.readF32());
      }
      return { components } satisfies CFrameValue;
    }
    default:
      throw new Error("Aruna binary decode: unsupported schema kind.");
  }
}

// Encode a schema-conforming value into a packed byte buffer.
export function encodeBinary(schema: Schema, value: unknown): Uint8Array {
  const writer = new BinaryWriter();
  encodeValue(schema, value, writer);
  return writer.toBytes();
}

// Decode a packed byte buffer produced by encodeBinary against the same schema.
export function decodeBinary(schema: Schema, bytes: Uint8Array): unknown {
  return decodeValue(schema, new BinaryReader(bytes));
}
