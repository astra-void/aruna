import { describe, expect, it } from "vitest";
import { schema } from "../src/schema.js";
import { createPlayerStore, type PlayerStoreDefinition } from "../src/runtime/player-store.js";
import {
  createMemoryStoreBackend,
  type MemoryStoreBackend,
  type StoreScheduler,
} from "../src/runtime/store.js";

const profileSchema = schema.object({
  coins: schema.number(),
  name: schema.string(),
});

type Profile = { readonly coins: number; readonly name: string };

const player = { UserId: 42 };

function definition(
  overrides?: Partial<PlayerStoreDefinition<typeof profileSchema, typeof player>>,
): PlayerStoreDefinition<typeof profileSchema, typeof player> {
  return {
    id: "player.profile",
    schema: profileSchema,
    defaultValue: { coins: 0, name: "guest" },
    session: { heartbeatMs: 1_000, lockTtlMs: 10_000, acquireAttempts: 2, acquireDelayMs: 1 },
    ...overrides,
  };
}

// A scheduler whose callbacks only run when the test says so, so heartbeats are
// deterministic instead of racing the clock.
function manualScheduler(): StoreScheduler & {
  readonly runAll: () => void;
  readonly pending: () => number;
} {
  let callbacks: (() => void)[] = [];
  return {
    delay(_ms, callback) {
      callbacks.push(callback);
      return {
        cancel() {
          callbacks = callbacks.filter((entry) => entry !== callback);
        },
      };
    },
    runAll() {
      const queued = callbacks;
      callbacks = [];
      for (const callback of queued) {
        callback();
      }
    },
    pending: () => callbacks.length,
  };
}

function storedLock(backend: MemoryStoreBackend, key = "player_42"): unknown {
  return (backend.snapshot()[key] as { lock?: unknown } | undefined)?.lock;
}

describe("session locking", () => {
  it("acquires the lock as part of the load", async () => {
    const backend = createMemoryStoreBackend();
    const store = createPlayerStore(definition(), {
      backend,
      owner: "server-a",
      nowMs: () => 1_000,
    });

    const loaded = await store.load(player);
    expect(loaded.ok).toBe(true);
    expect(storedLock(backend)).toEqual({ owner: "server-a", heartbeatMs: 1_000 });
  });

  it("refuses a second server while the lock is live", async () => {
    const backend = createMemoryStoreBackend();
    const first = createPlayerStore(definition(), {
      backend,
      owner: "server-a",
      nowMs: () => 1_000,
    });
    await first.load(player);

    const second = createPlayerStore(definition(), {
      backend,
      owner: "server-b",
      // Well inside the 10s TTL.
      nowMs: () => 3_000,
    });
    const blocked = await second.load(player);

    expect(blocked.ok === false && blocked.error.name).toBe("StoreLockedError");
    expect(blocked.ok === false && blocked.error.retryable).toBe(true);
  });

  it("takes over a lock whose heartbeat went stale", async () => {
    const backend = createMemoryStoreBackend();
    const first = createPlayerStore(definition(), {
      backend,
      owner: "server-a",
      nowMs: () => 1_000,
    });
    await first.load(player);

    const second = createPlayerStore(definition(), {
      backend,
      owner: "server-b",
      // Past the 10s TTL: the previous holder is gone.
      nowMs: () => 20_000,
    });
    const loaded = await second.load(player);

    expect(loaded.ok).toBe(true);
    expect(storedLock(backend)).toEqual({ owner: "server-b", heartbeatMs: 20_000 });
  });

  it("clears the lock on release so the next server loads immediately", async () => {
    const backend = createMemoryStoreBackend();
    const first = createPlayerStore(definition(), {
      backend,
      owner: "server-a",
      nowMs: () => 1_000,
    });
    await first.load(player);
    await first.release(player);

    expect(storedLock(backend)).toBeUndefined();

    const second = createPlayerStore(definition(), {
      backend,
      owner: "server-b",
      nowMs: () => 2_000,
    });
    expect((await second.load(player)).ok).toBe(true);
  });

  it("reports a failed load instead of handing out a default document", async () => {
    const backend = createMemoryStoreBackend({
      player_42: { v: 1, t: 0, d: { coins: "junk" } },
    });
    const failures: string[] = [];
    const store = createPlayerStore(definition(), {
      backend,
      onLoadFailed: (_player, error) => failures.push(error.name),
    });

    const loaded = await store.load(player);
    expect(loaded.ok).toBe(false);
    expect(failures).toEqual(["StoreValidationError"]);
    expect(store.get(player)).toBeUndefined();
  });

  it("returns the same document for a repeated load", async () => {
    const store = createPlayerStore(definition(), { backend: createMemoryStoreBackend() });
    const first = await store.load(player);
    const second = await store.load(player);
    expect(first.ok && second.ok && first.value).toBe(second.ok ? second.value : undefined);
  });

  it("derives the key from the player and honours a custom key", async () => {
    const backend = createMemoryStoreBackend();
    const store = createPlayerStore(definition({ key: (target) => `p:${target.UserId}` }), {
      backend,
    });

    await store.load(player);
    expect(Object.keys(backend.snapshot())).toEqual(["p:42"]);
  });
});

describe("documents", () => {
  it("stages changes and flushes them on save", async () => {
    const backend = createMemoryStoreBackend();
    const store = createPlayerStore(definition(), { backend, owner: "server-a" });

    const loaded = await store.load(player);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    const document = loaded.value;

    expect(document.get()).toEqual({ coins: 0, name: "guest" });
    expect(document.update((current: Profile) => ({ ...current, coins: 5 })).ok).toBe(true);
    expect(document.isDirty()).toBe(true);

    expect((await document.save()).ok).toBe(true);
    expect(document.isDirty()).toBe(false);
    expect((backend.snapshot()["player_42"] as { d: unknown }).d).toEqual({
      coins: 5,
      name: "guest",
    });
  });

  it("rejects an invalid change without mutating the document", async () => {
    const store = createPlayerStore(definition(), { backend: createMemoryStoreBackend() });
    const loaded = await store.load(player);
    if (!loaded.ok) {
      throw new Error("expected the load to succeed");
    }

    const rejected = loaded.value.set({ coins: "lots", name: "ada" } as never);
    expect(rejected.ok === false && rejected.error.name).toBe("StoreValidationError");
    expect(loaded.value.get()).toEqual({ coins: 0, name: "guest" });
  });

  it("closes the document on release so a late write cannot resurrect it", async () => {
    const store = createPlayerStore(definition(), { backend: createMemoryStoreBackend() });
    const loaded = await store.load(player);
    if (!loaded.ok) {
      throw new Error("expected the load to succeed");
    }

    await store.release(player);
    expect(loaded.value.isActive()).toBe(false);

    const late = loaded.value.set({ coins: 99, name: "ada" });
    expect(late.ok === false && late.error.name).toBe("StoreClosedError");
  });

  it("refuses to write once another server has taken the lock", async () => {
    const backend = createMemoryStoreBackend();
    let clock = 1_000;
    const first = createPlayerStore(definition(), {
      backend,
      owner: "server-a",
      nowMs: () => clock,
    });

    const loaded = await first.load(player);
    if (!loaded.ok) {
      throw new Error("expected the load to succeed");
    }

    // The lock goes stale and a second server takes it over.
    clock = 30_000;
    const second = createPlayerStore(definition(), {
      backend,
      owner: "server-b",
      nowMs: () => clock,
    });
    await second.load(player);

    // The original server comes back and tries to flush its now-outdated value.
    loaded.value.update((current: Profile) => ({ ...current, coins: 100 }));
    const saved = await loaded.value.save();

    expect(saved.ok === false && saved.error.name).toBe("StoreLockedError");
    expect((backend.snapshot()["player_42"] as { d: { coins: number } }).d.coins).toBe(0);
  });

  it("skips the write when nothing changed", async () => {
    let updates = 0;
    const inner = createMemoryStoreBackend();
    const store = createPlayerStore(definition(), {
      backend: {
        get: inner.get,
        set: inner.set,
        remove: inner.remove,
        update(key, transform, userIds) {
          updates += 1;
          return inner.update(key, transform, userIds);
        },
      },
      owner: "server-a",
    });

    const loaded = await store.load(player);
    if (!loaded.ok) {
      throw new Error("expected the load to succeed");
    }

    const afterLoad = updates;
    expect((await loaded.value.save()).ok).toBe(true);
    expect(updates).toBe(afterLoad);
  });
});

describe("heartbeat", () => {
  it("refreshes the lock and flushes pending changes on every tick", async () => {
    const backend = createMemoryStoreBackend();
    const scheduler = manualScheduler();
    let clock = 1_000;
    const store = createPlayerStore(definition(), {
      backend,
      scheduler,
      owner: "server-a",
      nowMs: () => clock,
    });

    const loaded = await store.load(player);
    if (!loaded.ok) {
      throw new Error("expected the load to succeed");
    }
    loaded.value.update((current: Profile) => ({ ...current, coins: 7 }));

    clock = 5_000;
    scheduler.runAll();
    // Let the queued write settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(storedLock(backend)).toEqual({ owner: "server-a", heartbeatMs: 5_000 });
    expect((backend.snapshot()["player_42"] as { d: { coins: number } }).d.coins).toBe(7);
    // The next interval is armed, so the lock keeps being refreshed.
    expect(scheduler.pending()).toBe(1);
  });

  it("refreshes the lock even when the document is unchanged", async () => {
    const backend = createMemoryStoreBackend();
    const scheduler = manualScheduler();
    let clock = 1_000;
    const store = createPlayerStore(definition(), {
      backend,
      scheduler,
      owner: "server-a",
      nowMs: () => clock,
    });

    await store.load(player);
    clock = 6_000;
    scheduler.runAll();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(storedLock(backend)).toEqual({ owner: "server-a", heartbeatMs: 6_000 });
  });

  it("stops the heartbeat once the document is released", async () => {
    const scheduler = manualScheduler();
    const store = createPlayerStore(definition(), {
      backend: createMemoryStoreBackend(),
      scheduler,
      owner: "server-a",
    });

    await store.load(player);
    expect(scheduler.pending()).toBe(1);

    await store.release(player);
    expect(scheduler.pending()).toBe(0);
  });
});

describe("shutdown", () => {
  it("flushes every held document on saveAll", async () => {
    const backend = createMemoryStoreBackend();
    const store = createPlayerStore(definition(), { backend, owner: "server-a" });
    const other = { UserId: 43 };

    const first = await store.load(player);
    const second = await store.load(other);
    if (!first.ok || !second.ok) {
      throw new Error("expected both loads to succeed");
    }
    first.value.update((current: Profile) => ({ ...current, coins: 1 }));
    second.value.update((current: Profile) => ({ ...current, coins: 2 }));

    const results = await store.saveAll();
    expect(results.every((result) => result.ok)).toBe(true);
    expect((backend.snapshot()["player_42"] as { d: { coins: number } }).d.coins).toBe(1);
    expect((backend.snapshot()["player_43"] as { d: { coins: number } }).d.coins).toBe(2);
  });

  it("releases every lock on releaseAll", async () => {
    const backend = createMemoryStoreBackend();
    const store = createPlayerStore(definition(), { backend, owner: "server-a" });
    await store.load(player);
    await store.load({ UserId: 43 });

    await store.releaseAll();

    expect(storedLock(backend)).toBeUndefined();
    expect(storedLock(backend, "player_43")).toBeUndefined();
  });

  it("releases a player who left while the load was still in flight", async () => {
    const backend = createMemoryStoreBackend();
    const store = createPlayerStore(definition(), { backend, owner: "server-a" });

    const loading = store.load(player);
    const released = store.release(player);

    await loading;
    expect((await released).ok).toBe(true);
    expect(storedLock(backend)).toBeUndefined();
  });
});
