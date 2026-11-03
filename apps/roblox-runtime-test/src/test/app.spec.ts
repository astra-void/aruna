// Port of packages/aruna/test/app.test.ts: createClientApp and createServerApp
// wiring — the installed invoker, the owned transport, the player lifecycle and
// sessions, input defaults, and the in-process client → server round trip.
//
// The Node fake Players source maps onto the native `players` option
// (`PlayersSource`), which takes the same `PlayerAdded` / `PlayerRemoving` /
// `GetPlayers` shape.
import { createClientApp, invokeAction } from "aruna/client";
import { clearActionInvoker } from "aruna/internal/client-runtime";
import { schema } from "aruna/schema";
import { createServerApp, defineAction, type ServerTransport } from "aruna/server";
import { afterEach, beforeEach, describe, expect, it } from "aruna/testing";

// A players source that never fires, so an app a case does not drive joins for
// does not subscribe to the shared fake Players service.
const inertPlayers = {
  PlayerRemoving: {
    Connect: (_callback: (player: unknown) => void) => ({ Disconnect: () => undefined }),
  },
};

// Apps a case created, disposed after it whether it passed or not.
const owned = new Array<{ readonly dispose: () => void }>();
function track<T extends { readonly dispose: () => void }>(app: T): T {
  owned.push(app);
  return app;
}

const purchaseItem = () =>
  defineAction({
    id: "shop.purchaseItem",
    run() {
      return { ok: true };
    },
  });

describe("createClientApp", () => {
  beforeEach(() => {
    clearActionInvoker();
  });
  afterEach(() => {
    for (const app of owned) {
      app.dispose();
    }
    owned.clear();
    clearActionInvoker();
  });

  it("installs an invoker used by invokeAction", async () => {
    const app = track(
      createClientApp({
        transport: async (actionId, input) => {
          return { actionId, input };
        },
      }),
    );

    const output = await invokeAction("shop.purchaseItem", { itemId: "sword" });
    expect(output).toEqual({
      actionId: "shop.purchaseItem",
      input: { itemId: "sword" },
    });

    app.dispose();
  });

  it("clears the invoker when disposed", () => {
    const app = track(
      createClientApp({
        transport: async () => {
          return { ok: true };
        },
      }),
    );

    app.dispose();

    // Retired Node runtime: rejected with `Aruna action invoker is not installed; cannot invoke "<id>"`.
    expect(() => invokeAction("shop.purchaseItem", { itemId: "sword" })).toThrow(
      "Aruna action runtime is not installed: shop.purchaseItem",
    );
  });

  it("can be disposed twice safely", () => {
    const app = track(
      createClientApp({
        transport: async () => {
          return { ok: true };
        },
      }),
    );

    app.dispose();
    app.dispose();

    // Retired Node runtime: rejected with `Aruna action invoker is not installed; cannot invoke "<id>"`.
    expect(() => invokeAction("shop.purchaseItem", { itemId: "sword" })).toThrow(
      "Aruna action runtime is not installed: shop.purchaseItem",
    );
  });
});

describe("createServerApp", () => {
  afterEach(() => {
    for (const app of owned) {
      app.dispose();
    }
    owned.clear();
  });

  it("exposes the action registry", () => {
    const actions = {
      "shop.purchaseItem": purchaseItem(),
    };

    const app = track(createServerApp({ actions, players: inertPlayers }));

    expect(app.actions).toBe(actions);
  });

  it("dispatch validates input and calls the action through dispatchAction", async () => {
    const runs = { count: 0 };
    const actions = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        input: schema.object({
          itemId: schema.string(),
        }),
        run() {
          runs.count += 1;
          return { ok: true };
        },
      }),
    };
    const app = track(createServerApp({ actions, players: inertPlayers }));

    await expect(
      app.dispatch("shop.purchaseItem", { player: "tester" }, { itemId: 123 }),
    ).rejects.toThrow(
      "Aruna action shop.purchaseItem input validation failed: itemId: expected string",
    );

    expect(runs.count).toBe(0);
  });

  it("accepts a transport that returns nothing", () => {
    const actions = {
      "shop.purchaseItem": purchaseItem(),
    };
    let called = 0;

    // The native `ServerTransport` type asks for a `{ disconnect }` binding; a
    // transport that returns nothing is cast past it, as JavaScript allows.
    const app = createServerApp({
      actions,
      players: inertPlayers,
      transport: (() => {
        called += 1;
      }) as unknown as ServerTransport<unknown>,
    });

    expect(called).toBe(1);

    app.dispose();
    app.dispose();
  });

  it("owns the PlayerRemoving connection for per-player cleanup", () => {
    type FakePlayer = { readonly UserId: number };
    const listeners = new Set<(player: FakePlayer) => void>();
    const players = {
      PlayerRemoving: {
        Connect: (callback: (player: FakePlayer) => void) => {
          listeners.add(callback);
          return {
            Disconnect: () => {
              listeners.delete(callback);
            },
          };
        },
      },
    };
    const removed = new Array<number>();

    const app = track(
      createServerApp<FakePlayer>({
        actions: {},
        players,
        onPlayerRemoving: (player) => {
          removed.push(player.UserId);
        },
      }),
    );

    for (const listener of listeners) {
      listener({ UserId: 7 });
    }
    expect(removed).toEqual([7]);

    app.dispose();
    expect(listeners.size()).toBe(0);
  });
});

describe("player sessions and lifecycle", () => {
  type FakePlayer = { readonly UserId: number };

  afterEach(() => {
    for (const app of owned) {
      app.dispose();
    }
    owned.clear();
  });

  function createFakePlayers() {
    const addedListeners = new Set<(player: FakePlayer) => void>();
    const removingListeners = new Set<(player: FakePlayer) => void>();
    let present: ReadonlyArray<FakePlayer> = [];

    return {
      source: {
        PlayerAdded: {
          Connect: (callback: (player: FakePlayer) => void) => {
            addedListeners.add(callback);
            return {
              Disconnect: () => {
                addedListeners.delete(callback);
              },
            };
          },
        },
        PlayerRemoving: {
          Connect: (callback: (player: FakePlayer) => void) => {
            removingListeners.add(callback);
            return {
              Disconnect: () => {
                removingListeners.delete(callback);
              },
            };
          },
        },
        GetPlayers: () => present,
      },
      setPresent: (players: ReadonlyArray<FakePlayer>) => {
        present = players;
      },
      emitAdded: (player: FakePlayer) => {
        for (const listener of addedListeners) {
          listener(player);
        }
      },
      emitRemoving: (player: FakePlayer) => {
        for (const listener of removingListeners) {
          listener(player);
        }
      },
      addedCount: () => addedListeners.size(),
      removingCount: () => removingListeners.size(),
    };
  }

  it("injects the per-player session into ctx.session", async () => {
    const players = createFakePlayers();
    const seen = new Array<{ readonly userId: number; readonly hp: number }>();
    const app = track(
      createServerApp<FakePlayer>({
        actions: {
          "combat.hit": defineAction({
            id: "combat.hit",
            run(ctx) {
              const session = ctx.session as { readonly hp: number };
              seen.push({ userId: (ctx.player as FakePlayer).UserId, hp: session.hp });
              return { ok: true };
            },
          }),
        },
        players: players.source,
        createSession: (player) => ({ hp: 100, owner: player.UserId }),
      }),
    );

    const player = { UserId: 7 };
    players.emitAdded(player);
    await app.dispatch("combat.hit", { player }, {});
    expect(seen).toEqual([{ userId: 7, hp: 100 }]);

    app.dispose();
  });

  it("fires onPlayerAdded with the freshly-created session", () => {
    const players = createFakePlayers();
    const joins = new Array<{ readonly userId: number; readonly session: unknown }>();
    const app = track(
      createServerApp<FakePlayer>({
        actions: {},
        players: players.source,
        createSession: () => ({ hp: 100 }),
        onPlayerAdded: (player, session) => {
          joins.push({ userId: player.UserId, session });
        },
      }),
    );

    players.emitAdded({ UserId: 3 });
    expect(joins).toEqual([{ userId: 3, session: { hp: 100 } }]);

    app.dispose();
    expect(players.addedCount()).toBe(0);
  });

  it("boot-backfills onPlayerAdded for players already present", () => {
    const players = createFakePlayers();
    players.setPresent([{ UserId: 1 }, { UserId: 2 }]);
    const joined = new Array<number>();

    const app = track(
      createServerApp<FakePlayer>({
        actions: {},
        players: players.source,
        onPlayerAdded: (player) => joined.push(player.UserId),
      }),
    );

    expect(joined).toEqual([1, 2]);
    app.dispose();
  });

  it("passes the session to onPlayerRemoving, then drops it", async () => {
    const players = createFakePlayers();
    const removed = new Array<{ readonly userId: number; readonly session: unknown }>();
    // Each entry wraps the session: an absent session is nil, and a nil cannot
    // sit inside a Luau array.
    const sessionsSeen = new Array<{ readonly session: unknown }>();
    const app = track(
      createServerApp<FakePlayer>({
        actions: {
          peek: defineAction({
            id: "peek",
            run(ctx) {
              sessionsSeen.push({ session: ctx.session });
              return {};
            },
          }),
        },
        players: players.source,
        createSession: () => ({ hp: 100 }),
        onPlayerRemoving: (player, session) => {
          removed.push({ userId: player.UserId, session });
        },
      }),
    );

    const player = { UserId: 9 };
    players.emitAdded(player);
    await app.dispatch("peek", { player }, {});
    players.emitRemoving(player);
    expect(removed).toEqual([{ userId: 9, session: { hp: 100 } }]);

    // The store entry was dropped: a later dispatch sees no session.
    await app.dispatch("peek", { player }, {});
    expect(sessionsSeen).toEqual([{ session: { hp: 100 } }, { session: undefined }]);

    app.dispose();
  });

  it("dispose disconnects both lifecycle connections and clears sessions", () => {
    const players = createFakePlayers();
    const app = track(
      createServerApp<FakePlayer>({
        actions: {},
        players: players.source,
        createSession: () => ({}),
        onPlayerAdded: () => {},
        onPlayerRemoving: () => {},
      }),
    );

    expect(players.addedCount()).toBe(1);
    expect(players.removingCount()).toBe(1);

    app.dispose();
    expect(players.addedCount()).toBe(0);
    expect(players.removingCount()).toBe(0);
  });
});

describe("input defaults", () => {
  afterEach(() => {
    for (const app of owned) {
      app.dispose();
    }
    owned.clear();
  });

  it("fills a defaulted input field before the handler runs", async () => {
    let seen: { readonly item: string; readonly count: number } | undefined;
    const app = track(
      createServerApp({
        actions: {
          "shop.buy": defineAction({
            id: "shop.buy",
            input: schema.object({ item: schema.string(), count: schema.number().default(1) }),
            run(_ctx, input) {
              seen = input;
              return { ok: true };
            },
          }),
        },
        players: inertPlayers,
      }),
    );

    // The caller omits `count`; the server fills the default before the handler.
    await app.dispatch("shop.buy", { player: "p1" }, { item: "sword" });
    expect(seen).toEqual({ item: "sword", count: 1 });

    // A provided value is kept.
    await app.dispatch("shop.buy", { player: "p1" }, { item: "shield", count: 3 });
    expect(seen).toEqual({ item: "shield", count: 3 });

    app.dispose();
  });
});

describe("in-process round-trip", () => {
  afterEach(() => {
    for (const app of owned) {
      app.dispose();
    }
    owned.clear();
    clearActionInvoker();
  });

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

    const serverApp = track(createServerApp({ actions, players: inertPlayers }));
    const clientApp = track(
      createClientApp({
        transport: (actionId, input) =>
          serverApp.dispatch(actionId, { player: { name: "Ada" } }, input),
      }),
    );
    const stub = (input: { itemId: string }): Promise<unknown> => {
      return invokeAction("shop.purchaseItem", input);
    };

    const output = await stub({ itemId: "sword" });
    expect(output).toEqual({
      ok: true,
      input: { itemId: "sword" },
    });

    await expect(invokeAction("shop.purchaseItem", { itemId: 123 })).rejects.toThrow(
      "Aruna action shop.purchaseItem input validation failed: itemId: expected string",
    );

    clientApp.dispose();
    serverApp.dispose();
  });
});
