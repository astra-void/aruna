import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearActionInvoker, invokeAction } from "../src/client.js";
import { createClientApp } from "../src/client.js";
import {
  createRemoteFunctionActionInvoker,
  bindRemoteFunctionActions,
} from "../src/roblox.js";
import { createServerApp } from "../src/server.js";
import { schema } from "../src/schema.js";
import { defineAction } from "../src/server.js";
import { type ActionRegistry } from "../src/server.js";

type FakeRemoteFunction = {
  InvokeServer: (actionId: string, input: unknown) => unknown;
  OnServerInvoke?: ((player: unknown, actionId: string, input: unknown) => unknown) | undefined;
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

afterEach(() => {
  clearActionInvoker();
});

describe("createClientApp", () => {
  it("installs an invoker used by invokeAction", async () => {
    const app = createClientApp({
      invoker: async (actionId, input) => {
        return { actionId, input };
      },
    });

    await expect(invokeAction("shop.purchaseItem", { itemId: "sword" })).resolves.toEqual({
      actionId: "shop.purchaseItem",
      input: { itemId: "sword" },
    });

    app.dispose();
  });

  it("clears the invoker when disposed", async () => {
    const app = createClientApp({
      invoker: async () => {
        return { ok: true };
      },
    });

    app.dispose();

    await expect(invokeAction("shop.purchaseItem", { itemId: "sword" })).rejects.toThrowError(
      "Aruna action runtime is not installed: shop.purchaseItem",
    );
  });

  it("can be disposed twice safely", async () => {
    const app = createClientApp({
      invoker: async () => {
        return { ok: true };
      },
    });

    app.dispose();
    app.dispose();

    await expect(invokeAction("shop.purchaseItem", { itemId: "sword" })).rejects.toThrowError(
      "Aruna action runtime is not installed: shop.purchaseItem",
    );
  });
});

describe("createServerApp", () => {
  it("exposes the action registry", () => {
    const actions = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run() {
          return { ok: true };
        },
      }),
    };

    const app = createServerApp({ actions });

    expect(app.actions).toBe(actions);
  });

  it("dispatch validates input and calls the action through dispatchAction", async () => {
    const run = vi.fn(() => {
      return { ok: true };
    });
    const actions = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        input: schema.object({
          itemId: schema.string(),
        }),
        run,
      }),
    };
    const app = createServerApp({ actions });

    await expect(app.dispatch("shop.purchaseItem", {}, { itemId: 123 })).rejects.toThrowError(
      "Aruna action shop.purchaseItem input validation failed: itemId: expected string",
    );

    expect(run).not.toHaveBeenCalled();
  });

  it("accepts binders that return nothing", () => {
    const actions = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run() {
          return { ok: true };
        },
      }),
    };
    const app = createServerApp({ actions });
    let called = 0;

    const binding = app.bind(() => {
      called += 1;
    });

    expect(called).toBe(1);

    binding.dispose();
    binding.dispose();
  });

  it("accepts binders that return a cleanup function", () => {
    const actions = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run() {
          return { ok: true };
        },
      }),
    };
    const app = createServerApp({ actions });
    let cleaned = 0;

    const binding = app.bind(() => {
      return () => {
        cleaned += 1;
      };
    });

    binding.dispose();

    expect(cleaned).toBe(1);
  });

  it("accepts binders that return a disposable object", () => {
    const actions = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run() {
          return { ok: true };
        },
      }),
    };
    const app = createServerApp({ actions });
    let cleaned = 0;

    const binding = app.bind(() => {
      return {
        dispose() {
          cleaned += 1;
        },
      };
    });

    binding.dispose();

    expect(cleaned).toBe(1);
  });

  it("makes the returned binding dispose idempotent", () => {
    const actions = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run() {
          return { ok: true };
        },
      }),
    };
    const app = createServerApp({ actions });
    let cleaned = 0;

    const binding = app.bind(() => {
      return () => {
        cleaned += 1;
      };
    });

    binding.dispose();
    binding.dispose();

    expect(cleaned).toBe(1);
  });
});

describe("bindRemoteFunctionActions", () => {
  it("returns a disposable binding and restores or clears OnServerInvoke", () => {
    const actions: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run(_ctx, input) {
          return { ok: true, input };
        },
      }),
    };

    const remoteWithPrevious = createFakeRemote({ name: "Ada" });
    const previousHandler = vi.fn(() => {
      return { ok: "previous" };
    });
    remoteWithPrevious.OnServerInvoke = previousHandler;

    const binding = bindRemoteFunctionActions(remoteWithPrevious, actions);

    expect(remoteWithPrevious.OnServerInvoke).not.toBe(previousHandler);

    binding.dispose();
    binding.dispose();

    expect(remoteWithPrevious.OnServerInvoke).toBe(previousHandler);

    const remoteWithoutPrevious = createFakeRemote({ name: "Ada" });
    const secondBinding = bindRemoteFunctionActions(remoteWithoutPrevious, actions);

    secondBinding.dispose();

    expect(remoteWithoutPrevious.OnServerInvoke).toBeUndefined();
  });
});

describe("fake RemoteFunction round-trip", () => {
  it("connects a generated-style stub, client app, server app, and schema validation", async () => {
    const remote = createFakeRemote({ name: "Ada" });
    const actions = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        input: schema.object({
          itemId: schema.string(),
        }),
        output: schema.object({
          ok: schema.boolean(),
        }),
        run(_ctx, input) {
          return { ok: true, input };
        },
      }),
    };

    const serverApp = createServerApp({ actions });
    const serverBinding = serverApp.bind((registry) => {
      return bindRemoteFunctionActions(remote, registry);
    });
    const clientApp = createClientApp({
      invoker: createRemoteFunctionActionInvoker(remote),
    });
    const purchaseItem = (input: { itemId: string }): Promise<unknown> => {
      return invokeAction("shop.purchaseItem", input);
    };

    await expect(purchaseItem({ itemId: "sword" })).resolves.toEqual({
      ok: true,
      input: { itemId: "sword" },
    });

    await expect(invokeAction("shop.purchaseItem", { itemId: 123 })).rejects.toThrowError(
      "Aruna action shop.purchaseItem input validation failed: itemId: expected string",
    );

    clientApp.dispose();
    serverBinding.dispose();
  });
});
