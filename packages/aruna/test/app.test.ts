import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearActionInvoker, invokeAction } from "../src/client.js";
import { createClientApp } from "../src/client.js";
import { createServerApp } from "../src/server.js";
import { schema } from "../src/schema.js";
import { defineAction } from "../src/server.js";

beforeEach(() => {
  clearActionInvoker();
});

afterEach(() => {
  clearActionInvoker();
});

describe("createClientApp", () => {
  it("installs an invoker used by invokeAction", async () => {
    const app = createClientApp({
      transport: async (actionId, input) => {
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
      transport: async () => {
        return { ok: true };
      },
    });

    app.dispose();

    await expect(invokeAction("shop.purchaseItem", { itemId: "sword" })).rejects.toThrowError(
      /Aruna action invoker is not installed; cannot invoke "shop.purchaseItem"/,
    );
  });

  it("can be disposed twice safely", async () => {
    const app = createClientApp({
      transport: async () => {
        return { ok: true };
      },
    });

    app.dispose();
    app.dispose();

    await expect(invokeAction("shop.purchaseItem", { itemId: "sword" })).rejects.toThrowError(
      /Aruna action invoker is not installed; cannot invoke "shop.purchaseItem"/,
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

  it("accepts a transport that returns nothing", () => {
    const actions = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run() {
          return { ok: true };
        },
      }),
    };
    let called = 0;

    const app = createServerApp({
      actions,
      transport: () => {
        called += 1;
      },
    });

    expect(called).toBe(1);

    app.dispose();
    app.dispose();
  });

  it("accepts a transport that returns a cleanup function", () => {
    const actions = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run() {
          return { ok: true };
        },
      }),
    };
    let cleaned = 0;

    const app = createServerApp({
      actions,
      transport: () => () => {
        cleaned += 1;
      },
    });

    app.dispose();

    expect(cleaned).toBe(1);
  });

  it("accepts a transport that returns a disposable object", () => {
    const actions = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run() {
          return { ok: true };
        },
      }),
    };
    let cleaned = 0;

    const app = createServerApp({
      actions,
      transport: () => ({
        dispose() {
          cleaned += 1;
        },
      }),
    });

    app.dispose();

    expect(cleaned).toBe(1);
  });

  it("owns the PlayerRemoving connection for per-player cleanup", () => {
    type FakePlayer = { readonly UserId: number };
    const listeners = new Set<(player: FakePlayer) => void>();
    const players = {
      PlayerRemoving: {
        Connect(callback: (player: FakePlayer) => void) {
          listeners.add(callback);
          return {
            Disconnect() {
              listeners.delete(callback);
            },
          };
        },
      },
    };
    const removed: number[] = [];

    const app = createServerApp<FakePlayer>({
      actions: {},
      players,
      onPlayerRemoving(player) {
        removed.push(player.UserId);
      },
    });

    for (const listener of listeners) {
      listener({ UserId: 7 });
    }
    expect(removed).toEqual([7]);

    app.dispose();
    expect(listeners.size).toBe(0);
  });

  it("makes the owned transport dispose idempotent", () => {
    const actions = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run() {
          return { ok: true };
        },
      }),
    };
    let cleaned = 0;

    const app = createServerApp({
      actions,
      transport: () => () => {
        cleaned += 1;
      },
    });

    app.dispose();
    app.dispose();

    expect(cleaned).toBe(1);
  });
});

describe("player sessions and lifecycle", () => {
  type FakePlayer = { readonly UserId: number };

  function createFakePlayers() {
    const addedListeners = new Set<(player: FakePlayer) => void>();
    const removingListeners = new Set<(player: FakePlayer) => void>();
    let present: readonly FakePlayer[] = [];

    return {
      source: {
        PlayerAdded: {
          Connect(callback: (player: FakePlayer) => void) {
            addedListeners.add(callback);
            return {
              Disconnect() {
                addedListeners.delete(callback);
              },
            };
          },
        },
        PlayerRemoving: {
          Connect(callback: (player: FakePlayer) => void) {
            removingListeners.add(callback);
            return {
              Disconnect() {
                removingListeners.delete(callback);
              },
            };
          },
        },
        GetPlayers: () => present,
      },
      setPresent(players: readonly FakePlayer[]) {
        present = players;
      },
      emitAdded(player: FakePlayer) {
        for (const listener of addedListeners) {
          listener(player);
        }
      },
      emitRemoving(player: FakePlayer) {
        for (const listener of removingListeners) {
          listener(player);
        }
      },
      addedCount: () => addedListeners.size,
      removingCount: () => removingListeners.size,
    };
  }

  it("injects the per-player session into ctx.session", async () => {
    const players = createFakePlayers();
    const seen: Array<{ readonly userId: number; readonly hp: number }> = [];
    const app = createServerApp<FakePlayer>({
      actions: {
        "combat.hit": defineAction({
          id: "combat.hit",
          run(ctx) {
            const session = ctx.session as { readonly hp: number };
            seen.push({ userId: ctx.player.UserId, hp: session.hp });
            return { ok: true };
          },
        }),
      },
      players: players.source,
      createSession: (player) => ({ hp: 100, owner: player.UserId }),
    });

    const player = { UserId: 7 };
    players.emitAdded(player);
    await app.dispatch("combat.hit", { player }, {});
    expect(seen).toEqual([{ userId: 7, hp: 100 }]);

    app.dispose();
  });

  it("fires onPlayerAdded with the freshly-created session", () => {
    const players = createFakePlayers();
    const joins: Array<{ readonly userId: number; readonly session: unknown }> = [];
    const app = createServerApp<FakePlayer>({
      actions: {},
      players: players.source,
      createSession: () => ({ hp: 100 }),
      onPlayerAdded: (player, session) => {
        joins.push({ userId: player.UserId, session });
      },
    });

    players.emitAdded({ UserId: 3 });
    expect(joins).toEqual([{ userId: 3, session: { hp: 100 } }]);

    app.dispose();
    expect(players.addedCount()).toBe(0);
  });

  it("boot-backfills onPlayerAdded for players already present", () => {
    const players = createFakePlayers();
    players.setPresent([{ UserId: 1 }, { UserId: 2 }]);
    const joined: number[] = [];

    const app = createServerApp<FakePlayer>({
      actions: {},
      players: players.source,
      onPlayerAdded: (player) => joined.push(player.UserId),
    });

    expect(joined).toEqual([1, 2]);
    app.dispose();
  });

  it("passes the session to onPlayerRemoving, then drops it", async () => {
    const players = createFakePlayers();
    const removed: Array<{ readonly userId: number; readonly session: unknown }> = [];
    const sessionsSeen: unknown[] = [];
    const app = createServerApp<FakePlayer>({
      actions: {
        peek: defineAction({
          id: "peek",
          run(ctx) {
            sessionsSeen.push(ctx.session);
            return {};
          },
        }),
      },
      players: players.source,
      createSession: () => ({ hp: 100 }),
      onPlayerRemoving: (player, session) => {
        removed.push({ userId: player.UserId, session });
      },
    });

    const player = { UserId: 9 };
    players.emitAdded(player);
    await app.dispatch("peek", { player }, {});
    players.emitRemoving(player);
    expect(removed).toEqual([{ userId: 9, session: { hp: 100 } }]);

    // The store entry was dropped: a later dispatch sees no session.
    await app.dispatch("peek", { player }, {});
    expect(sessionsSeen).toEqual([{ hp: 100 }, undefined]);

    app.dispose();
  });

  it("dispose disconnects both lifecycle connections and clears sessions", () => {
    const players = createFakePlayers();
    const app = createServerApp<FakePlayer>({
      actions: {},
      players: players.source,
      createSession: () => ({}),
      onPlayerAdded: () => {},
      onPlayerRemoving: () => {},
    });

    expect(players.addedCount()).toBe(1);
    expect(players.removingCount()).toBe(1);

    app.dispose();
    expect(players.addedCount()).toBe(0);
    expect(players.removingCount()).toBe(0);
  });
});

describe("in-process round-trip", () => {
  it("connects a generated-style stub, client app, server app, and schema validation", async () => {
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
    const clientApp = createClientApp({
      transport: (actionId, input) =>
        serverApp.dispatch(actionId, { player: { name: "Ada" } }, input),
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
    serverApp.dispose();
  });
});
