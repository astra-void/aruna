import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearActionInvoker, invokeAction, setActionInvoker } from "../src/client-runtime.js";
import {
  createRemoteFunctionActionInvoker,
  bindRemoteFunctionActions,
} from "../src/roblox-runtime.js";
import { schema } from "../src/schema.js";
import { defineAction } from "../src/server.js";
import { type ActionRegistry } from "../src/server-runtime.js";

type FakeRemoteFunction = {
  InvokeServer: (actionId: string, input: unknown) => unknown;
  OnServerInvoke?: (player: unknown, actionId: string, input: unknown) => unknown;
};

function createFakeRemote(player: unknown): FakeRemoteFunction {
  const remote: FakeRemoteFunction = {
    InvokeServer(actionId, input) {
      if (remote.OnServerInvoke === undefined) {
        throw new Error("RemoteFunction server handler is not bound.");
      }

      return remote.OnServerInvoke(player, actionId, input);
    },
  };

  return remote;
}

beforeEach(() => {
  clearActionInvoker();
});

describe("remote function client adapter", () => {
  it("calls InvokeServer with the action id and input", async () => {
    const calls: Array<{ actionId: string; input: unknown }> = [];
    const remote: FakeRemoteFunction = {
      InvokeServer(actionId, input) {
        calls.push({ actionId, input });
        return { ok: true };
      },
    };

    const invoker = createRemoteFunctionActionInvoker(remote);

    await expect(invoker("shop.purchaseItem", { itemId: "sword" })).resolves.toEqual({ ok: true });
    expect(calls).toEqual([{ actionId: "shop.purchaseItem", input: { itemId: "sword" } }]);
  });

  it("resolves returned values", async () => {
    const remote: FakeRemoteFunction = {
      InvokeServer() {
        return { ok: true, source: "remote" };
      },
    };

    await expect(
      createRemoteFunctionActionInvoker(remote)("shop.purchaseItem", { itemId: "sword" }),
    ).resolves.toEqual({
      ok: true,
      source: "remote",
    });
  });

  it("rejects when InvokeServer throws", async () => {
    const remote: FakeRemoteFunction = {
      InvokeServer() {
        throw new Error("boom");
      },
    };

    await expect(
      createRemoteFunctionActionInvoker(remote)("shop.purchaseItem", {}),
    ).rejects.toThrowError("boom");
  });
});

describe("remote function server adapter", () => {
  it("installs OnServerInvoke", () => {
    const remote: FakeRemoteFunction = {
      InvokeServer() {
        return undefined;
      },
    };
    const registry: ActionRegistry = {};

    bindRemoteFunctionActions(remote, registry);

    expect(remote.OnServerInvoke).toBeTypeOf("function");
  });

  it("returns a disposable binding that restores the previous handler", () => {
    const remote: FakeRemoteFunction = {
      InvokeServer() {
        return undefined;
      },
    };
    const previousHandler = vi.fn(() => {
      return { ok: "previous" };
    });
    remote.OnServerInvoke = previousHandler;

    const binding = bindRemoteFunctionActions(remote, {});

    expect(remote.OnServerInvoke).not.toBe(previousHandler);

    binding.dispose();
    binding.dispose();

    expect(remote.OnServerInvoke).toBe(previousHandler);
  });

  it("dispatches to the registry and provides the default player context", async () => {
    const remote = createFakeRemote({ name: "Ada" });
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run(ctx, input) {
          return { ctx, input };
        },
      }),
    };

    bindRemoteFunctionActions(remote, registry);

    await expect(remote.InvokeServer("shop.purchaseItem", { itemId: "sword" })).resolves.toEqual({
      ctx: { player: { name: "Ada" } },
      input: { itemId: "sword" },
    });
  });

  it("uses a custom context factory when provided", async () => {
    const remote = createFakeRemote({ name: "Ada" });
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run(ctx, input) {
          return { ctx, input };
        },
      }),
    };

    bindRemoteFunctionActions(remote, registry, (player) => ({ player, role: "test" }));

    await expect(remote.InvokeServer("shop.purchaseItem", { itemId: "sword" })).resolves.toEqual({
      ctx: { player: { name: "Ada" }, role: "test" },
      input: { itemId: "sword" },
    });
  });

  it("fails clearly for an unknown action id", async () => {
    const remote = createFakeRemote({ name: "Ada" });
    const registry: ActionRegistry = {};

    bindRemoteFunctionActions(remote, registry);

    await expect(
      remote.InvokeServer("shop.purchaseItem", { itemId: "sword" }),
    ).rejects.toThrowError("Aruna action not found: shop.purchaseItem");
  });

  it("surfaces serialization policy errors without changing the adapter shape", async () => {
    const remote = createFakeRemote({ name: "Ada" });
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run() {
          return {
            ok: true,
            player: {
              ClassName: "Player",
              IsA(className: string) {
                return className === "Instance" || className === "Player";
              },
            },
          };
        },
      }),
    };

    bindRemoteFunctionActions(remote, registry);

    await expect(
      remote.InvokeServer("shop.purchaseItem", { itemId: "sword" }),
    ).rejects.toMatchObject({
      name: "ActionSerializationError",
      actionId: "shop.purchaseItem",
      role: "output",
      message:
        "Action shop.purchaseItem output is not serializable across the Aruna action boundary. $.player: Roblox Instance-like values cannot cross action boundaries",
    });
  });
});

describe("generated-style remote stub", () => {
  it("round-trips through client and server adapters", async () => {
    const remote = createFakeRemote({ name: "Ada" });
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run(_ctx, input) {
          return { ok: true, input };
        },
      }),
    };

    const purchaseItem = (input: unknown): Promise<unknown> => {
      return invokeAction("shop.purchaseItem", input);
    };

    bindRemoteFunctionActions(remote, registry);
    setActionInvoker(createRemoteFunctionActionInvoker(remote));

    await expect(purchaseItem({ itemId: "sword" })).resolves.toEqual({
      ok: true,
      input: { itemId: "sword" },
    });
  });

  it("surfaces validation errors across the fake remote round-trip", async () => {
    const remote = createFakeRemote({ name: "Ada" });
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

    bindRemoteFunctionActions(remote, registry);
    setActionInvoker(createRemoteFunctionActionInvoker(remote));

    await expect(invokeAction("shop.purchaseItem", { itemId: 123 })).rejects.toThrowError(
      "Aruna action shop.purchaseItem input validation failed: itemId: expected string",
    );
  });
});
