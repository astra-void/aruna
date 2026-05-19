import { afterEach, describe, expect, it } from "vitest";
import { defineAction as defineActionRoot, schema as schemaRoot } from "aruna";
import { createClientApp } from "aruna/client";
import { clearActionInvoker, invokeAction } from "aruna/client-runtime";
import { createInMemoryActionInvoker } from "aruna/runtime";
import { createServerApp } from "aruna/server-app";
import {
  DEFAULT_ARUNA_ACTION_REMOTE_EVENT_NAME,
  DEFAULT_ARUNA_FOLDER_NAME,
  bindDefaultRobloxActionRemoteEvent,
  bindRemoteEventActions,
  bindRemoteFunctionActions,
  createDefaultRobloxActionInvoker,
  createRemoteEventActionInvoker,
  createRemoteFunctionActionInvoker,
  ensureDefaultRobloxActionRemoteEvent,
  getDefaultRobloxActionRemoteEvent,
  waitForDefaultRobloxActionRemoteEvent,
  unbindRemoteFunctionActions,
  type RemoteEventActionRequest,
  type RemoteEventActionResponse,
  type RemoteEventClientLike,
  type RemoteEventServerLike,
  type RemoteEventSignalLike,
  type RemoteFunctionClientLike,
  type RemoteFunctionServerLike,
} from "aruna/roblox-runtime";
import { defineAction as defineActionServer } from "aruna/server";
import { dispatchAction, type ActionRegistry } from "aruna/server-runtime";
import { schema } from "aruna/schema";

type FakeRemoteFunction = RemoteFunctionClientLike & RemoteFunctionServerLike;
type FakeRemoteEvent = RemoteEventClientLike & RemoteEventServerLike<unknown>;

function createFakeSignal<TArgs extends readonly unknown[]>() {
  const listeners = new Set<(...args: TArgs) => void>();
  const signal: RemoteEventSignalLike<TArgs> = {
    Connect(callback: (...args: TArgs) => void) {
      listeners.add(callback);

      return {
        Disconnect() {
          listeners.delete(callback);
        },
      };
    },
  };

  return {
    signal,
    emit(...args: TArgs) {
      for (const listener of listeners) {
        listener(...args);
      }
    },
  };
}

afterEach(() => {
  clearActionInvoker();
});

describe("public exports", () => {
  it("keeps the stable entrypoints wired together", async () => {
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineActionServer({
        id: "shop.purchaseItem",
        run(ctx, input) {
          return { ctx, input };
        },
      }),
    };

    const serverApp = createServerApp({ actions: registry });

    const remote: FakeRemoteFunction = {
      InvokeServer(actionId, input) {
        if (this.OnServerInvoke === undefined) {
          throw new Error("RemoteFunction server handler is not bound.");
        }

        return this.OnServerInvoke({ name: "Ada" }, actionId, input);
      },
    };

    const serverBinding = serverApp.bind((actions) => {
      return bindRemoteFunctionActions(remote, actions);
    });
    const clientApp = createClientApp({
      invoker: createRemoteFunctionActionInvoker(remote),
    });

    await expect(invokeAction("shop.purchaseItem", { itemId: "sword" })).resolves.toEqual({
      ctx: { player: { name: "Ada" } },
      input: { itemId: "sword" },
    });

    await expect(
      dispatchAction(registry, "shop.purchaseItem", {}, { itemId: "shield" }),
    ).resolves.toEqual({
      ctx: {},
      input: { itemId: "shield" },
    });

    const inMemoryInvoker = createInMemoryActionInvoker(registry);
    await expect(inMemoryInvoker("shop.purchaseItem", { itemId: "potion" })).resolves.toEqual({
      ctx: {},
      input: { itemId: "potion" },
    });

    expect(schema.string().kind).toBe("string");
    expect(schemaRoot.boolean().kind).toBe("boolean");
    expect(
      defineActionRoot({
        id: "shop.purchaseItem",
        run() {
          return null;
        },
      }).id,
    ).toBe("shop.purchaseItem");

    clientApp.dispose();
    serverBinding.dispose();
    unbindRemoteFunctionActions(remote);
  });

  it("exposes the RemoteEvent transport entrypoints", async () => {
    const remoteClientSignal = createFakeSignal<[RemoteEventActionResponse]>();
    const remoteServerSignal = createFakeSignal<[unknown, RemoteEventActionRequest]>();
    const remote: FakeRemoteEvent = {
      OnClientEvent: remoteClientSignal.signal,
      OnServerEvent: remoteServerSignal.signal,
      FireServer(request) {
        remoteServerSignal.emit({ name: "Ada" }, request);
      },
      FireClient(_player, response) {
        remoteClientSignal.emit(response);
      },
    };
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineActionServer({
        id: "shop.purchaseItem",
        run(_ctx, input) {
          return { ok: true, input };
        },
      }),
    };

    const serverApp = createServerApp({ actions: registry });
    const invoker = createRemoteEventActionInvoker(remote);
    const serverBinding = serverApp.bind((actions) => {
      return bindRemoteEventActions(remote, actions);
    });
    const clientApp = createClientApp({
      invoker,
    });

    await expect(
      invokeAction("shop.purchaseItem", { itemId: "sword" }),
    ).resolves.toEqual({
      ok: true,
      input: { itemId: "sword" },
    });

    clientApp.dispose();
    serverBinding.dispose();
    invoker.dispose();
  });

  it("exposes the default Roblox action remote helpers", () => {
    expect(DEFAULT_ARUNA_FOLDER_NAME).toBe("Aruna");
    expect(DEFAULT_ARUNA_ACTION_REMOTE_EVENT_NAME).toBe("Actions");
    expect(getDefaultRobloxActionRemoteEvent).toBeTypeOf("function");
    expect(ensureDefaultRobloxActionRemoteEvent).toBeTypeOf("function");
    expect(waitForDefaultRobloxActionRemoteEvent).toBeTypeOf("function");
    expect(createDefaultRobloxActionInvoker).toBeTypeOf("function");
    expect(bindDefaultRobloxActionRemoteEvent).toBeTypeOf("function");
  });
});
