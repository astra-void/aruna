import { describe, expect, it } from "vitest";
import { decodeBinary, encodeBinary, schemaFingerprint } from "../src/runtime/binary.js";
import { schema, validateSchema } from "../src/schema.js";

function roundTrip(s: Parameters<typeof encodeBinary>[0], value: unknown): unknown {
  return decodeBinary(s, encodeBinary(s, value));
}

describe("binary codec round trips", () => {
  it("round trips primitives", () => {
    expect(roundTrip(schema.string(), "hello")).toBe("hello");
    expect(roundTrip(schema.number(), 3.14159)).toBe(3.14159);
    expect(roundTrip(schema.number(), -42)).toBe(-42);
    expect(roundTrip(schema.boolean(), true)).toBe(true);
    expect(roundTrip(schema.boolean(), false)).toBe(false);
  });

  it("round trips unicode strings", () => {
    expect(roundTrip(schema.string(), "안녕하세요 🌙")).toBe("안녕하세요 🌙");
    expect(roundTrip(schema.string(), "")).toBe("");
  });

  it("round trips literals without spending bytes", () => {
    const s = schema.literal("ready");
    const bytes = encodeBinary(s, "ready");
    expect(bytes.length).toBe(4); // frame header only
    expect(decodeBinary(s, bytes)).toBe("ready");
  });

  it("round trips arrays", () => {
    const s = schema.array(schema.number());
    expect(roundTrip(s, [1, 2, 3])).toEqual([1, 2, 3]);
    expect(roundTrip(s, [])).toEqual([]);
  });

  it("round trips objects with deterministic field order", () => {
    const s = schema.object({
      amount: schema.number(),
      source: schema.string(),
      crit: schema.boolean(),
    });
    const value = { amount: 12, source: "trap", crit: true };
    expect(roundTrip(s, value)).toEqual(value);

    // Field order in the input must not change the bytes.
    const reordered = { crit: true, source: "trap", amount: 12 };
    expect(encodeBinary(s, value)).toEqual(encodeBinary(s, reordered));
  });

  it("round trips records with deterministic key order", () => {
    const s = schema.record(schema.number());
    const value = { sword: 1, shield: 2, potion: 3 };
    expect(roundTrip(s, value)).toEqual(value);
    expect(roundTrip(s, {})).toEqual({});

    // Insertion order in the input must not change the bytes.
    const reordered = { potion: 3, sword: 1, shield: 2 };
    expect(encodeBinary(s, value)).toEqual(encodeBinary(s, reordered));
  });

  it("round trips tuples as a fixed sequence without a length prefix", () => {
    const s = schema.tuple([schema.string(), schema.u8(), schema.boolean()]);
    expect(roundTrip(s, ["sword", 3, true])).toEqual(["sword", 3, true]);

    // 4-byte frame header + string("ab") = u32 len + 2 bytes = 6, u8 = 1, bool = 1.
    expect(encodeBinary(s, ["ab", 7, false]).byteLength).toBe(12);
  });

  it("round trips present and absent optionals", () => {
    const s = schema.object({
      name: schema.string(),
      nickname: schema.optional(schema.string()),
    });
    expect(roundTrip(s, { name: "Ada", nickname: "Bug" })).toEqual({
      name: "Ada",
      nickname: "Bug",
    });
    const absent = roundTrip(s, { name: "Ada" });
    expect(absent).toEqual({ name: "Ada" });
    expect(Object.prototype.hasOwnProperty.call(absent, "nickname")).toBe(false);
  });

  it("round trips enums by index", () => {
    const s = schema.enum(["idle", "running", "done"] as const);
    expect(roundTrip(s, "running")).toBe("running");
    expect(roundTrip(s, "idle")).toBe("idle");
  });

  it("round trips unions by member tag", () => {
    const s = schema.union([schema.string(), schema.number()] as const);
    expect(roundTrip(s, "text")).toBe("text");
    expect(roundTrip(s, 99)).toBe(99);
  });

  it("round trips a nested structure", () => {
    const s = schema.object({
      id: schema.string(),
      tags: schema.array(schema.string()),
      stats: schema.object({
        hp: schema.number(),
        alive: schema.boolean(),
      }),
      title: schema.optional(schema.string()),
    });
    const value = {
      id: "player-1",
      tags: ["a", "b"],
      stats: { hp: 100, alive: true },
    };
    expect(roundTrip(s, value)).toEqual(value);
  });

  it("drops repeated field names for struct arrays", () => {
    // The codec spends no bytes on field names or framing — the win over a
    // self-describing form grows with every repeated key. (Raw doubles alone are
    // not smaller than compact JSON integers; tight numeric widths are a planned
    // follow-up. This asserts the structural win that exists today.)
    const s = schema.array(
      schema.object({
        hp: schema.number(),
        alive: schema.boolean(),
      }),
    );
    const value = Array.from({ length: 50 }, (_unused, index) => ({
      hp: index,
      alive: index % 2 === 0,
    }));
    const binary = encodeBinary(s, value).length;
    const json = textByteLength(JSON.stringify(value));
    // 4-byte frame header + 4-byte count + 50 * (8-byte hp + 1-byte alive) = 458 bytes.
    expect(binary).toBe(458);
    expect(binary).toBeLessThan(json);
  });

  it("throws on an enum value outside the schema", () => {
    const s = schema.enum(["a", "b"] as const);
    expect(() => encodeBinary(s, "c")).toThrowError(/not a member of the enum/);
  });

  it("throws when decoding past the end of the buffer", () => {
    const s = schema.number();
    expect(() => decodeBinary(s, new Uint8Array([1, 2]))).toThrowError(/past the end/);

    // A valid header followed by a truncated payload also fails loudly.
    const truncated = encodeBinary(schema.string(), "hello").subarray(0, 6);
    expect(() => decodeBinary(schema.string(), truncated)).toThrowError(/past the end/);
  });
});

describe("schema fingerprint framing", () => {
  it("rejects a payload encoded with a different schema", () => {
    const v1 = schema.object({ hp: schema.number() });
    const v2 = schema.object({ armor: schema.number(), hp: schema.number() });
    const bytes = encodeBinary(v1, { hp: 10 });

    expect(() => decodeBinary(v2, bytes)).toThrowError(/schema mismatch/);
  });

  it("is stable for equal layouts and sensitive to layout changes", () => {
    const a = schema.object({ hp: schema.u16(), name: schema.string() });
    const b = schema.object({ name: schema.string(), hp: schema.u16() });
    // Key order in source does not matter — the layout is sorted.
    expect(schemaFingerprint(a)).toBe(schemaFingerprint(b));

    const widened = schema.object({ hp: schema.u32(), name: schema.string() });
    expect(schemaFingerprint(widened)).not.toBe(schemaFingerprint(a));

    const renamed = schema.object({ health: schema.u16(), name: schema.string() });
    expect(schemaFingerprint(renamed)).not.toBe(schemaFingerprint(a));
  });

  it("matches the pinned cross-runtime fingerprint", () => {
    // The same schema is pinned in the Lune harness
    // (apps/roblox-runtime-test/lune/specs/binary.luau). If either runtime's
    // canonical layout string or hash drifts, this fails on that side.
    const s = schema.object({
      hp: schema.u16(),
      name: schema.string(),
      tags: schema.array(schema.string()),
      pos: schema.vector3(),
    });
    expect(schemaFingerprint(s)).toBe(2935581200);
  });
});

function textByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

describe("numeric width hints", () => {
  it("round trips each integer and float width", () => {
    expect(roundTrip(schema.u8(), 200)).toBe(200);
    expect(roundTrip(schema.u16(), 60000)).toBe(60000);
    expect(roundTrip(schema.u32(), 4000000000)).toBe(4000000000);
    expect(roundTrip(schema.i8(), -100)).toBe(-100);
    expect(roundTrip(schema.i16(), -30000)).toBe(-30000);
    expect(roundTrip(schema.i32(), -2000000000)).toBe(-2000000000);
    expect(roundTrip(schema.f32(), 0.5)).toBe(0.5);
    expect(roundTrip(schema.number(), 3.14159)).toBe(3.14159);
  });

  it("packs each width to its declared byte count", () => {
    expect(encodeBinary(schema.u8(), 1).length).toBe(4 + 1);
    expect(encodeBinary(schema.i8(), 1).length).toBe(4 + 1);
    expect(encodeBinary(schema.u16(), 1).length).toBe(4 + 2);
    expect(encodeBinary(schema.i16(), 1).length).toBe(4 + 2);
    expect(encodeBinary(schema.u32(), 1).length).toBe(4 + 4);
    expect(encodeBinary(schema.f32(), 1).length).toBe(4 + 4);
    expect(encodeBinary(schema.number(), 1).length).toBe(4 + 8);
  });

  it("shrinks a struct array when widths are tightened", () => {
    const wide = schema.array(schema.object({ hp: schema.number(), team: schema.number() }));
    const tight = schema.array(schema.object({ hp: schema.u16(), team: schema.u8() }));
    const value = Array.from({ length: 50 }, (_unused, index) => ({
      hp: index,
      team: index % 4,
    }));
    // header 4 + count 4 + 50*(8+8) = 808; header 4 + count 4 + 50*(2+1) = 158.
    expect(encodeBinary(wide, value).length).toBe(808);
    expect(encodeBinary(tight, value).length).toBe(158);
  });

  it("validates integer width ranges and integrality", () => {
    expect(validateSchema(schema.u8(), 255).ok).toBe(true);
    expect(validateSchema(schema.u8(), 256).ok).toBe(false);
    expect(validateSchema(schema.u8(), -1).ok).toBe(false);
    expect(validateSchema(schema.u8(), 1.5).ok).toBe(false);
    expect(validateSchema(schema.i8(), -128).ok).toBe(true);
    expect(validateSchema(schema.i8(), -129).ok).toBe(false);
    expect(validateSchema(schema.i16(), 32767).ok).toBe(true);
    expect(validateSchema(schema.i16(), 32768).ok).toBe(false);
    // float formats accept any finite number.
    expect(validateSchema(schema.f32(), 1.5).ok).toBe(true);
    expect(validateSchema(schema.number(), 1.5).ok).toBe(true);
  });
});

describe("Roblox userdata kinds", () => {
  it("round trips vector3/color3/cframe as f32 components", () => {
    // f32-exact values so the round trip is bit-for-bit.
    expect(roundTrip(schema.vector3(), { x: 1.5, y: -2.25, z: 0.5 })).toEqual({
      x: 1.5,
      y: -2.25,
      z: 0.5,
    });
    expect(roundTrip(schema.color3(), { r: 0.25, g: 0.5, b: 1 })).toEqual({
      r: 0.25,
      g: 0.5,
      b: 1,
    });

    const components = [1.5, 2, -0.5, 1, 0, 0, 0, 1, 0, 0, 0, 1];
    expect(roundTrip(schema.cframe(), { components })).toEqual({ components });
  });

  it("packs each userdata kind to its declared byte count", () => {
    expect(encodeBinary(schema.vector3(), { x: 0, y: 0, z: 0 }).length).toBe(4 + 12);
    expect(encodeBinary(schema.color3(), { r: 0, g: 0, b: 0 }).length).toBe(4 + 12);
    expect(
      encodeBinary(schema.cframe(), {
        components: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      }).length,
    ).toBe(4 + 48);
  });

  it("validates userdata shapes", () => {
    expect(validateSchema(schema.vector3(), { x: 1, y: 2, z: 3 }).ok).toBe(true);
    expect(validateSchema(schema.vector3(), { x: 1, y: 2 }).ok).toBe(false);
    expect(validateSchema(schema.color3(), { r: 0, g: 0.5, b: 1 }).ok).toBe(true);
    expect(
      validateSchema(schema.cframe(), { components: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }).ok,
    ).toBe(true);
    // Wrong component count is rejected.
    expect(validateSchema(schema.cframe(), { components: [0, 0, 0] }).ok).toBe(false);
  });

  it("round trips vector2/udim/udim2", () => {
    expect(roundTrip(schema.vector2(), { x: 1.5, y: -2.25 })).toEqual({ x: 1.5, y: -2.25 });
    // scale is f32, offset is i32 — both exact for these values.
    expect(roundTrip(schema.udim(), { scale: 0.5, offset: -40 })).toEqual({
      scale: 0.5,
      offset: -40,
    });
    expect(
      roundTrip(schema.udim2(), {
        x: { scale: 0.25, offset: 12 },
        y: { scale: 1, offset: -8 },
      }),
    ).toEqual({ x: { scale: 0.25, offset: 12 }, y: { scale: 1, offset: -8 } });
  });

  it("packs each 2D userdata kind to its declared byte count", () => {
    // vector2 = 2 x f32; udim = f32 + i32; udim2 = 2 x udim.
    expect(encodeBinary(schema.vector2(), { x: 0, y: 0 }).length).toBe(4 + 8);
    expect(encodeBinary(schema.udim(), { scale: 0, offset: 0 }).length).toBe(4 + 8);
    expect(
      encodeBinary(schema.udim2(), {
        x: { scale: 0, offset: 0 },
        y: { scale: 0, offset: 0 },
      }).length,
    ).toBe(4 + 16);
  });

  it("validates 2D userdata shapes", () => {
    expect(validateSchema(schema.vector2(), { x: 1, y: 2 }).ok).toBe(true);
    expect(validateSchema(schema.vector2(), { x: 1 }).ok).toBe(false);
    expect(validateSchema(schema.udim(), { scale: 0.5, offset: 10 }).ok).toBe(true);
    expect(validateSchema(schema.udim(), { scale: 0.5 }).ok).toBe(false);
    expect(
      validateSchema(schema.udim2(), { x: { scale: 0, offset: 0 }, y: { scale: 1, offset: 4 } }).ok,
    ).toBe(true);
    expect(validateSchema(schema.udim2(), { x: { scale: 0, offset: 0 } }).ok).toBe(false);
  });
});
