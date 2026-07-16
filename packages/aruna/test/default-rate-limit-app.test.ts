// Regression coverage for the createServerApp <-> transport binding seam: a
// config-level `defaultRateLimit` must reach the RemoteEvent dispatch path even
// when no per-action `rateLimit` is declared. `createServerApp({ transport })`
// owns the binding and injects the resolved dispatch options (including
// `defaultRateLimit`) so the fallback actually throttles the wire.
import { afterEach, describe, expect, it } from "vitest";
import { clearActionInvoker, createClientApp, invokeAction } from "../src/client.js";
import {
  createActionRateLimiter,
  createServerApp,
  defineAction,
  type ActionRegistry,
} from "../src/server.js";
import {
  createRemoteEventActionInvoker,
  robloxRemoteEvent,
  type RemoteEventActionRequest,
  type RemoteEventActionResponse,
  type RemoteEventClientLike,
  type RemoteEventServerLike,
  type RemoteEventSignalLike,
} from "../src/roblox.js";
import { bindRemoteEventActions } from "../src/runtime/remote-event.js";

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

function createFakeRemoteEvent(): FakeRemoteEvent {
  const clientSignal = createFakeSignal<[RemoteEventActionResponse]>();
  const serverSignal = createFakeSignal<[unknown, RemoteEventActionRequest]>();
  return {
    OnClientEvent: clientSignal.signal,
    OnServerEvent: serverSignal.signal,
    FireServer(request) {
      serverSignal.emit({ UserId: 1 }, request);
    },
    FireClient(_player, response) {
      clientSignal.emit(response);
    },
  };
}

let actionCounter = 0;
function uniqueActionId(): string {
  actionCounter += 1;
  return `regression.defaultRateLimit.${actionCounter}`;
}

function pingRegistry(actionId: string): ActionRegistry {
  return {
    [actionId]: defineAction({
      id: actionId,
      run() {
        return "pong";
      },
    }),
  };
}

afterEach(() => {
  clearActionInvoker();
});

describe("createServerApp defaultRateLimit reaches the RemoteEvent dispatch path", () => {
  it("blocks an action that only inherits the app-wide defaultRateLimit", async () => {
    const actionId = uniqueActionId();
    const actions = pingRegistry(actionId);

    const remote = createFakeRemoteEvent();
    const serverApp = createServerApp({
      actions,
      defaultRateLimit: { key: "player", windowMs: 60_000, max: 1 },
      transport: ({ registry, dispatch }) => bindRemoteEventActions(remote, registry, dispatch),
    });
    const invoker = createRemoteEventActionInvoker(remote);
    const clientApp = createClientApp({ transport: invoker });

    await expect(invokeAction(actionId, {})).resolves.toBe("pong");
    await expect(invokeAction(actionId, {})).rejects.toThrowError(/rate limited/);

    clientApp.dispose();
    serverApp.dispose();
    invoker.dispose();
  });

  it("blocks via the owned `transport` API and recovers after the window", async () => {
    const actionId = uniqueActionId();
    const actions = pingRegistry(actionId);

    let clock = 0;
    const remote = createFakeRemoteEvent();
    const serverApp = createServerApp({
      actions,
      defaultRateLimit: { key: "player", windowMs: 1_000, max: 2 },
      rateLimiter: createActionRateLimiter(),
      nowMs: () => clock,
      transport: ({ registry, dispatch }) => bindRemoteEventActions(remote, registry, dispatch),
    });
    const invoker = createRemoteEventActionInvoker(remote);
    const clientApp = createClientApp({ transport: invoker });

    await expect(invokeAction(actionId, {})).resolves.toBe("pong");
    await expect(invokeAction(actionId, {})).resolves.toBe("pong");
    await expect(invokeAction(actionId, {})).rejects.toThrowError(/rate limited/);

    // Advance past the window: the bucket resets and the action flows again.
    clock = 1_000;
    await expect(invokeAction(actionId, {})).resolves.toBe("pong");

    clientApp.dispose();
    serverApp.dispose();
    invoker.dispose();
  });

  it("accepts the first `max` calls and rejects the rest under the owned transport", async () => {
    const actionId = uniqueActionId();
    const actions = pingRegistry(actionId);
    let clock = 0;
    const remote = createFakeRemoteEvent();
    const serverApp = createServerApp({
      actions,
      defaultRateLimit: { key: "player", windowMs: 1_000, max: 2 },
      rateLimiter: createActionRateLimiter(),
      nowMs: () => clock,
      transport: ({ registry, dispatch }) => bindRemoteEventActions(remote, registry, dispatch),
    });
    const invoker = createRemoteEventActionInvoker(remote);
    const clientApp = createClientApp({ transport: invoker });

    const accepted: boolean[] = [];
    for (let i = 0; i < 4; i += 1) {
      try {
        await invokeAction(actionId, {});
        accepted.push(true);
      } catch {
        accepted.push(false);
      }
    }

    expect(accepted).toEqual([true, true, false, false]);

    clientApp.dispose();
    serverApp.dispose();
    invoker.dispose();
  });

  it("exposes robloxRemoteEvent() as a transport factory", () => {
    // Calling the factory only builds the closure; it does not touch the Roblox
    // `game` global (that happens when the returned transport is invoked).
    expect(robloxRemoteEvent).toBeTypeOf("function");
    expect(robloxRemoteEvent()).toBeTypeOf("function");
  });
});
