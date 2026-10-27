import { describe, expect, it, vi } from "vitest";
import { schema } from "../src/schema/index.js";
import {
  ActionSerializationError,
  assertSerializableActionValue,
  defineAction,
  dispatchAction,
  validateSerializableActionValue,
} from "../src/server.js";

const fakeInstance = {
  ClassName: "Part",
  IsA(className: string) {
    return className === "Instance" || className === "Part";
  },
};

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

  it("keeps the walk inside the node budget when a field is a union", async () => {
    // A refinement runs whenever a member is validated, so the spy sees any
    // validation of the union's members that the wire walk does.
    const spy = vi.fn(() => true);
    const input = schema.object({
      data: schema.union([schema.array(schema.number()).refine(spy, "never fails"), schema.string()]),
    });
    const value = { data: Array.from({ length: 5000 }, () => 0) };

    const result = validateSerializableActionValue(value, { schema: input });
    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();

    const registry = {
      "data.save": defineAction({ input, run: () => "ran" }),
    };
    await expect(
      dispatchAction(registry, "data.save", { player: "tester" }, value),
    ).rejects.toBeInstanceOf(ActionSerializationError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not narrow nested unions by validating them", () => {
    const spy = vi.fn(() => true);
    let nested: ReturnType<typeof schema.union> = schema.union([
      schema.array(schema.number()).refine(spy, "x"),
      schema.string(),
    ]);
    for (let level = 0; level < 6; level += 1) {
      nested = schema.union([schema.object({ next: nested }), schema.array(nested)]);
    }
    let value: unknown = Array.from({ length: 100 }, () => 0);
    for (let level = 0; level < 6; level += 1) {
      value = { next: value };
    }

    expect(validateSerializableActionValue(value, { schema: nested })).toEqual({ ok: true });
    expect(spy).not.toHaveBeenCalled();
  });

  it("accepts an Instance where any union member at that position is schema.instance()", () => {
    const shape = schema.union([
      schema.object({ kind: schema.literal("part"), target: schema.instance() }),
      schema.object({ kind: schema.literal("name"), target: schema.string() }),
    ]);
    // The walk accepts it on either branch; validation then picks the member.
    expect(
      validateSerializableActionValue({ kind: "part", target: fakeInstance }, { schema: shape }).ok,
    ).toBe(true);
    expect(
      validateSerializableActionValue({ kind: "name", target: fakeInstance }, { schema: shape }).ok,
    ).toBe(true);
    // A field no member declares still refuses it.
    expect(
      validateSerializableActionValue({ kind: "part", other: fakeInstance }, { schema: shape }).ok,
    ).toBe(false);
    expect(
      validateSerializableActionValue(fakeInstance, {
        schema: schema.union([schema.string(), schema.number()]),
      }).ok,
    ).toBe(false);
  });
});
