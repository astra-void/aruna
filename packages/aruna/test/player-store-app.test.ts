// The store's integration with the server app: the app owns the player
// document's lifecycle (load on join, release on leave) and hands it to every
// action as `ctx.store`.
import { describe, expect, it } from "vitest";
import { createServerApp } from "../src/app/server.js";
import { defineAction } from "../src/server.js";
import { schema } from "../src/schema.js";
import { createPlayerStore, type StoreDocument } from "../src/runtime/player-store.js";
import { createMemoryStoreBackend, type MemoryStoreBackend } from "../src/runtime/store.js";

type FakePlayer = { readonly UserId: number };

type Profile = { readonly coins: number };

const profileSchema = schema.object({ coins: schema.number() });

function createFakePlayers() {
  const addedListeners = new Set<(player: FakePlayer) => void>();
  const removingListeners = new Set<(player: FakePlayer) => void>();

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
  };
}

function createApp(backend: MemoryStoreBackend, seen: (Profile | undefined)[]) {
  const players = createFakePlayers();
  const playerStore = createPlayerStore<typeof profileSchema, FakePlayer>(
    {
      id: "player.profile",
      schema: profileSchema,
      defaultValue: { coins: 0 },
    },
    { backend, owner: "server-a" },
  );

  const app = createServerApp<FakePlayer>({
    actions: {
      "shop.buy": defineAction({
        id: "shop.buy",
        run(ctx) {
          const document = ctx.store as StoreDocument<Profile> | undefined;
          seen.push(document?.get());
          document?.update((current) => ({ coins: current.coins + 1 }));
          return { ok: true };
        },
      }),
    },
    players: players.source,
    playerStore,
  });

  return { app, players, playerStore };
}

// The app kicks the load off without awaiting it, so tests wait for the same
// promise the app is waiting on rather than guessing at a delay.
async function settle(
  playerStore: ReturnType<typeof createApp>["playerStore"],
  player: FakePlayer,
): Promise<void> {
  await playerStore.waitFor(player);
}

describe("createServerApp with a player store", () => {
  it("loads the document on join and exposes it as ctx.store", async () => {
    const backend = createMemoryStoreBackend();
    const seen: (Profile | undefined)[] = [];
    const { app, players, playerStore } = createApp(backend, seen);

    const player = { UserId: 7 };
    players.emitAdded(player);
    await settle(playerStore, player);

    await app.dispatch("shop.buy", { player }, {});
    expect(seen).toEqual([{ coins: 0 }]);
    expect(playerStore.get(player)?.get()).toEqual({ coins: 1 });
  });

  it("leaves ctx.store undefined for an action that beats the load", async () => {
    const backend = createMemoryStoreBackend();
    const seen: (Profile | undefined)[] = [];
    const { app, players, playerStore } = createApp(backend, seen);

    const player = { UserId: 7 };
    players.emitAdded(player);
    // Dispatched before the locked read resolves: the action must cope with a
    // missing document rather than be handed a default that would overwrite the
    // real record.
    await app.dispatch("shop.buy", { player }, {});
    expect(seen).toEqual([undefined]);

    await settle(playerStore, player);
  });

  it("flushes and releases the lock when the player leaves", async () => {
    const backend = createMemoryStoreBackend();
    const seen: (Profile | undefined)[] = [];
    const { app, players, playerStore } = createApp(backend, seen);

    const player = { UserId: 7 };
    players.emitAdded(player);
    await settle(playerStore, player);
    await app.dispatch("shop.buy", { player }, {});

    players.emitRemoving(player);
    // The release is fire-and-forget from the lifecycle hook; wait for the
    // queued write to land.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stored = backend.snapshot()["player_7"] as { d: Profile; lock?: unknown };
    expect(stored.d).toEqual({ coins: 1 });
    expect(stored.lock).toBeUndefined();
    expect(playerStore.get(player)).toBeUndefined();
  });

  it("exposes the store on the app for shutdown flushing", async () => {
    const backend = createMemoryStoreBackend();
    const { app, players, playerStore } = createApp(backend, []);

    const player = { UserId: 7 };
    players.emitAdded(player);
    await settle(playerStore, player);
    await app.dispatch("shop.buy", { player }, {});

    expect(app.playerStore).toBe(playerStore);
    const results = await app.playerStore!.saveAll();
    expect(results.every((result) => result.ok)).toBe(true);
    expect((backend.snapshot()["player_7"] as { d: Profile }).d).toEqual({ coins: 1 });
  });
});
