import { describe, expect, it } from "vitest";
import {
  ArunaSchemaValidationError,
  assertSchema,
  schema,
  validateSchema,
} from "../src/schema.js";

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
    ).toThrowError(ArunaSchemaValidationError);

    try {
      assertSchema(schema.string(), 42, {
        actionId: "shop.purchaseItem",
        role: "input",
      });
    } catch (error) {
      expect(error).toMatchObject({
        name: "ArunaSchemaValidationError",
        actionId: "shop.purchaseItem",
        role: "input",
        issues: [{ path: [], message: "expected string" }],
      });
    }
  });
});
