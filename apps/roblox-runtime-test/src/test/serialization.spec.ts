// Port of packages/aruna/test/serialization.test.ts: the plain-data-v1 wire
// policy.
//
// The Node `validateSerializableActionValue(value, options)` returns
// `{ ok, violations: [{ path, reason, valueKind }] }`. Its native counterpart is
// `isWireSafe(value, maxNodes?, schema?)`, a boolean: the walk stops at the first
// unsafe value and reports nothing about where it was. At the action boundary the
// runtime turns a `false` into an ActionSerializationError, which is where the
// Node runtime's readable message (path + reason) would surface; the cases that
// assert that detail go through `createTestServerApp().invoke`.
import { defineAction } from "aruna/roblox";
import { isWireSafe } from "aruna/internal/serialization";
import { createTestPlayer, createTestServerApp, describe, expect, it } from "aruna/testing";
import { rejectionOf } from "./support";

class Demo {
  readonly value = 1;
}

function instanceLike() {
  return {
    ClassName: "Player",
    IsA(className: string) {
      return className === "Instance" || className === "Player";
    },
  };
}

// `levels` plain tables nested one in another around a number, so the number
// sits `levels` deep.
function nested(levels: number): unknown {
  let value: unknown = 1;
  for (let level = 0; level < levels; level += 1) {
    value = { deeper: value };
  }
  return value;
}

// A server app with one action that takes any input, for the cases that read
// the rejection the action boundary raises.
function purchaseHarness() {
  return createTestServerApp({
    actions: {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run() {
          return undefined;
        },
      }),
    },
  });
}

describe("serialization policy", () => {
  it("accepts wire-safe primitive and plain data values", () => {
    expect(isWireSafe(undefined)).toBe(true);
    expect(isWireSafe("hello")).toBe(true);
    expect(isWireSafe(42)).toBe(true);
    expect(isWireSafe(true)).toBe(true);
    expect(isWireSafe([1, "two", false, undefined])).toBe(true);
    expect(
      isWireSafe({
        itemId: "sword",
        metadata: {
          tags: ["rare"],
          enabled: true,
          optional: undefined,
        },
      }),
    ).toBe(true);
  });

  // Not ported: `null` (Luau has only nil, which is `undefined` and allowed) and
  // `new Date()` (no JS Date; the Roblox DateTime is a wire type the runtime
  // deliberately accepts).
  it("rejects null, functions, non-finite numbers, and unsupported objects", () => {
    expect(isWireSafe(() => undefined)).toBe(false);
    expect(isWireSafe({ nested: () => undefined })).toBe(false);
    expect(isWireSafe(0 / 0)).toBe(false);
    expect(isWireSafe(math.huge)).toBe(false);
    expect(isWireSafe(-math.huge)).toBe(false);
    expect(isWireSafe(instanceLike())).toBe(false);
    // Node rejected a class instance as non-plain; the native walk ignores the
    // metatable, so its plain fields cross.
    expect(isWireSafe(new Demo())).toBe(true);
  });

  // `null` has no Luau form, so the violation here is a function at the same
  // path. The native walk is boolean and reports no path.
  it("reports stable nested paths", async () => {
    const value = {
      items: [
        {
          id: {
            value: () => undefined,
          },
        },
      ],
    };
    expect(isWireSafe(value)).toBe(false);

    const harness = purchaseHarness();
    const reason = await rejectionOf(
      harness.invoke(createTestPlayer(), "shop.purchaseItem", value),
    );
    harness.dispose();
    expect(reason.name).toBe("ActionSerializationError");
    // Node's violation carried the path "$.items[0].id.value".
    expect(reason.message).toBe("non-serializable action input");
  });

  it("rejects cyclic objects", async () => {
    const value: Record<string, unknown> = {};
    value["self"] = value;

    expect(isWireSafe(value)).toBe(false);
    const harness = purchaseHarness();
    const reason = await rejectionOf(
      harness.invoke(createTestPlayer(), "shop.purchaseItem", value),
    );
    harness.dispose();
    expect(reason.name).toBe("ActionSerializationError");
  });

  // Node takes `maxDepth` as an option; the native walk has a fixed limit of 32
  // levels. A value right at the limit crosses, one level past it does not.
  it("rejects values that exceed the configured depth", () => {
    expect(isWireSafe(nested(32))).toBe(true);
    expect(isWireSafe(nested(33))).toBe(false);
  });

  // Node collects up to `maxViolations` violations. The native walk collects
  // none and stops at the first, so only the verdict is checked.
  it("stops collecting violations after the configured limit", () => {
    expect(
      isWireSafe({
        a: () => undefined,
        b: () => undefined,
        c: () => undefined,
      }),
    ).toBe(false);
  });

  it("throws a readable ActionSerializationError", async () => {
    const harness = purchaseHarness();
    const player = createTestPlayer();

    await expect(
      harness.invoke(player, "shop.purchaseItem", { player: instanceLike() }),
    ).rejects.toThrow();

    const reason = await rejectionOf(
      harness.invoke(player, "shop.purchaseItem", { player: instanceLike() }),
    );
    harness.dispose();
    expect(reason.name).toBe("ActionSerializationError");
    // Node: "Action shop.purchaseItem input is not serializable across the Aruna
    // action boundary. $.player: Roblox Instance-like values cannot cross action
    // boundaries", plus actionId / role fields.
    expect(reason.message).toBe("non-serializable action input");
  });
});
