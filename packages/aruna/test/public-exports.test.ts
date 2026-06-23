// Imports go through the published root shims (../<entry>.js -> ./dist) and the
// slim root (../dist/index.js) so this exercises the real public-export contract.
import { afterEach, describe, expect, it } from "vitest";
import { defineConfig } from "../dist/index.js";
import {
  clearActionInvoker,
  createClientApp,
  createInMemoryActionInvoker,
  invokeAction,
} from "../client.js";
import {
  ActionRateLimitError,
  ActionSerializationError,
  createActionRateLimiter,
  createServerApp,
  defineAction as defineActionRoot,
  defineAction as defineActionServer,
  dispatchAction,
  validateSerializableActionValue,
  type ActionRegistry,
} from "../server.js";
import {
  ACTION_REMOTE_NAME,
  ARUNA_FOLDER_NAME,
  bindActions,
  bindRemoteEventActions,
  bindRemoteFunctionActions,
  createActionInvoker,
  createRemoteEventActionInvoker,
  createRemoteFunctionActionInvoker,
  ensureActionRemote,
  getActionRemote,
  waitForActionRemote,
  unbindRemoteFunctionActions,
  type RemoteEventActionRequest,
  type RemoteEventActionResponse,
  type RemoteEventClientLike,
  type RemoteEventServerLike,
  type RemoteEventSignalLike,
  type RemoteFunctionClientLike,
  type RemoteFunctionServerLike,
} from "../roblox.js";
import { schema, schema as schemaRoot } from "../schema.js";

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
  it("returns defineConfig objects unchanged", () => {
    const config = {
      compiler: {
        generatedDir: "src/.aruna",
      },
    } as const;

    expect(defineConfig(config)).toBe(config);
  });

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
    expect(validateSerializableActionValue(undefined)).toEqual({ ok: true });
    expect(ActionSerializationError).toBeTypeOf("function");
    expect(ActionRateLimitError).toBeTypeOf("function");
    expect(createActionRateLimiter).toBeTypeOf("function");
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

    await expect(invokeAction("shop.purchaseItem", { itemId: "sword" })).resolves.toEqual({
      ok: true,
      input: { itemId: "sword" },
    });

    clientApp.dispose();
    serverBinding.dispose();
    invoker.dispose();
  });

  it("exposes the default Roblox action remote helpers", () => {
    expect(ARUNA_FOLDER_NAME).toBe("Aruna");
    expect(ACTION_REMOTE_NAME).toBe("Actions");
    expect(getActionRemote).toBeTypeOf("function");
    expect(ensureActionRemote).toBeTypeOf("function");
    expect(waitForActionRemote).toBeTypeOf("function");
    expect(createActionInvoker).toBeTypeOf("function");
    expect(bindActions).toBeTypeOf("function");
  });
});
