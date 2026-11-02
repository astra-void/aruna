// The store's integration with the server app: the app owns the player
// document's lifecycle (load on join, release on leave) and hands it to every
// action as `ctx.store`. Port of packages/aruna/test/player-store-app.test.ts:
// the app is the native `createServerApp` with an injected players source.
import { schema } from "aruna/schema";
import {
  createMemoryStoreBackend,
  createPlayerStore,
  createServerApp,
  defineAction,
  type MemoryStoreBackend,
  type StoreBackend,
  type StoreDocument,
  type StoreScheduler,
} from "aruna/server";
import { describe, expect, it } from "aruna/testing";
import { waitUntil } from "./support";

type FakePlayer = { readonly UserId: number };

type Profile = { readonly coins: number };

const profileSchema = schema.object({ coins: schema.number() });

function createFakePlayers() {
  const addedListeners = new Set<(player: FakePlayer) => void>();
  const removingListeners = new Set<(player: FakePlayer) => void>();

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
    },
    emitAdded: (player: FakePlayer) => {
      for (const listener of [...addedListeners]) {
        listener(player);
      }
    },
    emitRemoving: (player: FakePlayer) => {
      for (const listener of [...removingListeners]) {
        listener(player);
      }
    },
  };
}

// The Node runtime arms no heartbeat without a scheduler; the native one falls
// back to a real 30s `task.delay`, which would keep Lune from draining. Park
// the heartbeat so the store behaves as the Node suite's does.
function parkedHeartbeats(): StoreScheduler {
  return {
    delay: (ms, callback) => {
      if (ms >= 1_000) {
        return { cancel: () => undefined };
      }
      const thread = task.delay(ms / 1000, callback);
      return {
        cancel: () => {
          task.cancel(thread);
        },
      };
    },
  };
}

// Holds every UpdateAsync until `open()`. The native memory backend settles
// synchronously, so without a gate the locked read would always land inside
// the join handler — before any action could beat it.
function gatedBackend(inner: MemoryStoreBackend): {
  readonly backend: StoreBackend;
  readonly open: () => void;
} {
  let isOpen = false;
  const waiting = new Array<() => void>();
  return {
    backend: {
      get: inner.get,
      set: inner.set,
      remove: inner.remove,
      update: (key, transform, userIds) => {
        if (isOpen) {
          return inner.update(key, transform, userIds);
        }
        return new Promise<unknown>((resolve) => {
          waiting.push(() => {
            inner.update(key, transform, userIds).then((value) => resolve(value));
          });
        });
      },
    },
    open: () => {
      isOpen = true;
      const queued = [...waiting];
      waiting.clear();
      for (const release of queued) {
        release();
      }
    },
  };
}

function entries(initial: Record<string, unknown>): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const [key, value] of pairs(initial)) {
    map.set(key as string, value);
  }
  return map;
}

// `seen` records what each run observed; `undefined` is pushed as a marker
// object because a nil cannot sit inside a Luau array.
const MISSING = { missing: true };

function createApp(backend: StoreBackend, seen: Array<defined>) {
  const players = createFakePlayers();
  const playerStore = createPlayerStore<typeof profileSchema, FakePlayer>(
    {
      id: "player.profile",
      schema: profileSchema,
      defaultValue: { coins: 0 },
    },
    { backend, owner: "server-a", scheduler: parkedHeartbeats() },
  );

  const app = createServerApp<FakePlayer>({
    actions: {
      "shop.buy": defineAction<undefined, undefined, FakePlayer>({
        id: "shop.buy",
        run(ctx) {
          const document = ctx.store as StoreDocument<Profile> | undefined;
          seen.push(document !== undefined ? document.get() : MISSING);
          if (document !== undefined) {
            document.update((current) => ({ coins: current.coins + 1 }));
          }
          return { ok: true };
        },
      }),
    },
    players: players.source,
    playerStore,
  });

  return { app, players, playerStore };
}

describe("createServerApp with a player store", () => {
  it("loads the document on join and exposes it as ctx.store", async () => {
    const backend = createMemoryStoreBackend();
    const seen = new Array<defined>();
    const { app, players, playerStore } = createApp(backend, seen);

    const player: FakePlayer = { UserId: 7 };
    players.emitAdded(player);
    await playerStore.waitFor(player);

    await app.dispatch("shop.buy", { player }, {});
    expect(seen).toEqual([{ coins: 0 }]);
    const document = playerStore.get(player);
    expect(document !== undefined ? document.get() : undefined).toEqual({ coins: 1 });
    app.dispose();
  });

  it("leaves ctx.store undefined for an action that beats the load", async () => {
    const inner = createMemoryStoreBackend();
    const gate = gatedBackend(inner);
    const seen = new Array<defined>();
    const { app, players, playerStore } = createApp(gate.backend, seen);

    const player: FakePlayer = { UserId: 7 };
    players.emitAdded(player);
    // Dispatched before the locked read resolves: the action must cope with a
    // missing document rather than be handed a default that would overwrite the
    // real record.
    await app.dispatch("shop.buy", { player }, {});
    expect(seen).toEqual([MISSING]);

    gate.open();
    await playerStore.waitFor(player);
    app.dispose();
  });

  it("flushes and releases the lock when the player leaves", async () => {
    const backend = createMemoryStoreBackend();
    const seen = new Array<defined>();
    const { app, players, playerStore } = createApp(backend, seen);

    const player: FakePlayer = { UserId: 7 };
    players.emitAdded(player);
    await playerStore.waitFor(player);
    await app.dispatch("shop.buy", { player }, {});

    players.emitRemoving(player);
    // The release is fire-and-forget from the lifecycle hook; wait for the
    // queued write to land.
    await waitUntil(() => {
      const stored = backend.snapshot().get("player_7") as { l?: unknown } | undefined;
      return stored !== undefined && stored.l === undefined;
    });

    const stored = backend.snapshot().get("player_7") as { d: Profile; l?: unknown };
    expect(stored.d).toEqual({ coins: 1 });
    expect(stored.l).toBeUndefined();
    expect(playerStore.get(player)).toBeUndefined();
    app.dispose();
  });

  it("refuses a record from a newer version and lets the game kick from onLoadFailed", async () => {
    // Mixed-version servers after an update: this server is at v1, the player
    // was last saved at v2 by an updated server.
    const newer = { "$aruna": 1, v: 2, t: 0, d: { coins: 900 } };
    const backend = createMemoryStoreBackend(entries({ player_7: newer }));
    const players = createFakePlayers();
    const kicked = new Array<string>();
    const playerStore = createPlayerStore<typeof profileSchema, FakePlayer>(
      { id: "player.profile", schema: profileSchema, defaultValue: { coins: 0 } },
      {
        backend,
        owner: "old-server",
        scheduler: parkedHeartbeats(),
        onLoadFailed: (_player, failure) => {
          if (failure.name === "StoreVersionAheadError") {
            kicked.push("This server is running an older version. Please rejoin.");
          }
        },
      },
    );
    const seen = new Array<defined>();
    const app = createServerApp<FakePlayer>({
      actions: {
        "shop.buy": defineAction<undefined, undefined, FakePlayer>({
          id: "shop.buy",
          run(ctx) {
            const document = ctx.store as StoreDocument<Profile> | undefined;
            seen.push(document !== undefined ? document.get() : MISSING);
            return { ok: true };
          },
        }),
      },
      players: players.source,
      playerStore,
    });

    const player: FakePlayer = { UserId: 7 };
    players.emitAdded(player);
    await playerStore.waitFor(player);
    await app.dispatch("shop.buy", { player }, {});
    players.emitRemoving(player);
    await waitUntil(() => false, 1);

    expect(kicked).toHaveLength(1);
    expect(seen).toEqual([MISSING]);
    expect(backend.snapshot().get("player_7")).toEqual(newer);
    app.dispose();
  });

  it("exposes the store on the app for shutdown flushing", async () => {
    const backend = createMemoryStoreBackend();
    const { app, players, playerStore } = createApp(backend, []);

    const player: FakePlayer = { UserId: 7 };
    players.emitAdded(player);
    await playerStore.waitFor(player);
    await app.dispatch("shop.buy", { player }, {});

    expect(app.playerStore).toBe(playerStore);
    const results = await app.playerStore!.saveAll();
    expect(results.size()).toBe(1);
    expect(results.every((result) => result.ok)).toBe(true);
    expect((backend.snapshot().get("player_7") as { d: Profile }).d).toEqual({ coins: 1 });
    app.dispose();
  });
});

// createServerApp registers a BindToClose handler when it owns a player store.
// The fake game records handlers without exposing them, so the spec swaps the
// method for the duration of one app.
function captureCloseHandlers(): { readonly handlers: Array<() => void>; readonly restore: () => void } {
  const target = game as unknown as { [key: string]: unknown };
  const original = rawget(target, "BindToClose");
  const handlers = new Array<() => void>();
  rawset(target, "BindToClose", (_self: unknown, handler: () => void) => {
    handlers.push(handler);
  });
  return { handlers, restore: () => rawset(target, "BindToClose", original) };
}

describe("createServerApp shutdown", () => {
  it("flushes every open document and clears its lock when the server closes", async () => {
    const close = captureCloseHandlers();
    try {
      const backend = createMemoryStoreBackend();
      const seen = new Array<defined>();
      const { app, players, playerStore } = createApp(backend, seen);
      expect(close.handlers.size()).toBe(1);

      const player: FakePlayer = { UserId: 7 };
      players.emitAdded(player);
      await playerStore.waitFor(player);
      await app.dispatch("shop.buy", { player }, {});
      const before = backend.snapshot().get("player_7") as { d: Profile; l?: unknown };
      expect(before.d.coins).toBe(0);
      expect(before.l !== undefined).toBe(true);

      // What Roblox runs at shutdown: it yields until the releases land.
      close.handlers[0]!();

      const after = backend.snapshot().get("player_7") as { d: Profile; l?: unknown };
      expect(after.d.coins).toBe(1);
      expect(after.l).toBeUndefined();
      app.dispose();
    } finally {
      close.restore();
    }
  });
});
