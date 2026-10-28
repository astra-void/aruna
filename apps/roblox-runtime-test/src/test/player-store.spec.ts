// The session-locked player document: lock acquisition inside the load, stale
// takeover, staged writes, the heartbeat autosave, and shutdown. Port of
// packages/aruna/test/player-store.test.ts against the native runtime's
// in-memory backend.
import { schema } from "aruna/schema";
import {
  createMemoryStoreBackend,
  createPlayerStore,
  type MemoryStoreBackend,
  type PlayerStoreDefinition,
  type StoreBackend,
  type StoreScheduler,
} from "aruna/server";
import { describe, expect, it } from "aruna/testing";

const profileSchema = schema.object({
  coins: schema.number(),
  name: schema.string(),
});

type Profile = { readonly coins: number; readonly name: string };

type FakePlayer = { readonly UserId: number };

const player: FakePlayer = { UserId: 42 };

function definition(
  overrides?: Partial<PlayerStoreDefinition<typeof profileSchema, FakePlayer>>,
): PlayerStoreDefinition<typeof profileSchema, FakePlayer> {
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
  let callbacks = new Array<() => void>();
  return {
    delay: (_ms, callback) => {
      callbacks.push(callback);
      return {
        cancel: () => {
          callbacks = callbacks.filter((entry) => entry !== callback);
        },
      };
    },
    runAll: () => {
      const queued = callbacks;
      callbacks = new Array<() => void>();
      for (const callback of queued) {
        callback();
      }
    },
    pending: () => callbacks.size(),
  };
}

// For the cases the Node suite runs without a scheduler. The Node runtime arms
// no heartbeat then; the native one falls back to a real `task.delay`, and a
// live timer would both write behind the spec's back and keep Lune from
// draining. So heartbeats (the 1s interval) are parked and never fire, while
// the short lock-acquire retry delay still runs on a real timer.
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

// Holds every UpdateAsync until `open()`, so a load is genuinely in flight
// (the native memory backend otherwise settles synchronously).
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

// The persisted lock (`l: { o, h }`), in the runtime's long-name form.
function storedLock(backend: MemoryStoreBackend, key = "player_42"): unknown {
  const stored = backend.snapshot().get(key) as { l?: { o: string; h: number } } | undefined;
  const lock = stored !== undefined ? stored.l : undefined;
  return lock !== undefined ? { owner: lock.o, heartbeatMs: lock.h } : undefined;
}

function storedCoins(backend: MemoryStoreBackend, key = "player_42"): number {
  return (backend.snapshot().get(key) as { d: { coins: number } }).d.coins;
}

// One scheduler frame: the native counterpart of `setTimeout(resolve, 0)`.
function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    task.defer(() => resolve());
  });
}

describe("session locking", () => {
  it("acquires the lock as part of the load", async () => {
    const backend = createMemoryStoreBackend();
    const store = createPlayerStore(definition(), {
      backend,
      owner: "server-a",
      nowMs: () => 1_000,
      scheduler: parkedHeartbeats(),
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
      scheduler: parkedHeartbeats(),
    });
    await first.load(player);

    const second = createPlayerStore(definition(), {
      backend,
      owner: "server-b",
      // Well inside the 10s TTL.
      nowMs: () => 3_000,
      scheduler: parkedHeartbeats(),
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
      scheduler: parkedHeartbeats(),
    });
    await first.load(player);

    const second = createPlayerStore(definition(), {
      backend,
      owner: "server-b",
      // Past the 10s TTL: the previous holder is gone.
      nowMs: () => 20_000,
      scheduler: parkedHeartbeats(),
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
      scheduler: parkedHeartbeats(),
    });
    await first.load(player);
    await first.release(player);

    expect(storedLock(backend)).toBeUndefined();

    const second = createPlayerStore(definition(), {
      backend,
      owner: "server-b",
      nowMs: () => 2_000,
      scheduler: parkedHeartbeats(),
    });
    expect((await second.load(player)).ok).toBe(true);
  });

  it("reports a failed load instead of handing out a default document", async () => {
    const backend = createMemoryStoreBackend(
      entries({ player_42: { "$aruna": 1, v: 1, t: 0, d: { coins: "junk" } } }),
    );
    const failures = new Array<string>();
    const store = createPlayerStore(definition(), {
      backend,
      scheduler: parkedHeartbeats(),
      onLoadFailed: (_player, failure) => {
        failures.push(failure.name);
      },
    });

    const loaded = await store.load(player);
    expect(loaded.ok).toBe(false);
    expect(failures).toEqual(["StoreValidationError"]);
    expect(store.get(player)).toBeUndefined();
  });

  it("treats a record from a newer version as a failed load: no default, no lock, no write", async () => {
    // A player saved at v3 by an updated server joins an old v2 server.
    const newer = { "$aruna": 1, v: 3, t: 0, d: { coins: 500, name: "ada" } };
    const backend = createMemoryStoreBackend(entries({ player_42: newer }));
    const failures = new Array<string>();
    let migrateCalls = 0;
    const store = createPlayerStore(
      definition({
        version: 2,
        migrate: (stored) => {
          migrateCalls += 1;
          return stored as Profile;
        },
      }),
      {
        backend,
        scheduler: parkedHeartbeats(),
        onLoadFailed: (_player, failure) => {
          failures.push(failure.name);
        },
      },
    );

    const loaded = await store.load(player);
    expect(loaded.ok === false && loaded.error.name).toBe("StoreVersionAheadError");
    expect(failures).toEqual(["StoreVersionAheadError"]);
    expect(store.get(player)).toBeUndefined();
    expect(migrateCalls).toBe(0);
    // Untouched: not even the session lock was written.
    expect(backend.snapshot().get("player_42")).toEqual(newer);
    expect(storedLock(backend)).toBeUndefined();

    await store.release(player);
    expect(backend.snapshot().get("player_42")).toEqual(newer);
  });

  it("returns the same document for a repeated load", async () => {
    const store = createPlayerStore(definition(), {
      backend: createMemoryStoreBackend(),
      scheduler: parkedHeartbeats(),
    });
    const first = await store.load(player);
    const second = await store.load(player);
    expect(first.ok && second.ok).toBe(true);
    expect(first.ok && second.ok && first.value).toBe(second.ok ? second.value : undefined);
  });

  it("derives the key from the player and honours a custom key", async () => {
    const backend = createMemoryStoreBackend();
    const store = createPlayerStore(definition({ key: (target) => `p:${target.UserId}` }), {
      backend,
      scheduler: parkedHeartbeats(),
    });

    await store.load(player);
    const keys = new Array<string>();
    for (const [key] of backend.snapshot()) {
      keys.push(key);
    }
    expect(keys).toEqual(["p:42"]);
  });
});

describe("documents", () => {
  it("stages changes and flushes them on save", async () => {
    const backend = createMemoryStoreBackend();
    const store = createPlayerStore(definition(), {
      backend,
      owner: "server-a",
      scheduler: parkedHeartbeats(),
    });

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
    expect((backend.snapshot().get("player_42") as { d: unknown }).d).toEqual({
      coins: 5,
      name: "guest",
    });
  });

  it("rejects an invalid change without mutating the document", async () => {
    const store = createPlayerStore(definition(), {
      backend: createMemoryStoreBackend(),
      scheduler: parkedHeartbeats(),
    });
    const loaded = await store.load(player);
    if (!loaded.ok) {
      throw "expected the load to succeed";
    }

    const rejected = loaded.value.set({ coins: "lots", name: "ada" } as never);
    expect(rejected.ok === false && rejected.error.name).toBe("StoreValidationError");
    expect(loaded.value.get()).toEqual({ coins: 0, name: "guest" });
  });

  it("closes the document on release so a late write cannot resurrect it", async () => {
    const store = createPlayerStore(definition(), {
      backend: createMemoryStoreBackend(),
      scheduler: parkedHeartbeats(),
    });
    const loaded = await store.load(player);
    if (!loaded.ok) {
      throw "expected the load to succeed";
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
      scheduler: parkedHeartbeats(),
    });

    const loaded = await first.load(player);
    if (!loaded.ok) {
      throw "expected the load to succeed";
    }

    // The lock goes stale and a second server takes it over.
    clock = 30_000;
    const second = createPlayerStore(definition(), {
      backend,
      owner: "server-b",
      nowMs: () => clock,
      scheduler: parkedHeartbeats(),
    });
    await second.load(player);

    // The original server comes back and tries to flush its now-outdated value.
    loaded.value.update((current: Profile) => ({ ...current, coins: 100 }));
    const saved = await loaded.value.save();

    expect(saved.ok === false && saved.error.name).toBe("StoreLockedError");
    expect(storedCoins(backend)).toBe(0);
  });

  it("skips the write when nothing changed", async () => {
    let updates = 0;
    const inner = createMemoryStoreBackend();
    const store = createPlayerStore(definition(), {
      backend: {
        get: inner.get,
        set: inner.set,
        remove: inner.remove,
        update: (key, transform, userIds) => {
          updates += 1;
          return inner.update(key, transform, userIds);
        },
      },
      owner: "server-a",
      scheduler: parkedHeartbeats(),
    });

    const loaded = await store.load(player);
    if (!loaded.ok) {
      throw "expected the load to succeed";
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
      throw "expected the load to succeed";
    }
    loaded.value.update((current: Profile) => ({ ...current, coins: 7 }));

    clock = 5_000;
    scheduler.runAll();
    // Let the queued write settle.
    await nextFrame();

    expect(storedLock(backend)).toEqual({ owner: "server-a", heartbeatMs: 5_000 });
    expect(storedCoins(backend)).toBe(7);
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
    await nextFrame();

    expect(storedLock(backend)).toEqual({ owner: "server-a", heartbeatMs: 6_000 });
  });

  it("skips an idle tick until the lock is half the TTL old", async () => {
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
    // TTL 10s: an unchanged document at 4s past the lock write has no reason to
    // write yet.
    clock = 5_000;
    scheduler.runAll();
    await nextFrame();
    expect(storedLock(backend)).toEqual({ owner: "server-a", heartbeatMs: 1_000 });
    expect(scheduler.pending()).toBe(1);

    // At half the TTL the refresh goes out.
    clock = 6_000;
    scheduler.runAll();
    await nextFrame();
    expect(storedLock(backend)).toEqual({ owner: "server-a", heartbeatMs: 6_000 });
  });

  it("carries the framework metadata through the lock, heartbeat, and release", async () => {
    const meta = { r: ["receipt-1"], h: { k: "token", x: 50 } };
    const backend = createMemoryStoreBackend(
      entries({ player_42: { "$aruna": 1, v: 1, t: 0, d: { coins: 3, name: "ada" }, m: meta } }),
    );
    const scheduler = manualScheduler();
    let clock = 1_000;
    const store = createPlayerStore(definition(), {
      backend,
      scheduler,
      owner: "server-a",
      nowMs: () => clock,
    });

    const loaded = await store.load(player);
    expect(loaded.ok && loaded.value.snapshot.meta.receipts).toEqual(["receipt-1"]);
    expect((backend.snapshot().get("player_42") as { m: unknown }).m).toEqual(meta);

    if (loaded.ok) {
      loaded.value.update((current) => ({ ...current, coins: 4 }));
    }
    clock = 2_000;
    scheduler.runAll();
    await nextFrame();
    expect((backend.snapshot().get("player_42") as { m: unknown }).m).toEqual(meta);

    await store.release(player);
    const stored = backend.snapshot().get("player_42") as { d: Profile; m: unknown; l?: unknown };
    expect(stored.d.coins).toBe(4);
    expect(stored.m).toEqual(meta);
    expect(stored.l).toBeUndefined();
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
    const store = createPlayerStore(definition(), {
      backend,
      owner: "server-a",
      scheduler: parkedHeartbeats(),
    });
    const other: FakePlayer = { UserId: 43 };

    const first = await store.load(player);
    const second = await store.load(other);
    if (!first.ok || !second.ok) {
      throw "expected both loads to succeed";
    }
    first.value.update((current: Profile) => ({ ...current, coins: 1 }));
    second.value.update((current: Profile) => ({ ...current, coins: 2 }));

    const results = await store.saveAll();
    expect(results.size()).toBe(2);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(storedCoins(backend, "player_42")).toBe(1);
    expect(storedCoins(backend, "player_43")).toBe(2);
  });

  it("releases every lock on releaseAll", async () => {
    const backend = createMemoryStoreBackend();
    const store = createPlayerStore(definition(), {
      backend,
      owner: "server-a",
      scheduler: parkedHeartbeats(),
    });
    await store.load(player);
    await store.load({ UserId: 43 });
    // Both locks are held before the release, so its effect is observable.
    expect(storedLock(backend)).toBeDefined();
    expect(storedLock(backend, "player_43")).toBeDefined();

    await store.releaseAll();

    expect(storedLock(backend)).toBeUndefined();
    expect(storedLock(backend, "player_43")).toBeUndefined();
  });

  it("releases a player who left while the load was still in flight", async () => {
    const inner = createMemoryStoreBackend();
    const gate = gatedBackend(inner);
    const store = createPlayerStore(definition(), {
      backend: gate.backend,
      owner: "server-a",
      scheduler: parkedHeartbeats(),
    });

    const loading = store.load(player);
    const released = store.release(player);
    // The locked read has not landed yet: this is the mid-load leave.
    expect(store.get(player)).toBeUndefined();
    gate.open();

    await loading;
    expect((await released).ok).toBe(true);
    // The load did land (and wrote its lock); the release then cleared it.
    expect(inner.snapshot().get("player_42")).toBeDefined();
    expect(storedLock(inner)).toBeUndefined();
  });
});
