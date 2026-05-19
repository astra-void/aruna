import { describe, expect, it } from "vitest";
import {
  ActionSerializationError,
  assertSerializableActionValue,
  validateSerializableActionValue,
} from "../src/server-runtime.js";

describe("serialization policy", () => {
  it("accepts wire-safe primitive and plain data values", () => {
    expect(validateSerializableActionValue(undefined)).toEqual({ ok: true });
    expect(validateSerializableActionValue("hello")).toEqual({ ok: true });
    expect(validateSerializableActionValue(42)).toEqual({ ok: true });
    expect(validateSerializableActionValue(true)).toEqual({ ok: true });
    expect(validateSerializableActionValue([1, "two", false, undefined])).toEqual({ ok: true });
    expect(
      validateSerializableActionValue({
        itemId: "sword",
        metadata: {
          tags: ["rare"],
          enabled: true,
          optional: undefined,
        },
      }),
    ).toEqual({ ok: true });
  });

  it("rejects null, functions, non-finite numbers, and unsupported objects", () => {
    expect(validateSerializableActionValue(null)).toEqual({
      ok: false,
      violations: [
        {
          path: "$",
          reason: "null values cannot cross action boundaries",
          valueKind: "null",
        },
      ],
    });

    expect(validateSerializableActionValue(() => undefined)).toEqual({
      ok: false,
      violations: [
        {
          path: "$",
          reason: "functions cannot cross action boundaries",
          valueKind: "function",
        },
      ],
    });

    expect(validateSerializableActionValue({ nested: () => undefined })).toEqual({
      ok: false,
      violations: [
        {
          path: "$.nested",
          reason: "functions cannot cross action boundaries",
          valueKind: "function",
        },
      ],
    });

    expect(validateSerializableActionValue(Number.NaN)).toEqual({
      ok: false,
      violations: [
        {
          path: "$",
          reason: "non-finite numbers cannot cross action boundaries",
          valueKind: "number",
        },
      ],
    });

    expect(validateSerializableActionValue(Number.POSITIVE_INFINITY)).toEqual({
      ok: false,
      violations: [
        {
          path: "$",
          reason: "non-finite numbers cannot cross action boundaries",
          valueKind: "number",
        },
      ],
    });

    expect(validateSerializableActionValue(Number.NEGATIVE_INFINITY)).toEqual({
      ok: false,
      violations: [
        {
          path: "$",
          reason: "non-finite numbers cannot cross action boundaries",
          valueKind: "number",
        },
      ],
    });

    class Demo {
      readonly value = 1;
    }

    expect(validateSerializableActionValue(new Demo())).toEqual({
      ok: false,
      violations: [
        {
          path: "$",
          reason: "class instances and non-plain objects cannot cross action boundaries",
          valueKind: "non-plain object",
        },
      ],
    });

    expect(validateSerializableActionValue(new Date())).toEqual({
      ok: false,
      violations: [
        {
          path: "$",
          reason: "class instances and non-plain objects cannot cross action boundaries",
          valueKind: "non-plain object",
        },
      ],
    });

    expect(
      validateSerializableActionValue({
        ClassName: "Player",
        IsA(className: string) {
          return className === "Instance" || className === "Player";
        },
      }),
    ).toEqual({
      ok: false,
      violations: [
        {
          path: "$",
          reason: "Roblox Instance-like values cannot cross action boundaries",
          valueKind: "Roblox Instance-like object",
        },
      ],
    });
  });

  it("reports stable nested paths", () => {
    const result = validateSerializableActionValue({
      items: [
        {
          id: {
            value: null,
          },
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      violations: [
        {
          path: "$.items[0].id.value",
          reason: "null values cannot cross action boundaries",
          valueKind: "null",
        },
      ],
    });
  });

  it("rejects cyclic objects", () => {
    const value: Record<string, unknown> = {};
    value.self = value;

    expect(validateSerializableActionValue(value)).toEqual({
      ok: false,
      violations: [
        {
          path: "$.self",
          reason: "cyclic reference",
          valueKind: "plain object",
        },
      ],
    });
  });

  it("rejects values that exceed the configured depth", () => {
    expect(
      validateSerializableActionValue(
        {
          deeper: {
            value: 1,
          },
        },
        { maxDepth: 1 },
      ),
    ).toEqual({
      ok: false,
      violations: [
        {
          path: "$.deeper",
          reason: "max depth exceeded",
          valueKind: "plain object",
        },
      ],
    });
  });

  it("stops collecting violations after the configured limit", () => {
    const result = validateSerializableActionValue(
      {
        a: null,
        b: null,
        c: null,
      },
      { maxViolations: 2 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(2);
      expect(result.violations[0]).toEqual({
        path: "$.a",
        reason: "null values cannot cross action boundaries",
        valueKind: "null",
      });
      expect(result.violations[1]).toEqual({
        path: "$.b",
        reason: "null values cannot cross action boundaries",
        valueKind: "null",
      });
    }
  });

  it("throws a readable ActionSerializationError", () => {
    expect(() => {
      assertSerializableActionValue(
        {
          player: {
            ClassName: "Player",
            IsA(className: string) {
              return className === "Instance" || className === "Player";
            },
          },
        },
        "input",
        "shop.purchaseItem",
      );
    }).toThrowError(ActionSerializationError);

    try {
      assertSerializableActionValue(
        {
          player: {
            ClassName: "Player",
            IsA(className: string) {
              return className === "Instance" || className === "Player";
            },
          },
        },
        "input",
        "shop.purchaseItem",
      );
    } catch (error: unknown) {
      expect(error).toMatchObject({
        name: "ActionSerializationError",
        actionId: "shop.purchaseItem",
        role: "input",
        message:
          "Action shop.purchaseItem input is not serializable across the Aruna action boundary. $.player: Roblox Instance-like values cannot cross action boundaries",
      });
    }
  });
});
