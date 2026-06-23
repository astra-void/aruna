import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServerApp } from "../src/app/server.js";
import { defineAction } from "../src/server.js";
import {
  bindRemoteEventActions,
  bindRemoteFunctionActions,
  type RemoteEventActionRequest,
  type RemoteEventActionResponse,
  type RemoteEventClientLike,
  type RemoteEventServerLike,
  type RemoteEventSignalLike,
} from "../src/roblox-runtime.js";
import {
  ActionRateLimitError,
  createActionRateLimiter,
  dispatchAction,
  type ActionRegistry,
} from "../src/server-runtime.js";
import { schema } from "../src/schema.js";

type FakeSignal<TArgs extends readonly unknown[]> = {
  readonly signal: RemoteEventSignalLike<TArgs>;
  readonly emit: (...args: TArgs) => void;
};

type FakeRemoteEvent<TPlayer = unknown> = RemoteEventClientLike &
  RemoteEventServerLike<TPlayer> & {
    readonly clientSignal: FakeSignal<[RemoteEventActionResponse]>;
    readonly serverSignal: FakeSignal<[TPlayer, RemoteEventActionRequest]>;
    readonly responses: Array<{
      readonly player: TPlayer;
      readonly response: RemoteEventActionResponse;
    }>;
  };

type FakeRemoteFunction = {
  InvokeServer: (actionId: string, input: unknown) => unknown;
  OnServerInvoke?: ((player: unknown, actionId: string, input: unknown) => unknown) | undefined;
};

function createFakeSignal<TArgs extends readonly unknown[]>(): FakeSignal<TArgs> {
  const listeners = new Set<(...args: TArgs) => void>();

  return {
    signal: {
      Connect(callback) {
        listeners.add(callback);
        return {
          Disconnect() {
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
  };
}

function createFakeRemoteEvent<TPlayer>(player: TPlayer): FakeRemoteEvent<TPlayer> {
  const clientSignal = createFakeSignal<[RemoteEventActionResponse]>();
  const serverSignal = createFakeSignal<[TPlayer, RemoteEventActionRequest]>();
  const responses: Array<{
    readonly player: TPlayer;
    readonly response: RemoteEventActionResponse;
  }> = [];

  return {
    clientSignal,
    serverSignal,
    responses,
    OnClientEvent: clientSignal.signal,
    OnServerEvent: serverSignal.signal,
    FireServer(request) {
      serverSignal.emit(player, request);
    },
    FireClient(nextPlayer, response) {
      responses.push({ player: nextPlayer, response });
      clientSignal.emit(response);
    },
  };
}

function createFakeRemoteFunction(player: unknown): FakeRemoteFunction {
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeActionRegistry(run = vi.fn(() => ({ ok: true }))) {
  const registry: ActionRegistry = {
    "shop.purchaseItem": defineAction({
      id: "shop.purchaseItem",
      rateLimit: {
        key: "player",
        windowMs: 1000,
        max: 2,
      },
      input: schema.object({
        itemId: schema.string(),
      }),
      run,
    }),
    "inventory.restockItem": defineAction({
      id: "inventory.restockItem",
      rateLimit: {
        key: "player",
        windowMs: 1000,
        max: 2,
      },
      run,
    }),
  };

  return { registry, run };
}

describe("action rate limits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows unlimited calls when no rate limit is declared", async () => {
    const run = vi.fn(() => ({ ok: true }));
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run,
      }),
    };

    await expect(dispatchAction(registry, "shop.purchaseItem", {}, {})).resolves.toEqual({
      ok: true,
    });
    await expect(dispatchAction(registry, "shop.purchaseItem", {}, {})).resolves.toEqual({
      ok: true,
    });
    await expect(dispatchAction(registry, "shop.purchaseItem", {}, {})).resolves.toEqual({
      ok: true,
    });

    expect(run).toHaveBeenCalledTimes(3);
  });

  it("applies defaultRateLimit to actions that do not declare their own", async () => {
    const run = vi.fn(() => ({ ok: true }));
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({ id: "shop.purchaseItem", run }),
    };
    const rateLimiter = createActionRateLimiter();
    const defaultRateLimit = { key: "player", windowMs: 1000, max: 2 } as const;

    await expect(
      dispatchAction(registry, "shop.purchaseItem", {}, {}, { rateLimiter, defaultRateLimit }),
    ).resolves.toEqual({ ok: true });
    await expect(
      dispatchAction(registry, "shop.purchaseItem", {}, {}, { rateLimiter, defaultRateLimit }),
    ).resolves.toEqual({ ok: true });
    await expect(
      dispatchAction(registry, "shop.purchaseItem", {}, {}, { rateLimiter, defaultRateLimit }),
    ).rejects.toMatchObject({
      name: "ActionRateLimitError",
      actionId: "shop.purchaseItem",
      max: 2,
      windowMs: 1000,
    });

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("lets a per-action rateLimit override the defaultRateLimit", async () => {
    const run = vi.fn(() => ({ ok: true }));
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        rateLimit: { key: "player", windowMs: 1000, max: 3 },
        run,
      }),
    };
    const rateLimiter = createActionRateLimiter();
    // A stricter default must NOT clamp an action that declares a looser limit.
    const defaultRateLimit = { key: "player", windowMs: 1000, max: 1 } as const;

    for (let call = 0; call < 3; call += 1) {
      await expect(
        dispatchAction(registry, "shop.purchaseItem", {}, {}, { rateLimiter, defaultRateLimit }),
      ).resolves.toEqual({ ok: true });
    }
    await expect(
      dispatchAction(registry, "shop.purchaseItem", {}, {}, { rateLimiter, defaultRateLimit }),
    ).rejects.toMatchObject({ name: "ActionRateLimitError", max: 3 });

    expect(run).toHaveBeenCalledTimes(3);
  });

  it("createServerApp forwards defaultRateLimit to dispatch", async () => {
    const run = vi.fn(() => ({ ok: true }));
    const app = createServerApp({
      actions: { "shop.purchaseItem": defineAction({ id: "shop.purchaseItem", run }) },
      defaultRateLimit: { key: "player", windowMs: 1000, max: 1 },
    });

    await expect(app.dispatch("shop.purchaseItem", {}, {})).resolves.toEqual({ ok: true });
    await expect(app.dispatch("shop.purchaseItem", {}, {})).rejects.toMatchObject({
      name: "ActionRateLimitError",
      max: 1,
    });

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("enforces a fixed window and resets after the window expires", async () => {
    const { registry, run } = makeActionRegistry();
    const rateLimiter = createActionRateLimiter();
    const nowMs = vi.fn(() => Date.now());

    await expect(
      dispatchAction(
        registry,
        "shop.purchaseItem",
        {},
        { itemId: "sword" },
        { rateLimiter, nowMs },
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      dispatchAction(
        registry,
        "shop.purchaseItem",
        {},
        { itemId: "sword" },
        { rateLimiter, nowMs },
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      dispatchAction(
        registry,
        "shop.purchaseItem",
        {},
        { itemId: "sword" },
        { rateLimiter, nowMs },
      ),
    ).rejects.toMatchObject({
      name: "ActionRateLimitError",
      actionId: "shop.purchaseItem",
      max: 2,
      windowMs: 1000,
      retryAfterMs: 1000,
      resetAtMs: 2000,
    });

    vi.setSystemTime(2000);

    await expect(
      dispatchAction(
        registry,
        "shop.purchaseItem",
        {},
        { itemId: "shield" },
        { rateLimiter, nowMs },
      ),
    ).resolves.toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("does not consume quota for invalid input", async () => {
    const run = vi.fn(() => ({ ok: true }));
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        rateLimit: {
          key: "player",
          windowMs: 1000,
          max: 1,
        },
        input: schema.object({
          itemId: schema.string(),
        }),
        run,
      }),
    };
    const rateLimiter = createActionRateLimiter();
    const nowMs = vi.fn(() => Date.now());

    await expect(
      dispatchAction(registry, "shop.purchaseItem", {}, { itemId: 123 }, { rateLimiter, nowMs }),
    ).rejects.toThrowError(
      "Aruna action shop.purchaseItem input validation failed: itemId: expected string",
    );

    await expect(
      dispatchAction(
        registry,
        "shop.purchaseItem",
        {},
        { itemId: "sword" },
        { rateLimiter, nowMs },
      ),
    ).resolves.toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not consume quota for unsafe serialization input", async () => {
    const run = vi.fn(() => ({ ok: true }));
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        rateLimit: {
          key: "player",
          windowMs: 1000,
          max: 1,
        },
        run,
      }),
    };
    const rateLimiter = createActionRateLimiter();
    const nowMs = vi.fn(() => Date.now());

    await expect(
      dispatchAction(
        registry,
        "shop.purchaseItem",
        {},
        {
          itemId: {
            ClassName: "Player",
            IsA(className: string) {
              return className === "Instance" || className === "Player";
            },
          },
        },
        { rateLimiter, nowMs },
      ),
    ).rejects.toMatchObject({
      name: "ActionSerializationError",
      actionId: "shop.purchaseItem",
      role: "input",
    });

    await expect(
      dispatchAction(
        registry,
        "shop.purchaseItem",
        {},
        { itemId: "sword" },
        { rateLimiter, nowMs },
      ),
    ).resolves.toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not call run when the action is rate limited", async () => {
    const run = vi.fn(() => ({ ok: true }));
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        rateLimit: {
          key: "player",
          windowMs: 1000,
          max: 1,
        },
        run,
      }),
    };
    const rateLimiter = createActionRateLimiter();
    const nowMs = vi.fn(() => Date.now());

    await expect(
      dispatchAction(
        registry,
        "shop.purchaseItem",
        {},
        { itemId: "sword" },
        { rateLimiter, nowMs },
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      dispatchAction(
        registry,
        "shop.purchaseItem",
        {},
        { itemId: "shield" },
        { rateLimiter, nowMs },
      ),
    ).rejects.toMatchObject({
      name: "ActionRateLimitError",
    });

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps separate action buckets isolated", async () => {
    const run = vi.fn(() => ({ ok: true }));
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        rateLimit: {
          key: "player",
          windowMs: 1000,
          max: 1,
        },
        run,
      }),
      "inventory.restockItem": defineAction({
        id: "inventory.restockItem",
        rateLimit: {
          key: "player",
          windowMs: 1000,
          max: 1,
        },
        run,
      }),
    };
    const rateLimiter = createActionRateLimiter();
    const nowMs = vi.fn(() => Date.now());

    await expect(
      dispatchAction(
        registry,
        "shop.purchaseItem",
        {},
        { itemId: "sword" },
        { rateLimiter, nowMs },
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      dispatchAction(
        registry,
        "shop.purchaseItem",
        {},
        { itemId: "shield" },
        { rateLimiter, nowMs },
      ),
    ).rejects.toMatchObject({ name: "ActionRateLimitError" });

    await expect(
      dispatchAction(registry, "inventory.restockItem", {}, {}, { rateLimiter, nowMs }),
    ).resolves.toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("keeps separate player keys isolated", async () => {
    const run = vi.fn(() => ({ ok: true }));
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        rateLimit: {
          key: "player",
          windowMs: 1000,
          max: 1,
        },
        run,
      }),
    };
    const rateLimiter = createActionRateLimiter();
    const nowMs = vi.fn(() => Date.now());

    const options = {
      rateLimiter,
      nowMs,
      rateLimitKey: (_actionId: string, ctx: { readonly player?: { readonly bucket?: string } }) =>
        ctx.player?.bucket ?? "anonymous",
    };

    await expect(
      dispatchAction(registry, "shop.purchaseItem", { player: { bucket: "alpha" } }, {}, options),
    ).resolves.toEqual({ ok: true });
    await expect(
      dispatchAction(registry, "shop.purchaseItem", { player: { bucket: "beta" } }, {}, options),
    ).resolves.toEqual({ ok: true });
    await expect(
      dispatchAction(registry, "shop.purchaseItem", { player: { bucket: "alpha" } }, {}, options),
    ).rejects.toMatchObject({ name: "ActionRateLimitError" });

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("includes the expected fields on ActionRateLimitError", async () => {
    const run = vi.fn(() => ({ ok: true }));
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        rateLimit: {
          key: "player",
          windowMs: 1000,
          max: 1,
        },
        run,
      }),
    };
    const rateLimiter = createActionRateLimiter();
    const nowMs = vi.fn(() => Date.now());

    await expect(
      dispatchAction(
        registry,
        "shop.purchaseItem",
        {},
        { itemId: "sword" },
        { rateLimiter, nowMs },
      ),
    ).resolves.toEqual({ ok: true });

    try {
      await dispatchAction(
        registry,
        "shop.purchaseItem",
        {},
        { itemId: "shield" },
        { rateLimiter, nowMs },
      );
      throw new Error("expected rate limit error");
    } catch (error) {
      expect(error).toBeInstanceOf(ActionRateLimitError);
      expect(error).toMatchObject({
        name: "ActionRateLimitError",
        actionId: "shop.purchaseItem",
        max: 1,
        windowMs: 1000,
        retryAfterMs: 1000,
        resetAtMs: 2000,
      });
    }
  });

  it("surfaces a readable error response through RemoteEvent binding", async () => {
    const clientSignal = createFakeSignal<[RemoteEventActionResponse]>();
    const serverSignal = createFakeSignal<[unknown, RemoteEventActionRequest]>();
    const remote: FakeRemoteEvent = {
      OnClientEvent: clientSignal.signal,
      OnServerEvent: serverSignal.signal,
      responses: [],
      FireServer(request) {
        serverSignal.emit({ bucket: "alpha" }, request);
      },
      FireClient(player, response) {
        remote.responses.push({ player, response });
        clientSignal.emit(response);
      },
    };
    const rateLimiter = createActionRateLimiter();
    const nowMs = vi.fn(() => Date.now());
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        rateLimit: {
          key: "player",
          windowMs: 1000,
          max: 1,
        },
        run() {
          return { ok: true };
        },
      }),
    };

    bindRemoteEventActions(remote, registry, {
      rateLimiter,
      nowMs,
      rateLimitKey: (_actionId, ctx) =>
        (ctx.player as { readonly bucket?: string } | undefined)?.bucket ?? "anonymous",
    });

    serverSignal.emit(
      { bucket: "alpha" },
      {
        requestId: "request-1",
        actionId: "shop.purchaseItem",
        input: { itemId: "sword" },
      },
    );
    serverSignal.emit(
      { bucket: "alpha" },
      {
        requestId: "request-2",
        actionId: "shop.purchaseItem",
        input: { itemId: "shield" },
      },
    );

    await flushMicrotasks();

    const errorResponse = remote.responses.find((entry) => entry.response.ok === false)?.response;

    expect(errorResponse).toMatchObject({
      ok: false,
      error: {
        name: "ActionRateLimitError",
        message: "Aruna action shop.purchaseItem is rate limited. Retry after 1000ms.",
      },
    });
  });

  it("keeps the RemoteFunction adapter stable when rate limiting is enabled", async () => {
    const remote = createFakeRemoteFunction({ bucket: "alpha" });
    const rateLimiter = createActionRateLimiter();
    const nowMs = vi.fn(() => Date.now());
    const registry: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        rateLimit: {
          key: "player",
          windowMs: 1000,
          max: 1,
        },
        run(_ctx, input) {
          return { ok: true, input };
        },
      }),
    };

    bindRemoteFunctionActions(remote, registry, {
      rateLimiter,
      nowMs,
      rateLimitKey: (_actionId, ctx) =>
        (ctx.player as { readonly bucket?: string } | undefined)?.bucket ?? "anonymous",
    });

    await expect(remote.InvokeServer("shop.purchaseItem", { itemId: "sword" })).resolves.toEqual({
      ok: true,
      input: { itemId: "sword" },
    });

    await expect(
      remote.InvokeServer("shop.purchaseItem", { itemId: "shield" }),
    ).rejects.toMatchObject({
      name: "ActionRateLimitError",
      message: "Aruna action shop.purchaseItem is rate limited. Retry after 1000ms.",
    });
  });

  it("purges only fully-elapsed buckets and reports the count", () => {
    const config = { key: "player", windowMs: 1000, max: 2 } as const;
    const limiter = createActionRateLimiter();

    // Two keys in the same window [1000, 2000); the second check is within the
    // window so it does not trigger the lazy sweep.
    limiter.check("shop.purchaseItem", "alpha", config, 1000);
    limiter.check("shop.purchaseItem", "beta", config, 1500);

    expect(limiter.purge?.(1999)).toBe(0);
    expect(limiter.purge?.(2000)).toBe(2);
    expect(limiter.purge?.(2000)).toBe(0);
  });

  it("lazily purges abandoned keys on check while keeping the active window", () => {
    const config = { key: "player", windowMs: 1000, max: 2 } as const;
    const limiter = createActionRateLimiter();

    limiter.check("shop.purchaseItem", "abandoned", config, 1000);
    // A later check (new window) triggers the lazy sweep of "abandoned"; without
    // it this purge would report 1.
    limiter.check("shop.purchaseItem", "active", config, 2500);
    expect(limiter.purge?.(2999)).toBe(0);

    // The active bucket survived: its earlier count still applies.
    expect(limiter.check("shop.purchaseItem", "active", config, 2600)).toMatchObject({
      ok: true,
      remaining: 0,
    });
    expect(limiter.check("shop.purchaseItem", "active", config, 2700)).toMatchObject({
      ok: false,
    });
  });

  it("lets createServerApp share limiter state across dispatch calls", async () => {
    const run = vi.fn(() => ({ ok: true }));
    const actions: ActionRegistry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        rateLimit: {
          key: "player",
          windowMs: 1000,
          max: 1,
        },
        run,
      }),
    };
    const rateLimiter = createActionRateLimiter();
    const nowMs = vi.fn(() => Date.now());
    const app = createServerApp({
      actions,
      rateLimiter,
      nowMs,
    });

    await expect(app.dispatch("shop.purchaseItem", {}, { itemId: "sword" })).resolves.toEqual({
      ok: true,
    });
    await expect(app.dispatch("shop.purchaseItem", {}, { itemId: "shield" })).rejects.toMatchObject(
      {
        name: "ActionRateLimitError",
      },
    );
  });
});
