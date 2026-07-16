import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearActionInvoker, invokeAction } from "../src/client.js";
import { createClientApp } from "../src/client.js";
import { createServerApp } from "../src/server.js";
import { schema } from "../src/schema.js";
import { defineAction } from "../src/server.js";
import {
  TimeoutError,
  createRemoteEventActionInvoker,
  type ActionTimeoutScheduler,
  type RemoteEventActionRequest,
  type RemoteEventActionResponse,
  type RemoteEventClientLike,
  type RemoteEventServerLike,
  type RemoteEventSignalLike,
} from "../src/roblox.js";
// The low-level binder is internal (the public server surface is `bindActions`
// / `robloxRemoteEvent`); the wire tests exercise it directly.
import { bindRemoteEventActions } from "../src/runtime/remote-event.js";
import { type ActionRegistry } from "../src/server.js";

type FakeSignal<TArgs extends readonly unknown[]> = {
  readonly signal: RemoteEventSignalLike<TArgs>;
  readonly emit: (...args: TArgs) => void;
  readonly listenerCount: () => number;
};

type FakeRemoteEvent<TPlayer = unknown> = RemoteEventClientLike &
  RemoteEventServerLike<TPlayer> & {
    readonly clientSignal: FakeSignal<[RemoteEventActionResponse]>;
    readonly serverSignal: FakeSignal<[TPlayer, RemoteEventActionRequest]>;
    readonly requests: RemoteEventActionRequest[];
    readonly responses: Array<{
      readonly player: TPlayer;
      readonly response: RemoteEventActionResponse;
    }>;
  };

function createFakeSignal<TArgs extends readonly unknown[]>(): FakeSignal<TArgs> {
  const listeners = new Set<(...args: TArgs) => void>();

  return {
    signal: {
      Connect(callback) {
        listeners.add(callback);
        let disconnected = false;

        return {
          Disconnect() {
            if (disconnected) {
              return;
            }

            disconnected = true;
            listeners.delete(callback);
          },
        };
      },
    },
    emit(...args) {
      for (const listener of listeners) {
        listener(...args);
      }
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

function createFakeRemoteEvent<TPlayer = unknown>(player: TPlayer): FakeRemoteEvent<TPlayer> {
  const clientSignal = createFakeSignal<[RemoteEventActionResponse]>();
  const serverSignal = createFakeSignal<[TPlayer, RemoteEventActionRequest]>();
  const requests: RemoteEventActionRequest[] = [];
  const responses: Array<{
    readonly player: TPlayer;
    readonly response: RemoteEventActionResponse;
  }> = [];

  return {
    clientSignal,
    serverSignal,
    requests,
    responses,
    OnClientEvent: clientSignal.signal,
    OnServerEvent: serverSignal.signal,
    FireServer(request) {
      requests.push(request);
      serverSignal.emit(player, request);
    },
    FireClient(nextPlayer, response) {
      responses.push({ player: nextPlayer, response });
      clientSignal.emit(response);
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// A scheduler whose timers fire only when the test asks. Tracks how many timers
// are armed and how many were canceled so tests can assert timer lifecycle.
function createControllableScheduler() {
  const timers = new Map<number, () => void>();
  let nextId = 0;
  let cancelCount = 0;

  const scheduler: ActionTimeoutScheduler = (callback) => {
    const id = nextId;
    nextId += 1;
    timers.set(id, callback);

    return () => {
      if (timers.delete(id)) {
        cancelCount += 1;
      }
    };
  };

  return {
    scheduler,
    activeCount: () => timers.size,
    cancelCount: () => cancelCount,
    fireAll() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) {
        callback();
      }
    },
  };
}

beforeEach(() => {
  clearActionInvoker();
});

afterEach(() => {
  clearActionInvoker();
});

describe("createRemoteEventActionInvoker", () => {
  it("sends request envelopes with the action id and input", async () => {
    const clientSignal = createFakeSignal<[RemoteEventActionResponse]>();
    const requests: RemoteEventActionRequest[] = [];
    const remote: RemoteEventClientLike = {
      OnClientEvent: clientSignal.signal,
      FireServer(request) {
        requests.push(request);
        clientSignal.emit({
          requestId: request.requestId,
          ok: true,
          output: { ok: true },
        });
      },
    };
    const invoker = createRemoteEventActionInvoker(remote, {
      createRequestId() {
        return "request-1";
      },
    });

    await expect(invoker("shop.purchaseItem", { itemId: "sword" })).resolves.toEqual({ ok: true });
    expect(requests).toEqual([
      {
        requestId: "request-1",
        actionId: "shop.purchaseItem",
        input: { itemId: "sword" },
      },
    ]);

    invoker.dispose();
  });

  it("resolves matching ok responses", async () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
    const invoker = createRemoteEventActionInvoker(remote, {
      createRequestId() {
        return "request-1";
      },
    });

    const promise = invoker("shop.purchaseItem", { itemId: "sword" });

    expect(remote.requests).toEqual([
      {
        requestId: "request-1",
        actionId: "shop.purchaseItem",
        input: { itemId: "sword" },
      },
    ]);

    remote.clientSignal.emit({
      requestId: "request-1",
      ok: true,
      output: { ok: true, source: "remote" },
    });

    await expect(promise).resolves.toEqual({ ok: true, source: "remote" });
    invoker.dispose();
  });

  it("rejects matching error responses", async () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
    const invoker = createRemoteEventActionInvoker(remote, {
      createRequestId() {
        return "request-1";
      },
    });

    const promise = invoker("shop.purchaseItem", { itemId: "sword" });

    remote.clientSignal.emit({
      requestId: "request-1",
      ok: false,
      error: {
        message: "boom",
        name: "CustomError",
      },
    });

    await expect(promise).rejects.toMatchObject({
      message: "boom",
      name: "CustomError",
    });

    invoker.dispose();
  });

  it("ignores responses for unknown request ids", async () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
    const invoker = createRemoteEventActionInvoker(remote, {
      createRequestId() {
        return "request-1";
      },
    });

    const promise = invoker("shop.purchaseItem", { itemId: "sword" });
    let settled = false;

    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    remote.clientSignal.emit({
      requestId: "unknown-request",
      ok: true,
      output: { ignored: true },
    });

    await flushMicrotasks();
    expect(settled).toBe(false);

    remote.clientSignal.emit({
      requestId: "request-1",
      ok: true,
      output: { ok: true },
    });

    await expect(promise).resolves.toEqual({ ok: true });
    invoker.dispose();
  });

  it("removes the pending request when FireServer throws", async () => {
    const clientSignal = createFakeSignal<[RemoteEventActionResponse]>();
    const remote: RemoteEventClientLike = {
      OnClientEvent: clientSignal.signal,
      FireServer() {
        throw new Error("boom");
      },
    };
    const invoker = createRemoteEventActionInvoker(remote, {
      createRequestId() {
        return "request-1";
      },
    });

    await expect(invoker("shop.purchaseItem", { itemId: "sword" })).rejects.toThrowError("boom");

    clientSignal.emit({
      requestId: "request-1",
      ok: true,
      output: { late: true },
    });

    await flushMicrotasks();
    invoker.dispose();
  });

  it("dispose disconnects from the client response signal", () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
    const invoker = createRemoteEventActionInvoker(remote);

    expect(remote.clientSignal.listenerCount()).toBe(1);

    invoker.dispose();
    invoker.dispose();

    expect(remote.clientSignal.listenerCount()).toBe(0);
  });

  it("fire-and-forget resolves immediately without registering a pending request", async () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
    const timers = createControllableScheduler();
    const invoker = createRemoteEventActionInvoker(remote, {
      createRequestId() {
        return "request-1";
      },
      requestTimeoutMs: 1000,
      scheduleTimeout: timers.scheduler,
    });

    await expect(
      invoker("spray.paint", { at: 1 }, { fireAndForget: true }),
    ).resolves.toBeUndefined();

    // The request was fired, but no timeout is armed and no response is awaited.
    expect(remote.requests).toEqual([
      { requestId: "request-1", actionId: "spray.paint", input: { at: 1 } },
    ]);
    expect(timers.activeCount()).toBe(0);

    // A late server ack must not throw or settle anything (no pending entry).
    expect(() =>
      remote.clientSignal.emit({ requestId: "request-1", ok: true, output: null }),
    ).not.toThrow();

    invoker.dispose();
  });

  it("fire-and-forget rejects when FireServer throws", async () => {
    const clientSignal = createFakeSignal<[RemoteEventActionResponse]>();
    const remote: RemoteEventClientLike = {
      OnClientEvent: clientSignal.signal,
      FireServer() {
        throw new Error("network down");
      },
    };
    const invoker = createRemoteEventActionInvoker(remote);

    await expect(
      invoker("spray.paint", { at: 1 }, { fireAndForget: true }),
    ).rejects.toThrow("network down");

    invoker.dispose();
  });
});

describe("createRemoteEventActionInvoker request timeout", () => {
  it("arms the default 10s timer when requestTimeoutMs is omitted", async () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
    const scheduler = createControllableScheduler();
    const invoker = createRemoteEventActionInvoker(remote, {
      createRequestId: () => "request-1",
      scheduleTimeout: scheduler.scheduler,
    });

    const promise = invoker("shop.purchaseItem", { itemId: "sword" });
    expect(scheduler.activeCount()).toBe(1);

    remote.clientSignal.emit({ requestId: "request-1", ok: true, output: { ok: true } });
    await expect(promise).resolves.toEqual({ ok: true });

    invoker.dispose();
  });

  it("does not arm a timer when requestTimeoutMs is 0 (explicit opt-out)", async () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
    const scheduler = createControllableScheduler();
    const invoker = createRemoteEventActionInvoker(remote, {
      createRequestId: () => "request-1",
      requestTimeoutMs: 0,
      scheduleTimeout: scheduler.scheduler,
    });

    const promise = invoker("shop.purchaseItem", { itemId: "sword" });
    expect(scheduler.activeCount()).toBe(0);

    remote.clientSignal.emit({ requestId: "request-1", ok: true, output: { ok: true } });
    await expect(promise).resolves.toEqual({ ok: true });

    invoker.dispose();
  });

  it("clears the timer and resolves when a response arrives", async () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
    const scheduler = createControllableScheduler();
    const invoker = createRemoteEventActionInvoker(remote, {
      createRequestId: () => "request-1",
      requestTimeoutMs: 1000,
      scheduleTimeout: scheduler.scheduler,
    });

    const promise = invoker("shop.purchaseItem", { itemId: "sword" });
    expect(scheduler.activeCount()).toBe(1);

    remote.clientSignal.emit({ requestId: "request-1", ok: true, output: { ok: true } });

    await expect(promise).resolves.toEqual({ ok: true });
    expect(scheduler.cancelCount()).toBe(1);

    invoker.dispose();
  });

  it("rejects with TimeoutError and clears the pending entry on timeout", async () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
    const scheduler = createControllableScheduler();
    const invoker = createRemoteEventActionInvoker(remote, {
      createRequestId: () => "request-1",
      requestTimeoutMs: 1000,
      scheduleTimeout: scheduler.scheduler,
    });

    const promise = invoker("shop.purchaseItem", { itemId: "sword" });
    expect(scheduler.activeCount()).toBe(1);

    scheduler.fireAll();

    await expect(promise).rejects.toBeInstanceOf(TimeoutError);
    await expect(promise).rejects.toMatchObject({
      name: "ActionTimeoutError",
      actionId: "shop.purchaseItem",
      timeoutMs: 1000,
    });

    // The pending entry was removed: a late response finds nothing to settle and
    // therefore never reaches the (already fired) timer canceler.
    remote.clientSignal.emit({ requestId: "request-1", ok: true, output: { late: true } });
    await flushMicrotasks();
    expect(scheduler.cancelCount()).toBe(0);

    invoker.dispose();
  });

  it("clears pending timers when disposed", async () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
    const scheduler = createControllableScheduler();
    const invoker = createRemoteEventActionInvoker(remote, {
      createRequestId: () => "request-1",
      requestTimeoutMs: 1000,
      scheduleTimeout: scheduler.scheduler,
    });

    const promise = invoker("shop.purchaseItem", { itemId: "sword" });
    expect(scheduler.activeCount()).toBe(1);

    invoker.dispose();

    await expect(promise).rejects.toThrowError("disposed");
    expect(scheduler.cancelCount()).toBe(1);
    expect(scheduler.activeCount()).toBe(0);
  });
});

describe("bindRemoteEventActions", () => {
  it("dispatches an action and sends an ok response", async () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run(_ctx, input) {
          return { ok: true, input };
        },
      }),
    };

    bindRemoteEventActions(remote, registry);
    remote.FireServer({
      requestId: "request-1",
      actionId: "shop.purchaseItem",
      input: { itemId: "sword" },
    });

    await flushMicrotasks();

    expect(remote.responses).toEqual([
      {
        player: { name: "Ada" },
        response: {
          requestId: "request-1",
          ok: true,
          output: { ok: true, input: { itemId: "sword" } },
        },
      },
    ]);
  });

  it("runs a fire-and-forget action but sends no response", async () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
    const runs: unknown[] = [];
    const registry: ActionRegistry = {
      "spray.paint": defineAction({
        id: "spray.paint",
        fireAndForget: true,
        run(_ctx, input) {
          runs.push(input);
          return { ok: true };
        },
      }),
    };

    bindRemoteEventActions(remote, registry);
    remote.FireServer({
      requestId: "request-1",
      actionId: "spray.paint",
      input: { at: 1 },
    });

    await flushMicrotasks();

    // The handler ran (side effect observed) but no ack was fired back.
    expect(runs).toEqual([{ at: 1 }]);
    expect(remote.responses).toEqual([]);
  });

  it("sends no error response when a fire-and-forget action throws", async () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
    const registry: ActionRegistry = {
      "spray.paint": defineAction({
        id: "spray.paint",
        fireAndForget: true,
        run() {
          throw new Error("boom");
        },
      }),
    };

    bindRemoteEventActions(remote, registry);
    remote.FireServer({
      requestId: "request-1",
      actionId: "spray.paint",
      input: { at: 1 },
    });

    await flushMicrotasks();

    expect(remote.responses).toEqual([]);
  });

  it("sends an error response for an unknown action id", async () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
    const registry: ActionRegistry = {};

    bindRemoteEventActions(remote, registry);
    remote.FireServer({
      requestId: "request-1",
      actionId: "shop.purchaseItem",
      input: { itemId: "sword" },
    });

    await flushMicrotasks();

    expect(remote.responses).toEqual([
      {
        player: { name: "Ada" },
        response: {
          requestId: "request-1",
          ok: false,
          error: {
            message: "Aruna action not found: shop.purchaseItem",
            name: "Error",
          },
        },
      },
    ]);
  });

  it("turns input validation failures into error responses", async () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
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

    bindRemoteEventActions(remote, registry);
    remote.FireServer({
      requestId: "request-1",
      actionId: "shop.purchaseItem",
      input: { itemId: 123 },
    });

    await flushMicrotasks();

    expect(remote.responses[0]?.response).toEqual({
      requestId: "request-1",
      ok: false,
      error: {
        message: "Aruna action shop.purchaseItem input validation failed: itemId: expected string",
        name: "SchemaValidationError",
      },
    });
  });

  it("turns unsafe input into error responses", async () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run() {
          return { ok: true };
        },
      }),
    };

    bindRemoteEventActions(remote, registry);
    remote.FireServer({
      requestId: "request-1",
      actionId: "shop.purchaseItem",
      input: {
        player: {
          ClassName: "Player",
          IsA(className: string) {
            return className === "Instance" || className === "Player";
          },
        },
      },
    });

    await flushMicrotasks();

    expect(remote.responses[0]?.response).toEqual({
      requestId: "request-1",
      ok: false,
      error: {
        message:
          "Action shop.purchaseItem input is not serializable across the Aruna action boundary. $.player: Roblox Instance-like values cannot cross action boundaries",
        name: "ActionSerializationError",
      },
    });
  });

  it("turns output validation failures into error responses", async () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        output: schema.object({
          ok: schema.boolean(),
        }),
        run() {
          return { ok: "yes" };
        },
      }),
    };

    bindRemoteEventActions(remote, registry);
    remote.FireServer({
      requestId: "request-1",
      actionId: "shop.purchaseItem",
      input: {},
    });

    await flushMicrotasks();

    expect(remote.responses[0]?.response).toEqual({
      requestId: "request-1",
      ok: false,
      error: {
        message: "Aruna action shop.purchaseItem output validation failed: ok: expected boolean",
        name: "SchemaValidationError",
      },
    });
  });

  it("turns unsafe output into error responses", async () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
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

    bindRemoteEventActions(remote, registry);
    remote.FireServer({
      requestId: "request-1",
      actionId: "shop.purchaseItem",
      input: {},
    });

    await flushMicrotasks();

    expect(remote.responses[0]?.response).toEqual({
      requestId: "request-1",
      ok: false,
      error: {
        message:
          "Action shop.purchaseItem output is not serializable across the Aruna action boundary. $.player: Roblox Instance-like values cannot cross action boundaries",
        name: "ActionSerializationError",
      },
    });
  });

  it("passes the player into a custom context factory", async () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
    const createContext = vi.fn((player: { name: string }) => {
      return {
        player,
        role: "merchant",
      };
    });
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run(ctx, input) {
          return { ctx, input };
        },
      }),
    };

    bindRemoteEventActions(remote, registry, {
      createContext,
    });
    remote.FireServer({
      requestId: "request-1",
      actionId: "shop.purchaseItem",
      input: { itemId: "sword" },
    });

    await flushMicrotasks();

    expect(createContext).toHaveBeenCalledWith({ name: "Ada" });
    expect(remote.responses[0]?.response).toEqual({
      requestId: "request-1",
      ok: true,
      output: {
        ctx: {
          player: { name: "Ada" },
          role: "merchant",
        },
        input: { itemId: "sword" },
      },
    });
  });

  it("rejects a malformed request envelope with an error response", async () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
    const run = vi.fn(() => ({ ok: true }));
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({ id: "shop.purchaseItem", run }),
    };

    bindRemoteEventActions(remote, registry);

    // actionId is not a string, but the requestId is usable for a reply.
    remote.serverSignal.emit({ name: "Ada" }, {
      requestId: "request-1",
      actionId: 123,
      input: {},
    } as unknown as RemoteEventActionRequest);

    await flushMicrotasks();

    expect(run).not.toHaveBeenCalled();
    expect(remote.responses).toEqual([
      {
        player: { name: "Ada" },
        response: {
          requestId: "request-1",
          ok: false,
          error: {
            message: "Invalid Aruna action request envelope.",
            name: "ActionRequestError",
          },
        },
      },
    ]);
  });

  it("drops a request that has no usable requestId", async () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
    const run = vi.fn(() => ({ ok: true }));
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({ id: "shop.purchaseItem", run }),
    };

    bindRemoteEventActions(remote, registry);

    remote.serverSignal.emit({ name: "Ada" }, {
      requestId: undefined,
      actionId: "shop.purchaseItem",
      input: {},
    } as unknown as RemoteEventActionRequest);
    remote.serverSignal.emit({ name: "Ada" }, null as unknown as RemoteEventActionRequest);

    await flushMicrotasks();

    expect(run).not.toHaveBeenCalled();
    expect(remote.responses).toEqual([]);
  });

  it("dispose disconnects from the server request signal", () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
    const registry: ActionRegistry = {};
    const binding = bindRemoteEventActions(remote, registry);

    expect(remote.serverSignal.listenerCount()).toBe(1);

    binding.dispose();
    binding.dispose();

    expect(remote.serverSignal.listenerCount()).toBe(0);
  });
});

describe("RemoteEvent round trip", () => {
  it("connects generated-style client stubs, client and server apps, and validation", async () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
    const actions = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        input: schema.object({
          itemId: schema.string(),
        }),
        output: schema.object({
          ok: schema.boolean(),
          itemId: schema.string(),
          playerName: schema.string(),
        }),
        run(ctx, input) {
          return {
            ok: true,
            itemId: input.itemId,
            playerName: ctx.player?.name ?? "unknown",
          };
        },
      }),
    };

    const invoker = createRemoteEventActionInvoker(remote, {
      createRequestId() {
        return "request-1";
      },
    });
    const serverApp = createServerApp({
      actions,
      transport: ({ registry, dispatch }) => bindRemoteEventActions(remote, registry, dispatch),
    });

    const clientApp = createClientApp({
      transport: invoker,
    });

    const purchaseItem = (input: { readonly itemId: string }) => {
      return invokeAction("shop.purchaseItem", input);
    };

    await expect(purchaseItem({ itemId: "sword" })).resolves.toEqual({
      ok: true,
      itemId: "sword",
      playerName: "Ada",
    });

    clientApp.dispose();
    serverApp.dispose();
    invoker.dispose();
  });

  it("resolves concurrent requests by request id", async () => {
    const remote = createFakeRemoteEvent({ name: "Ada" });
    const invoker = createRemoteEventActionInvoker(remote, {
      createRequestId: (() => {
        let next = 0;

        return () => {
          next += 1;
          return `request-${next}`;
        };
      })(),
    });

    const firstPromise = invoker("shop.first", { value: 1 });
    const secondPromise = invoker("shop.second", { value: 2 });

    expect(remote.requests).toEqual([
      {
        requestId: "request-1",
        actionId: "shop.first",
        input: { value: 1 },
      },
      {
        requestId: "request-2",
        actionId: "shop.second",
        input: { value: 2 },
      },
    ]);

    remote.clientSignal.emit({
      requestId: "request-2",
      ok: true,
      output: { value: 2, source: "second" },
    });
    remote.clientSignal.emit({
      requestId: "request-1",
      ok: true,
      output: { value: 1, source: "first" },
    });

    await expect(firstPromise).resolves.toEqual({ value: 1, source: "first" });
    await expect(secondPromise).resolves.toEqual({ value: 2, source: "second" });

    invoker.dispose();
  });
});
