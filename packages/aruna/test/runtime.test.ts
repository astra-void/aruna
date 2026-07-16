import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearActionInvoker, invokeAction, setActionInvoker } from "../src/client.js";
import { createInMemoryActionInvoker } from "../src/runtime/memory.js";
import { schema } from "../src/schema.js";
import { defineAction } from "../src/server.js";
import { dispatchAction, type ActionRegistry } from "../src/server.js";

beforeEach(() => {
  clearActionInvoker();
});

describe("client runtime", () => {
  it("fails clearly when no invoker is installed", async () => {
    await expect(invokeAction("shop.purchaseItem", { itemId: "sword" })).rejects.toThrowError(
      /Aruna action invoker is not installed; cannot invoke "shop.purchaseItem"/,
    );
  });

  it("calls the installed invoker", async () => {
    setActionInvoker(async (actionId, input) => {
      return { actionId, input };
    });

    await expect(invokeAction("shop.purchaseItem", { itemId: "sword" })).resolves.toEqual({
      actionId: "shop.purchaseItem",
      input: { itemId: "sword" },
    });
  });

  it("clears the installed invoker", async () => {
    setActionInvoker(async (actionId, input) => {
      return { actionId, input };
    });
    clearActionInvoker();

    await expect(invokeAction("shop.purchaseItem", { itemId: "sword" })).rejects.toThrowError(
      /Aruna action invoker is not installed; cannot invoke "shop.purchaseItem"/,
    );
  });
});

describe("server runtime", () => {
  it("dispatches a sync action and returns its result", async () => {
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run(ctx, input) {
          return { ctx, input, mode: "sync" };
        },
      }),
    };

    await expect(
      dispatchAction(
        registry,
        "shop.purchaseItem",
        { player: { name: "Ada" } },
        { itemId: "sword" },
      ),
    ).resolves.toEqual({
      ctx: { player: { name: "Ada" } },
      input: { itemId: "sword" },
      mode: "sync",
    });
  });

  it("dispatches an async action and returns its result", async () => {
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        async run(ctx, input) {
          return Promise.resolve({ ctx, input, mode: "async" });
        },
      }),
    };

    await expect(
      dispatchAction(
        registry,
        "shop.purchaseItem",
        { player: { name: "Ada" } },
        { itemId: "sword" },
      ),
    ).resolves.toEqual({
      ctx: { player: { name: "Ada" } },
      input: { itemId: "sword" },
      mode: "async",
    });
  });

  it("fails clearly for an unknown action id", async () => {
    const registry: ActionRegistry = {};

    await expect(
      dispatchAction(registry, "shop.purchaseItem", { player: "tester" }, { itemId: "sword" }),
    ).rejects.toThrowError("Aruna action not found: shop.purchaseItem");
  });

  it("validates input before running the action", async () => {
    const run = vi.fn(() => ({ ok: true }));
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        input: schema.object({
          itemId: schema.string(),
        }),
        run,
      }),
    };

    await expect(
      dispatchAction(registry, "shop.purchaseItem", { player: "tester" }, { itemId: 123 }),
    ).rejects.toThrowError(
      "Aruna action shop.purchaseItem input validation failed: itemId: expected string",
    );

    expect(run).not.toHaveBeenCalled();
  });

  it("rejects unsafe input before running the action", async () => {
    const run = vi.fn(() => ({ ok: true }));
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run,
      }),
    };

    await expect(
      dispatchAction(
        registry,
        "shop.purchaseItem",
        {},
        {
          player: {
            ClassName: "Player",
            IsA(className: string) {
              return className === "Instance" || className === "Player";
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      name: "ActionSerializationError",
      actionId: "shop.purchaseItem",
      role: "input",
      message:
        "Action shop.purchaseItem input is not serializable across the Aruna action boundary. $.player: Roblox Instance-like values cannot cross action boundaries",
    });

    expect(run).not.toHaveBeenCalled();
  });

  it("validates output after the action resolves", async () => {
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        output: schema.object({
          ok: schema.boolean(),
        }),
        async run() {
          return { ok: "yes" };
        },
      }),
    };

    await expect(
      dispatchAction(registry, "shop.purchaseItem", { player: "tester" }, { itemId: "sword" }),
    ).rejects.toThrowError(
      "Aruna action shop.purchaseItem output validation failed: ok: expected boolean",
    );
  });

  it("rejects unsafe output after the action resolves", async () => {
    const run = vi.fn(() => {
      return {
        ok: true,
        player: {
          ClassName: "Player",
          IsA(className: string) {
            return className === "Instance" || className === "Player";
          },
        },
      };
    });
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run,
      }),
    };

    await expect(
      dispatchAction(registry, "shop.purchaseItem", { player: "tester" }, { itemId: "sword" }),
    ).rejects.toMatchObject({
      name: "ActionSerializationError",
      actionId: "shop.purchaseItem",
      role: "output",
      message:
        "Action shop.purchaseItem output is not serializable across the Aruna action boundary. $.player: Roblox Instance-like values cannot cross action boundaries",
    });

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("includes the action id and role on validation errors", async () => {
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        input: schema.object({
          itemId: schema.string(),
        }),
        run() {
          return { ok: true };
        },
      }),
    };

    await expect(
      dispatchAction(registry, "shop.purchaseItem", { player: "tester" }, { itemId: 123 }),
    ).rejects.toMatchObject({
      name: "SchemaValidationError",
      actionId: "shop.purchaseItem",
      role: "input",
    });
  });
});

describe("in-memory transport", () => {
  it("connects client invocation to the server registry", async () => {
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run(_ctx, input) {
          return { ok: true, input };
        },
      }),
    };

    setActionInvoker(createInMemoryActionInvoker(registry, { player: "tester" }));

    await expect(invokeAction("shop.purchaseItem", { itemId: "sword" })).resolves.toEqual({
      ok: true,
      input: { itemId: "sword" },
    });
  });

  it("surfaces validation errors", async () => {
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        input: schema.object({
          itemId: schema.string(),
        }),
        run() {
          return { ok: true };
        },
      }),
    };

    setActionInvoker(createInMemoryActionInvoker(registry, { player: "tester" }));

    await expect(invokeAction("shop.purchaseItem", { itemId: 123 })).rejects.toThrowError(
      "Aruna action shop.purchaseItem input validation failed: itemId: expected string",
    );
  });

  it("surfaces serialization policy errors", async () => {
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run(_ctx, input) {
          return { ok: true, input };
        },
      }),
    };

    setActionInvoker(createInMemoryActionInvoker(registry, { player: "tester" }));

    await expect(
      invokeAction("shop.purchaseItem", {
        player: {
          ClassName: "Player",
          IsA(className: string) {
            return className === "Instance" || className === "Player";
          },
        },
      }),
    ).rejects.toMatchObject({
      name: "ActionSerializationError",
      actionId: "shop.purchaseItem",
      role: "input",
    });
  });
});

describe("generated-style stubs", () => {
  it("can call through the in-memory invoker", async () => {
    const purchaseItem = (input: unknown): Promise<unknown> => {
      return invokeAction("shop.purchaseItem", input);
    };

    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run(_ctx, input) {
          return { ok: true, input };
        },
      }),
    };

    setActionInvoker(createInMemoryActionInvoker(registry, { player: "tester" }));

    await expect(purchaseItem({ itemId: "sword" })).resolves.toEqual({
      ok: true,
      input: { itemId: "sword" },
    });
  });
});
