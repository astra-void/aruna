import { describe, expect, it } from "vitest";
import {
  SchemaValidationError,
  applyDefaults,
  assertSchema,
  schema,
  validateSchema,
} from "../src/schema.js";
import type { Infer } from "../src/schema.js";

describe("schema runtime", () => {
  it("validates strings", () => {
    expect(validateSchema(schema.string(), "hello")).toEqual({ ok: true });
    expect(validateSchema(schema.string(), 123)).toEqual({
      ok: false,
      issues: [{ path: [], message: "expected string" }],
    });
  });

  it("validates finite numbers", () => {
    expect(validateSchema(schema.number(), 42)).toEqual({ ok: true });
    expect(validateSchema(schema.number(), Number.NaN)).toEqual({
      ok: false,
      issues: [{ path: [], message: "expected finite number" }],
    });
    expect(validateSchema(schema.number(), Number.POSITIVE_INFINITY)).toEqual({
      ok: false,
      issues: [{ path: [], message: "expected finite number" }],
    });
  });

  it("validates booleans", () => {
    expect(validateSchema(schema.boolean(), true)).toEqual({ ok: true });
    expect(validateSchema(schema.boolean(), "true")).toEqual({
      ok: false,
      issues: [{ path: [], message: "expected boolean" }],
    });
  });

  it("matches literal values exactly", () => {
    expect(validateSchema(schema.literal("sword"), "sword")).toEqual({ ok: true });
    expect(validateSchema(schema.literal(undefined), undefined)).toEqual({ ok: true });
    expect(validateSchema(schema.enum([undefined, "ready"] as const), undefined)).toEqual({
      ok: true,
    });
    expect(validateSchema(schema.literal("sword"), "shield")).toEqual({
      ok: false,
      issues: [{ path: [], message: 'expected literal "sword"' }],
    });
  });

  it("accepts any matching union member", () => {
    const idOrName = schema.union([schema.number(), schema.string()]);
    expect(validateSchema(idOrName, 7)).toEqual({ ok: true });
    expect(validateSchema(idOrName, "player-7")).toEqual({ ok: true });
    expect(validateSchema(idOrName, true)).toEqual({
      ok: false,
      issues: [{ path: [], message: "expected a value matching one of the union members" }],
    });
  });

  it("validates arrays item-by-item", () => {
    expect(validateSchema(schema.array(schema.string()), ["one", "two"])).toEqual({ ok: true });
    expect(validateSchema(schema.array(schema.string()), ["one", 2])).toEqual({
      ok: false,
      issues: [{ path: ["[1]"], message: "expected string" }],
    });
  });

  it("validates object properties recursively", () => {
    const purchaseItem = schema.object({
      payload: schema.object({
        itemId: schema.string(),
      }),
    });

    expect(validateSchema(purchaseItem, { payload: { itemId: "sword" } })).toEqual({ ok: true });
    expect(validateSchema(purchaseItem, { payload: { itemId: 123 } })).toEqual({
      ok: false,
      issues: [{ path: ["payload", "itemId"], message: "expected string" }],
    });
  });

  it("validates record values against the value schema", () => {
    const counts = schema.record(schema.number());
    expect(validateSchema(counts, { sword: 1, shield: 2 })).toEqual({ ok: true });
    expect(validateSchema(counts, {})).toEqual({ ok: true });
    expect(validateSchema(counts, { sword: "one" })).toEqual({
      ok: false,
      issues: [{ path: ["sword"], message: "expected finite number" }],
    });
    expect(validateSchema(counts, "not a record")).toEqual({
      ok: false,
      issues: [{ path: [], message: "expected record object" }],
    });
  });

  it("validates tuples positionally with exact length", () => {
    const pair = schema.tuple([schema.string(), schema.number()]);
    expect(validateSchema(pair, ["sword", 3])).toEqual({ ok: true });
    expect(validateSchema(pair, ["sword"])).toEqual({
      ok: false,
      issues: [{ path: [], message: "expected tuple of length 2, got 1" }],
    });
    expect(validateSchema(pair, ["sword", "three"])).toEqual({
      ok: false,
      issues: [{ path: ["[1]"], message: "expected finite number" }],
    });
    expect(validateSchema(pair, { 0: "sword", 1: 3 })).toEqual({
      ok: false,
      issues: [{ path: [], message: "expected tuple array" }],
    });
  });

  it("allows undefined for optional schemas", () => {
    const optionalName = schema.optional(schema.string());

    expect(validateSchema(optionalName, undefined)).toEqual({ ok: true });
    expect(validateSchema(optionalName, "Ada")).toEqual({ ok: true });
    expect(validateSchema(optionalName, 123)).toEqual({
      ok: false,
      issues: [{ path: [], message: "expected string" }],
    });
  });

  it("validates enum values", () => {
    const size = schema.enum(["small", "medium", "large"] as const);

    expect(validateSchema(size, "medium")).toEqual({ ok: true });
    expect(validateSchema(size, "xl")).toEqual({
      ok: false,
      issues: [{ path: [], message: 'expected one of "small", "medium", "large"' }],
    });
  });

  it("throws a stable validation error", () => {
    expect(() =>
      assertSchema(schema.string(), 42, {
        actionId: "shop.purchaseItem",
        role: "input",
      }),
    ).toThrowError(SchemaValidationError);

    try {
      assertSchema(schema.string(), 42, {
        actionId: "shop.purchaseItem",
        role: "input",
      });
    } catch (error) {
      expect(error).toMatchObject({
        name: "SchemaValidationError",
        actionId: "shop.purchaseItem",
        role: "input",
        issues: [{ path: [], message: "expected string" }],
      });
    }
  });
});

describe("schema constraints and refinements", () => {
  it("enforces number min/max/int", () => {
    const level = schema.number().min(1).max(100).int();
    expect(validateSchema(level, 50)).toEqual({ ok: true });
    expect(validateSchema(level, 0)).toEqual({
      ok: false,
      issues: [{ path: [], message: "expected a number >= 1" }],
    });
    expect(validateSchema(level, 101)).toEqual({
      ok: false,
      issues: [{ path: [], message: "expected a number <= 100" }],
    });
    expect(validateSchema(level, 3.5)).toEqual({
      ok: false,
      issues: [{ path: [], message: "expected an integer" }],
    });
  });

  it("enforces string length constraints", () => {
    const username = schema.string().minLength(3).maxLength(16);
    expect(validateSchema(username, "ada")).toEqual({ ok: true });
    expect(validateSchema(username, "ab")).toEqual({
      ok: false,
      issues: [{ path: [], message: "expected length >= 3" }],
    });
    expect(validateSchema(schema.string().length(4), "abcde")).toEqual({
      ok: false,
      issues: [{ path: [], message: "expected length 4" }],
    });
  });

  it("enforces array length constraints", () => {
    const hand = schema.array(schema.string()).minItems(1).maxItems(3);
    expect(validateSchema(hand, ["a", "b"])).toEqual({ ok: true });
    expect(validateSchema(hand, [])).toEqual({
      ok: false,
      issues: [{ path: [], message: "expected at least 1 items" }],
    });
    expect(validateSchema(hand, ["a", "b", "c", "d"])).toEqual({
      ok: false,
      issues: [{ path: [], message: "expected at most 3 items" }],
    });
  });

  it("runs a custom .refine predicate after the structural check", () => {
    const even = schema.number().refine((value) => (value as number) % 2 === 0, "expected an even number");
    expect(validateSchema(even, 4)).toEqual({ ok: true });
    expect(validateSchema(even, 3)).toEqual({
      ok: false,
      issues: [{ path: [], message: "expected an even number" }],
    });
    // The structural check runs first: a non-number never reaches the predicate.
    expect(validateSchema(even, "x")).toEqual({
      ok: false,
      issues: [{ path: [], message: "expected finite number" }],
    });
  });

  it("reports constraint failures at the nested path", () => {
    const form = schema.object({ name: schema.string().minLength(2) });
    expect(validateSchema(form, { name: "a" })).toEqual({
      ok: false,
      issues: [{ path: ["name"], message: "expected length >= 2" }],
    });
  });

  it("keeps chained refinements immutable across branches", () => {
    const base = schema.number().min(0);
    const capped = base.max(10);
    // The original schema is not mutated by deriving a stricter one.
    expect(validateSchema(base, 50)).toEqual({ ok: true });
    expect(validateSchema(capped, 50)).toEqual({
      ok: false,
      issues: [{ path: [], message: "expected a number <= 10" }],
    });
  });
});

describe("discriminated union", () => {
  const event = schema.discriminatedUnion("type", [
    schema.object({ type: schema.literal("move"), dx: schema.number() }),
    schema.object({ type: schema.literal("chat"), text: schema.string() }),
  ]);

  it("accepts a value matching the selected member", () => {
    expect(validateSchema(event, { type: "move", dx: 5 })).toEqual({ ok: true });
    expect(validateSchema(event, { type: "chat", text: "hi" })).toEqual({ ok: true });
  });

  it("dispatches on the discriminant and reports the member's own field error", () => {
    // The 'move' member is selected by type, so the error is about dx — not a
    // generic 'no member matched'.
    expect(validateSchema(event, { type: "move", dx: "nope" })).toEqual({
      ok: false,
      issues: [{ path: ["dx"], message: "expected finite number" }],
    });
  });

  it("reports an unknown discriminant at the discriminant path", () => {
    expect(validateSchema(event, { type: "delete" })).toEqual({
      ok: false,
      issues: [{ path: ["type"], message: 'expected one of "move", "chat"' }],
    });
  });

  it("infers the union of its members", () => {
    // Type-level: a value assignable to one member is accepted by the schema's
    // Infer. (Compile-time check; runtime asserts the validation above.)
    const move: Infer<typeof event> = { type: "move", dx: 1 };
    expect(validateSchema(event, move)).toEqual({ ok: true });
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
    expect(validateSchema(form, {})).toEqual({ ok: true });
    // A present-but-wrong value still fails.
    expect(validateSchema(form, { count: "x" }).ok).toBe(false);
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
