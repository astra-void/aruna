// Imports go through the published root shims (../<entry>.js -> ./dist) and the
// slim root (../dist/index.js) so this exercises the real public-export contract.
import { afterEach, describe, expect, it } from "vitest";
import { defineConfig } from "../dist/index.js";
import { clearActionInvoker, createClientApp, invokeAction } from "../client.js";
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
  SIGNAL_REMOTE_NAME,
  bindActions,
  createActionInvoker,
  createRemoteEventActionInvoker,
  ensureActionRemote,
  getActionRemote,
  waitForActionRemote,
  type RemoteEventActionResponse,
  type RemoteEventClientLike,
  type RemoteEventSignalLike,
} from "../roblox.js";
import { schema, schema as schemaRoot } from "../schema.js";

type FakeRemoteEventClient = RemoteEventClientLike;

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
    const clientApp = createClientApp({
      transport: (actionId, input) =>
        serverApp.dispatch(actionId, { player: { name: "Ada" } }, input),
    });

    await expect(invokeAction("shop.purchaseItem", { itemId: "sword" })).resolves.toEqual({
      ctx: { player: { name: "Ada" } },
      input: { itemId: "sword" },
    });

    await expect(
      dispatchAction(registry, "shop.purchaseItem", { player: { name: "Ada" } }, { itemId: "shield" }),
    ).resolves.toEqual({
      ctx: { player: { name: "Ada" } },
      input: { itemId: "shield" },
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
    serverApp.dispose();
  });

  it("exposes the RemoteEvent client invoker", async () => {
    const remoteClientSignal = createFakeSignal<[RemoteEventActionResponse]>();
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineActionServer({
        id: "shop.purchaseItem",
        run(_ctx, input) {
          return { ok: true, input };
        },
      }),
    };
    const serverApp = createServerApp({ actions: registry });
    const remote: FakeRemoteEventClient = {
      OnClientEvent: remoteClientSignal.signal,
      FireServer(request) {
        void serverApp.dispatch(request.actionId, { player: { name: "Ada" } }, request.input).then(
          (output) => remoteClientSignal.emit({ requestId: request.requestId, ok: true, output }),
          (error: unknown) =>
            remoteClientSignal.emit({
              requestId: request.requestId,
              ok: false,
              error: { message: String(error) },
            }),
        );
      },
    };

    const invoker = createRemoteEventActionInvoker(remote);
    const clientApp = createClientApp({
      transport: invoker,
    });

    await expect(invokeAction("shop.purchaseItem", { itemId: "sword" })).resolves.toEqual({
      ok: true,
      input: { itemId: "sword" },
    });

    clientApp.dispose();
    serverApp.dispose();
    invoker.dispose();
  });

  it("exposes the default Roblox action remote helpers", () => {
    expect(ACTION_REMOTE_NAME).toBe("ArunaActionRemoteEvent");
    expect(SIGNAL_REMOTE_NAME).toBe("ArunaSignalRemoteEvent");
    expect(getActionRemote).toBeTypeOf("function");
    expect(ensureActionRemote).toBeTypeOf("function");
    expect(waitForActionRemote).toBeTypeOf("function");
    expect(createActionInvoker).toBeTypeOf("function");
    expect(bindActions).toBeTypeOf("function");
  });
});
