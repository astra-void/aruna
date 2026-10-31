// Port of packages/aruna/test/schema.test.ts: the schema DSL — validation,
// constraints, refine, unions, defaults.
//
// The Node `validateSchema(s, v)` returns `{ ok, issues: [{ path, message }] }`.
// Its native counterpart is the pair the runtime itself uses at the action
// boundary: the schema's own boolean `validate` and `firstSchemaIssue`, which
// renders the first failing path and reason as `"<path>: <message>"` (path
// segments joined with ".", array/tuple indices as "[n]", no prefix at the root).
// `validated` below returns both, so every case checks they agree.
import { defineAction } from "aruna/roblox";
import { applyDefaults, firstSchemaIssue, schema } from "aruna/schema";
import type { Infer, Schema, SchemaLiteral } from "aruna/schema";
import { createTestPlayer, createTestServerApp, describe, expect, it } from "aruna/testing";
import { rejectionOf } from "./support";

interface Validated {
  readonly ok: boolean;
  // The rendered first issue; absent when the value conforms.
  readonly issue?: string | undefined;
}

function validated(target: Schema, value: unknown): Validated {
  return { ok: target.validate(value), issue: firstSchemaIssue(target, value) };
}

describe("schema runtime", () => {
  it("validates strings", () => {
    expect(validated(schema.string(), "hello")).toEqual({ ok: true });
    expect(validated(schema.string(), 123)).toEqual({ ok: false, issue: "expected string" });
  });

  it("validates finite numbers", () => {
    expect(validated(schema.number(), 42)).toEqual({ ok: true });
    expect(validated(schema.number(), 0 / 0)).toEqual({
      ok: false,
      issue: "expected finite number",
    });
    expect(validated(schema.number(), math.huge)).toEqual({
      ok: false,
      issue: "expected finite number",
    });
  });

  it("validates booleans", () => {
    expect(validated(schema.boolean(), true)).toEqual({ ok: true });
    expect(validated(schema.boolean(), "true")).toEqual({ ok: false, issue: "expected boolean" });
  });

  it("matches literal values exactly", () => {
    expect(validated(schema.literal("sword"), "sword")).toEqual({ ok: true });
    // The native builders are typed for string | number | boolean literals; the
    // casts pass `undefined` through as the Node case does.
    expect(validated(schema.literal(undefined as unknown as SchemaLiteral), undefined)).toEqual({
      ok: true,
    });
    // A Luau array cannot hold nil: `[undefined, "ready"]` is `{ nil, "ready" }`,
    // so the enum has no undefined member and rejects it (Node accepted it).
    expect(
      validated(
        schema.enum([undefined, "ready"] as unknown as readonly SchemaLiteral[]),
        undefined,
      ),
    ).toEqual({ ok: false, issue: "expected one of ready" });
    // Node: 'expected literal "sword"' (quoted).
    expect(validated(schema.literal("sword"), "shield")).toEqual({
      ok: false,
      issue: "expected literal sword",
    });
  });

  it("accepts any matching union member", () => {
    const idOrName = schema.union([schema.number(), schema.string()]);
    expect(validated(idOrName, 7)).toEqual({ ok: true });
    expect(validated(idOrName, "player-7")).toEqual({ ok: true });
    expect(validated(idOrName, true)).toEqual({
      ok: false,
      issue: "expected a value matching one of the union members",
    });
  });

  it("validates arrays item-by-item", () => {
    expect(validated(schema.array(schema.string()), ["one", "two"])).toEqual({ ok: true });
    expect(validated(schema.array(schema.string()), ["one", 2])).toEqual({
      ok: false,
      issue: "[1]: expected string",
    });
  });

  it("validates object properties recursively", () => {
    const purchaseItem = schema.object({
      payload: schema.object({
        itemId: schema.string(),
      }),
    });

    expect(validated(purchaseItem, { payload: { itemId: "sword" } })).toEqual({ ok: true });
    expect(validated(purchaseItem, { payload: { itemId: 123 } })).toEqual({
      ok: false,
      issue: "payload.itemId: expected string",
    });
  });

  it("validates record values against the value schema", () => {
    const counts = schema.record(schema.number());
    expect(validated(counts, { sword: 1, shield: 2 })).toEqual({ ok: true });
    expect(validated(counts, {})).toEqual({ ok: true });
    expect(validated(counts, { sword: "one" })).toEqual({
      ok: false,
      issue: "sword: expected finite number",
    });
    // Node: "expected record object".
    expect(validated(counts, "not a record")).toEqual({ ok: false, issue: "expected record" });
  });

  it("validates tuples positionally with exact length", () => {
    const pair = schema.tuple([schema.string(), schema.number()]);
    expect(validated(pair, ["sword", 3])).toEqual({ ok: true });
    // Node: "expected tuple of length 2, got 1".
    expect(validated(pair, ["sword"])).toEqual({
      ok: false,
      issue: "expected a tuple of length 2",
    });
    expect(validated(pair, ["sword", "three"])).toEqual({
      ok: false,
      issue: "[1]: expected finite number",
    });
    // Node: "expected tuple array". A keyed Luau table has an array length too.
    expect(validated(pair, { 0: "sword", 1: 3 })).toEqual({
      ok: false,
      issue: "expected a tuple of length 2",
    });
  });

  it("allows undefined for optional schemas", () => {
    const optionalName = schema.optional(schema.string());

    expect(validated(optionalName, undefined)).toEqual({ ok: true });
    expect(validated(optionalName, "Ada")).toEqual({ ok: true });
    expect(validated(optionalName, 123)).toEqual({ ok: false, issue: "expected string" });
  });

  it("validates enum values", () => {
    const size = schema.enum(["small", "medium", "large"] as const);

    expect(validated(size, "medium")).toEqual({ ok: true });
    // Node: 'expected one of "small", "medium", "large"'.
    expect(validated(size, "xl")).toEqual({
      ok: false,
      issue: "expected one of small | medium | large",
    });
  });

  // Node: `assertSchema(schema, value, { actionId, role })` throws a
  // SchemaValidationError carrying actionId, role, and issues. The native runtime
  // has no standalone assert; the same failure is raised at the action boundary
  // as an ActionValidationError whose message names the action, the role, and
  // the first issue.
  it("throws a stable validation error", async () => {
    const harness = createTestServerApp({
      actions: {
        "shop.purchaseItem": defineAction({
          id: "shop.purchaseItem",
          input: schema.string(),
          run() {
            return undefined;
          },
        }),
      },
    });
    const player = createTestPlayer();

    await expect(harness.invoke(player, "shop.purchaseItem", 42)).rejects.toThrow(
      "expected string",
    );

    const reason = await rejectionOf(harness.invoke(player, "shop.purchaseItem", 42));
    expect(reason.name).toBe("ActionValidationError");
    expect(reason.message).toBe(
      "Aruna action shop.purchaseItem input validation failed: expected string",
    );
    harness.dispose();
  });
});

describe("schema constraints and refinements", () => {
  it("enforces number min/max/int", () => {
    const level = schema.number().min(1).max(100).int();
    expect(validated(level, 50)).toEqual({ ok: true });
    expect(validated(level, 0)).toEqual({ ok: false, issue: "expected a number >= 1" });
    expect(validated(level, 101)).toEqual({ ok: false, issue: "expected a number <= 100" });
    expect(validated(level, 3.5)).toEqual({ ok: false, issue: "expected an integer" });
  });

  it("enforces string length constraints", () => {
    const username = schema.string().minLength(3).maxLength(16);
    expect(validated(username, "ada")).toEqual({ ok: true });
    expect(validated(username, "ab")).toEqual({ ok: false, issue: "expected length >= 3 bytes" });
    expect(validated(schema.string().length(4), "abcde")).toEqual({
      ok: false,
      issue: "expected length 4 bytes",
    });
  });

  it("counts maxLength / minLength / length in UTF-8 bytes, as the native runtime does", () => {
    // "가나다" is 3 characters and 9 bytes; "😀" is 1 character and 4 bytes.
    expect(validated(schema.string().maxLength(9), "가나다")).toEqual({ ok: true });
    expect(validated(schema.string().maxLength(8), "가나다")).toEqual({
      ok: false,
      issue: "expected length <= 8 bytes",
    });
    expect(validated(schema.string().minLength(4), "😀")).toEqual({ ok: true });
    expect(validated(schema.string().minLength(5), "😀").ok).toBe(false);
    expect(validated(schema.string().length(8), "a가😀")).toEqual({ ok: true });
    expect(validated(schema.string().length(3), "a가😀").ok).toBe(false);
  });

  it("counts maxChars / minChars in code points", () => {
    const name = schema.string().minChars(2).maxChars(3);
    expect(validated(name, "가나다")).toEqual({ ok: true });
    expect(validated(name, "😀😀")).toEqual({ ok: true });
    expect(validated(name, "가나다라")).toEqual({
      ok: false,
      issue: "expected at most 3 characters",
    });
    expect(validated(name, "😀")).toEqual({ ok: false, issue: "expected at least 2 characters" });
    // Both bounds at once: chars for the reader, bytes for the wire.
    const bubble = schema.string().maxChars(3).maxLength(8);
    expect(validated(bubble, "abc")).toEqual({ ok: true });
    expect(validated(bubble, "가나다").ok).toBe(false);
  });

  // Node builds its ill-formed strings from lone UTF-16 surrogates. A Luau
  // string is bytes, so the native analog is a string that is not valid UTF-8
  // (utf8.len returns nil for it).
  it("fails maxChars / minChars on a string with no UTF-8 form", () => {
    expect(validated(schema.string().maxChars(10), `a${string.char(0xff)}b`).ok).toBe(false);
    expect(validated(schema.string().minChars(0), string.char(0xc3)).ok).toBe(false);
    // A well-formed 4-byte sequence is one code point.
    expect(validated(schema.string().maxChars(1), "😀")).toEqual({ ok: true });
  });

  it("enforces array length constraints", () => {
    const hand = schema.array(schema.string()).minItems(1).maxItems(3);
    expect(validated(hand, ["a", "b"])).toEqual({ ok: true });
    expect(validated(hand, [])).toEqual({ ok: false, issue: "expected at least 1 items" });
    expect(validated(hand, ["a", "b", "c", "d"])).toEqual({
      ok: false,
      issue: "expected at most 3 items",
    });
  });

  it("enforces a record's maxEntries after its values", () => {
    const scores = schema.record(schema.number()).maxEntries(2);
    expect(validated(scores, { a: 1, b: 2 })).toEqual({ ok: true });
    expect(validated(scores, {})).toEqual({ ok: true });
    expect(validated(scores, { a: 1, b: 2, c: 3 })).toEqual({
      ok: false,
      issue: "expected at most 2 entries",
    });
    // A bad value is reported before the count, as for an array's items.
    expect(validated(scores, { a: 1, b: 2, c: "x" })).toEqual({
      ok: false,
      issue: "c: expected finite number",
    });
    const withDefault = schema
      .record(schema.string())
      .refine((value) => (value as { [key: string]: unknown })["default"] !== undefined, "expected a default entry");
    expect(validated(withDefault, { other: "x" })).toEqual({
      ok: false,
      issue: "expected a default entry",
    });
    // `.default()` makes the record optional for the client, filled for the handler.
    expect(applyDefaults(schema.object({ tags: schema.record(schema.boolean()).default({}) }), {})).toEqual({
      tags: {},
    });
  });

  it("runs a custom .refine predicate after the structural check", () => {
    const even = schema
      .number()
      .refine((value) => (value as number) % 2 === 0, "expected an even number");
    expect(validated(even, 4)).toEqual({ ok: true });
    expect(validated(even, 3)).toEqual({ ok: false, issue: "expected an even number" });
    // The structural check runs first: a non-number never reaches the predicate.
    expect(validated(even, "x")).toEqual({ ok: false, issue: "expected finite number" });
  });

  it("reports constraint failures at the nested path", () => {
    const form = schema.object({ name: schema.string().minLength(2) });
    expect(validated(form, { name: "a" })).toEqual({
      ok: false,
      issue: "name: expected length >= 2 bytes",
    });
  });

  it("keeps chained refinements immutable across branches", () => {
    const base = schema.number().min(0);
    const capped = base.max(10);
    // The original schema is not mutated by deriving a stricter one.
    expect(validated(base, 50)).toEqual({ ok: true });
    expect(validated(capped, 50)).toEqual({ ok: false, issue: "expected a number <= 10" });
  });
});

describe("discriminated union", () => {
  const event = schema.discriminatedUnion("type", [
    schema.object({ type: schema.literal("move"), dx: schema.number() }),
    schema.object({ type: schema.literal("chat"), text: schema.string() }),
  ]);

  it("accepts a value matching the selected member", () => {
    expect(validated(event, { type: "move", dx: 5 })).toEqual({ ok: true });
    expect(validated(event, { type: "chat", text: "hi" })).toEqual({ ok: true });
  });

  it("dispatches on the discriminant and reports the member's own field error", () => {
    // The 'move' member is selected by type, so the error is about dx — not a
    // generic 'no member matched'.
    expect(validated(event, { type: "move", dx: "nope" })).toEqual({
      ok: false,
      issue: "dx: expected finite number",
    });
  });

  it("reports an unknown discriminant at the discriminant path", () => {
    // Node: 'type: expected one of "move", "chat"', at the discriminant path.
    expect(validated(event, { type: "delete" })).toEqual({
      ok: false,
      issue: "expected type to match a known variant",
    });
  });

  it("infers the union of its members", () => {
    // Type-level: a value assignable to one member is accepted by the schema's
    // Infer. (Compile-time check; runtime asserts the validation above.)
    const move: Infer<typeof event> = { type: "move", dx: 1 };
    expect(validated(event, move)).toEqual({ ok: true });
  });
});

describe("default values", () => {
  it("fills an absent defaulted field, keeping present ones", () => {
    const form = schema.object({ count: schema.number().default(10), name: schema.string() });
    expect(applyDefaults(form, { name: "a" })).toEqual({ name: "a", count: 10 });
    expect(applyDefaults(form, { name: "a", count: 3 })).toEqual({ name: "a", count: 3 });
  });

  it("returns the input unchanged when nothing is filled (no clone)", () => {
    const form = schema.object({ name: schema.string() });
    const input = { name: "a" };
    expect(applyDefaults(form, input)).toBe(input);
  });

  it("treats an absent defaulted field as valid (the default supplies it)", () => {
    const form = schema.object({ count: schema.number().default(0) });
    expect(validated(form, {})).toEqual({ ok: true });
    // A present-but-wrong value still fails.
    expect(validated(form, { count: "x" }).ok).toBe(false);
  });

  it("fills nested defaults inside arrays of objects", () => {
    const form = schema.object({
      items: schema.array(schema.object({ qty: schema.number().default(1) })),
    });
    expect(applyDefaults(form, { items: [{}, { qty: 5 }] })).toEqual({
      items: [{ qty: 1 }, { qty: 5 }],
    });
  });

  it("infers a defaulted field as present for the handler", () => {
    const form = schema.object({ count: schema.number().default(0) });
    // count is a required (present) key in the handler-facing inferred type.
    const value: Infer<typeof form> = { count: 5 };
    expect(value.count).toBe(5);
  });
});
