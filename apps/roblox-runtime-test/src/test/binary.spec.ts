// The schema-driven binary codec (roblox/binary.ts) over Luau `buffer`. Port of
// packages/aruna/test/binary.test.ts. The Node codec's bytes are byte-identical
// to this one, so byte counts and the pinned fingerprint carry over unchanged.
// Roblox userdata kinds take the native value types (Vector3, Color3, …) where
// the Node runtime took plain `{ x, y, z }` shapes.
import { decodeBinary, encodeBinary, schemaFingerprint } from "aruna/internal/binary";
import { schema, type Schema } from "aruna/schema";
import { describe, expect, it } from "aruna/testing";

function roundTrip(s: Schema, value: unknown): unknown {
  return decodeBinary(s, encodeBinary(s, value));
}

function sameBytes(left: buffer, right: buffer): boolean {
  return buffer.tostring(left) === buffer.tostring(right);
}

function bytesOf(values: Array<number>): buffer {
  const out = buffer.create(values.size());
  values.forEach((value, index) => buffer.writeu8(out, index, value));
  return out;
}

function prefix(source: buffer, length: number): buffer {
  const out = buffer.create(length);
  buffer.copy(out, 0, source, 0, length);
  return out;
}

const HttpService = game.GetService("HttpService");

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
    expect(buffer.len(bytes)).toBe(4); // frame header only
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
    expect(sameBytes(encodeBinary(s, value), encodeBinary(s, reordered))).toBe(true);
  });

  it("round trips records with deterministic key order", () => {
    const s = schema.record(schema.number());
    const value = { sword: 1, shield: 2, potion: 3 };
    expect(roundTrip(s, value)).toEqual(value);
    expect(roundTrip(s, {})).toEqual({});

    // Insertion order in the input must not change the bytes.
    const reordered = { potion: 3, sword: 1, shield: 2 };
    expect(sameBytes(encodeBinary(s, value), encodeBinary(s, reordered))).toBe(true);
  });

  it("round trips tuples as a fixed sequence without a length prefix", () => {
    const s = schema.tuple([schema.string(), schema.u8(), schema.boolean()]);
    expect(roundTrip(s, ["sword", 3, true])).toEqual(["sword", 3, true]);

    // 4-byte frame header + string("ab") = u32 len + 2 bytes = 6, u8 = 1, bool = 1.
    expect(buffer.len(encodeBinary(s, ["ab", 7, false]))).toBe(12);
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
    const absent = roundTrip(s, { name: "Ada" }) as { [key: string]: unknown };
    expect(absent).toEqual({ name: "Ada" });
    // A Luau table has no "own but nil" key: an absent field is a nil key.
    let hasNickname = false;
    for (const [key] of pairs(absent)) {
      if (key === "nickname") {
        hasNickname = true;
      }
    }
    expect(hasNickname).toBe(false);
  });

  it("round trips enums by index", () => {
    const s = schema.enum(["idle", "running", "done"]);
    expect(roundTrip(s, "running")).toBe("running");
    expect(roundTrip(s, "idle")).toBe("idle");
  });

  it("round trips unions by member tag", () => {
    const s = schema.union([schema.string(), schema.number()]);
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
    const s = schema.array(
      schema.object({
        hp: schema.number(),
        alive: schema.boolean(),
      }),
    );
    const value = new Array<{ hp: number; alive: boolean }>();
    for (let index = 0; index < 50; index += 1) {
      value.push({ hp: index, alive: index % 2 === 0 });
    }
    const binary = buffer.len(encodeBinary(s, value));
    // `.size()` of a Luau string is its byte length.
    const json = HttpService.JSONEncode(value).size();
    // 4-byte frame header + 4-byte count + 50 * (8-byte hp + 1-byte alive) = 458 bytes.
    expect(binary).toBe(458);
    expect(binary < json).toBe(true);
  });

  it("throws on an enum value outside the schema", () => {
    const s = schema.enum(["a", "b"]);
    expect(() => encodeBinary(s, "c")).toThrow("not a member of the enum");
  });

  it("throws when decoding past the end of the buffer", () => {
    const s = schema.number();
    expect(() => decodeBinary(s, bytesOf([1, 2]))).toThrow("past the end");

    // A valid header followed by a truncated payload also fails loudly.
    const truncated = prefix(encodeBinary(schema.string(), "hello"), 6);
    expect(() => decodeBinary(schema.string(), truncated)).toThrow("past the end");
  });
});

describe("schema fingerprint framing", () => {
  it("rejects a payload encoded with a different schema", () => {
    const v1 = schema.object({ hp: schema.number() });
    const v2 = schema.object({ armor: schema.number(), hp: schema.number() });
    const bytes = encodeBinary(v1, { hp: 10 });

    expect(() => decodeBinary(v2, bytes)).toThrow("schema mismatch");
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
    const s = schema.object({
      hp: schema.u16(),
      name: schema.string(),
      tags: schema.array(schema.string()),
      pos: schema.vector3(),
    });
    expect(schemaFingerprint(s)).toBe(2935581200);
  });
});

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
    expect(buffer.len(encodeBinary(schema.u8(), 1))).toBe(4 + 1);
    expect(buffer.len(encodeBinary(schema.i8(), 1))).toBe(4 + 1);
    expect(buffer.len(encodeBinary(schema.u16(), 1))).toBe(4 + 2);
    expect(buffer.len(encodeBinary(schema.i16(), 1))).toBe(4 + 2);
    expect(buffer.len(encodeBinary(schema.u32(), 1))).toBe(4 + 4);
    expect(buffer.len(encodeBinary(schema.f32(), 1))).toBe(4 + 4);
    expect(buffer.len(encodeBinary(schema.number(), 1))).toBe(4 + 8);
  });

  it("shrinks a struct array when widths are tightened", () => {
    const wide = schema.array(schema.object({ hp: schema.number(), team: schema.number() }));
    const tight = schema.array(schema.object({ hp: schema.u16(), team: schema.u8() }));
    const value = new Array<{ hp: number; team: number }>();
    for (let index = 0; index < 50; index += 1) {
      value.push({ hp: index, team: index % 4 });
    }
    // header 4 + count 4 + 50*(8+8) = 808; header 4 + count 4 + 50*(2+1) = 158.
    expect(buffer.len(encodeBinary(wide, value))).toBe(808);
    expect(buffer.len(encodeBinary(tight, value))).toBe(158);
  });

  it("validates integer width ranges and integrality", () => {
    expect(schema.u8().validate(255)).toBe(true);
    expect(schema.u8().validate(256)).toBe(false);
    expect(schema.u8().validate(-1)).toBe(false);
    expect(schema.u8().validate(1.5)).toBe(false);
    expect(schema.i8().validate(-128)).toBe(true);
    expect(schema.i8().validate(-129)).toBe(false);
    expect(schema.i16().validate(32767)).toBe(true);
    expect(schema.i16().validate(32768)).toBe(false);
    // float formats accept any finite number.
    expect(schema.f32().validate(1.5)).toBe(true);
    expect(schema.number().validate(1.5)).toBe(true);
  });
});

describe("Roblox userdata kinds", () => {
  it("round trips vector3/color3/cframe as f32 components", () => {
    // f32-exact values so the round trip is bit-for-bit.
    const vector = roundTrip(schema.vector3(), new Vector3(1.5, -2.25, 0.5)) as Vector3;
    expect(typeOf(vector)).toBe("Vector3");
    expect(vector).toEqual(new Vector3(1.5, -2.25, 0.5));
    expect(vector.X).toBe(1.5);
    expect(vector.Y).toBe(-2.25);
    expect(vector.Z).toBe(0.5);

    const color = roundTrip(schema.color3(), new Color3(0.25, 0.5, 1)) as Color3;
    expect(typeOf(color)).toBe("Color3");
    expect(color.R).toBe(0.25);
    expect(color.G).toBe(0.5);
    expect(color.B).toBe(1);

    const components = [1.5, 2, -0.5, 1, 0, 0, 0, 1, 0, 0, 0, 1];
    const source = new CFrame(1.5, 2, -0.5, 1, 0, 0, 0, 1, 0, 0, 0, 1);
    const frame = roundTrip(schema.cframe(), source) as CFrame;
    expect(typeOf(frame)).toBe("CFrame");
    expect([...frame.GetComponents()]).toEqual(components);
  });

  it("packs each userdata kind to its declared byte count", () => {
    expect(buffer.len(encodeBinary(schema.vector3(), new Vector3(0, 0, 0)))).toBe(4 + 12);
    expect(buffer.len(encodeBinary(schema.color3(), new Color3(0, 0, 0)))).toBe(4 + 12);
    expect(
      buffer.len(encodeBinary(schema.cframe(), new CFrame(0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1))),
    ).toBe(4 + 48);
  });

  it("validates userdata shapes", () => {
    expect(schema.vector3().validate(new Vector3(1, 2, 3))).toBe(true);
    // The Node runtime's "missing component" shape; natively anything that is
    // not a Vector3 (a plain table, a Vector2) is rejected.
    expect(schema.vector3().validate({ x: 1, y: 2 })).toBe(false);
    expect(schema.vector3().validate(new Vector2(1, 2))).toBe(false);
    expect(schema.color3().validate(new Color3(0, 0.5, 1))).toBe(true);
    expect(schema.cframe().validate(new CFrame(0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1))).toBe(true);
    // Wrong component count is rejected: natively, a value that is not a CFrame.
    expect(schema.cframe().validate({ components: [0, 0, 0] })).toBe(false);
    expect(schema.cframe().validate(new Vector3(0, 0, 0))).toBe(false);
  });

  it("round trips vector2/udim/udim2", () => {
    const vector = roundTrip(schema.vector2(), new Vector2(1.5, -2.25)) as Vector2;
    expect(typeOf(vector)).toBe("Vector2");
    expect(vector).toEqual(new Vector2(1.5, -2.25));
    // scale is f32, offset is i32 — both exact for these values.
    const udim = roundTrip(schema.udim(), new UDim(0.5, -40)) as UDim;
    expect(typeOf(udim)).toBe("UDim");
    expect(udim.Scale).toBe(0.5);
    expect(udim.Offset).toBe(-40);
    const udim2 = roundTrip(schema.udim2(), new UDim2(0.25, 12, 1, -8)) as UDim2;
    expect(typeOf(udim2)).toBe("UDim2");
    expect(udim2.X.Scale).toBe(0.25);
    expect(udim2.X.Offset).toBe(12);
    expect(udim2.Y.Scale).toBe(1);
    expect(udim2.Y.Offset).toBe(-8);
  });

  it("packs each 2D userdata kind to its declared byte count", () => {
    // vector2 = 2 x f32; udim = f32 + i32; udim2 = 2 x udim.
    expect(buffer.len(encodeBinary(schema.vector2(), new Vector2(0, 0)))).toBe(4 + 8);
    expect(buffer.len(encodeBinary(schema.udim(), new UDim(0, 0)))).toBe(4 + 8);
    expect(buffer.len(encodeBinary(schema.udim2(), new UDim2(0, 0, 0, 0)))).toBe(4 + 16);
  });

  it("validates 2D userdata shapes", () => {
    expect(schema.vector2().validate(new Vector2(1, 2))).toBe(true);
    expect(schema.vector2().validate({ x: 1 })).toBe(false);
    expect(schema.vector2().validate(new Vector3(1, 2, 3))).toBe(false);
    expect(schema.udim().validate(new UDim(0.5, 10))).toBe(true);
    expect(schema.udim().validate({ scale: 0.5 })).toBe(false);
    expect(schema.udim2().validate(new UDim2(0, 0, 1, 4))).toBe(true);
    expect(schema.udim2().validate({ x: { scale: 0, offset: 0 } })).toBe(false);
    expect(schema.udim2().validate(new UDim(0, 0))).toBe(false);
  });

  it("round trips DateTime and BrickColor", () => {
    // Encoding reads UnixTimestampMillis off a DateTime; decoding rebuilds one
    // with DateTime.fromUnixTimestampMillis. (Under Lune the spec runner's
    // DateTime global is a plain-table fake — Lune cannot construct one — so
    // this checks the codec, not the userdata type.)
    const moment = roundTrip(
      schema.dateTime(),
      DateTime.fromUnixTimestampMillis(1700000000000),
    ) as DateTime;
    expect(moment.UnixTimestampMillis).toBe(1700000000000);
    const color = roundTrip(schema.brickColor(), new BrickColor(194)) as BrickColor;
    expect(typeOf(color)).toBe("BrickColor");
    expect(color.Number).toBe(194);
  });

  it("packs DateTime (f64) and BrickColor (u16) to their byte counts", () => {
    expect(buffer.len(encodeBinary(schema.dateTime(), DateTime.fromUnixTimestampMillis(0)))).toBe(
      4 + 8,
    );
    expect(buffer.len(encodeBinary(schema.brickColor(), new BrickColor(1)))).toBe(4 + 2);
  });

  it("validates DateTime/BrickColor/Instance shapes", () => {
    // Not portable here: the positive DateTime and Instance cases. Natively both
    // validate by `typeof`, and a compiled spec under Lune can reach no value
    // whose typeof is "DateTime" or "Instance" (the runner's DateTime and
    // Instance globals are plain-table fakes). The Instance case runs in
    // lune/specs/schema.luau with a real @lune/roblox Instance.
    expect(schema.dateTime().validate({})).toBe(false);
    expect(schema.dateTime().validate({ UnixTimestampMillis: 1 })).toBe(false);
    expect(schema.brickColor().validate(new BrickColor(1))).toBe(true);
    expect(schema.brickColor().validate({ Number: 1 })).toBe(false);
    // The Node runtime accepted an Instance-like shape; natively the value must
    // be a real Instance, so the same shape is rejected.
    expect(schema.instance().validate({})).toBe(false);
    expect(schema.instance().validate({ IsA: () => true, ClassName: "Part" })).toBe(false);
  });

  it("refuses to binary-encode an Instance schema", () => {
    const part = new Instance("RemoteEvent");
    expect(() => encodeBinary(schema.instance(), part)).toThrow(
      "Instance schemas cannot be binary-encoded",
    );
  });
});
