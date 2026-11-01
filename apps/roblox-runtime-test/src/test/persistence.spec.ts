// Player data across several stores: lifecycle, readiness, partial failure,
// locks, migrations, and the failures that must never overwrite a saved record.
// Every case runs the real store core and session lock over the test backend
// from `aruna/testing`.
import { defineAction } from "aruna/roblox";
import { schema } from "aruna/schema";
import {
  createPlayerStore,
  definePlayerStore,
  describeStoreError,
  requireStores,
  type PlayerStoresReport,
  type StoreScheduler,
} from "aruna/server";
import {
  createTestNetwork,
  createTestPlayer,
  createTestServerApp,
  createTestStoreBackend,
  describe,
  expect,
  it,
} from "aruna/testing";

// Heartbeats and retry backoffs never fire on their own: the cases here are
// about loads and releases, not timing.
const parked: StoreScheduler = { delay: () => ({ cancel: () => {} }) };
const OUTAGE = "403: API Services rejected the request (test outage)";

function frame(): Promise<void> {
  return new Promise<void>((resolve) => task.defer(resolve));
}

function progressDefinition() {
  return definePlayerStore({
    id: "player.progress",
    version: 2,
    schema: schema.object({ level: schema.u16(), xp: schema.u32().default(0) }),
    defaultValue: () => ({ level: 1, xp: 0 }),
    retry: { attempts: 1 },
    // One try at the lock: retries wait on the store scheduler, which is parked.
    session: { acquireAttempts: 1 },
    migrate: (stored, fromVersion) => {
      if (fromVersion === 1 && typeIs(stored, "table")) {
        const old = stored as { readonly lvl?: unknown };
        return typeIs(old.lvl, "number") ? { level: old.lvl, xp: 0 } : undefined;
      }
      return undefined;
    },
  });
}

function inventoryDefinition() {
  return definePlayerStore({
    id: "player.inventory",
    schema: schema.object({ items: schema.array(schema.string().maxLength(16)).maxItems(32) }),
    defaultValue: () => ({ items: [] as string[] }),
    retry: { attempts: 1 },
    session: { acquireAttempts: 1 },
  });
}

function stores(owner = "server-a") {
  const progressBackend = createTestStoreBackend(() => 1_000_000);
  const inventoryBackend = createTestStoreBackend(() => 1_000_000);
  const progress = createPlayerStore(progressDefinition(), {
    backend: progressBackend,
    owner,
    scheduler: parked,
    nowMs: () => 1_000_000,
  });
  const inventory = createPlayerStore(inventoryDefinition(), {
    backend: inventoryBackend,
    owner,
    scheduler: parked,
    nowMs: () => 1_000_000,
  });
  return { progress, inventory, progressBackend, inventoryBackend };
}

const grantItem = defineAction({
  id: "inventory.grant",
  input: schema.string().maxLength(16),
  run(ctx, item) {
    const inventory = ctx.stores?.["inventory"];
    const result = inventory!.update((current) => {
      const value = current as { items: string[] };
      return { items: [...value.items, item] };
    });
    return result.ok;
  },
});

describe("player stores: multi-store lifecycle", () => {
  it("loads every store on join, exposes them as ctx.stores, and releases them all on leave", async () => {
    const s = stores();
    const reports = new Array<PlayerStoresReport>();
    const harness = createTestServerApp({
      actions: { [grantItem.id]: grantItem },
      playerStores: { progress: s.progress, inventory: s.inventory },
      middleware: [requireStores("progress", "inventory")],
      onStoresReady: (_player, report) => reports.push(report),
    });
    const player = createTestPlayer({ userId: 7 });
    harness.join(player);
    await frame();

    expect(reports.size()).toBe(1);
    expect(reports[0]!.ok).toBe(true);
    const statuses = harness.app.stores!.status(player);
    expect(statuses["progress"]!.state).toBe("ready");
    expect(statuses["progress"]!.isNew).toBe(true);
    expect(statuses["inventory"]!.memoryOnly).toBe(true);
    expect(harness.app.stores!.isReady(player)).toBe(true);

    expect(await harness.invoke(player, "inventory.grant", "sword")).toBe(true);
    expect((s.inventory.get(player)!.get() as { items: string[] }).items).toEqual(["sword"]);

    harness.leave(player);
    await frame();
    for (const backend of [s.progressBackend, s.inventoryBackend]) {
      const record = backend.record("player_7");
      expect(record.kind).toBe("envelope");
      if (record.kind === "envelope") {
        expect(record.lock).toBe(undefined);
      }
    }
    const saved = s.inventoryBackend.record("player_7");
    expect(saved.kind === "envelope" && (saved.value as { items: string[] }).items[0]).toBe("sword");
    expect(harness.app.stores!.status(player)["inventory"]!.state).toBe("released");
    harness.dispose();
  });

  it("reports a partial failure, refuses actions that need the missing data, and writes nothing over it", async () => {
    const s = stores();
    s.inventoryBackend.seed("player_7", { items: ["heirloom"] });
    s.inventoryBackend.failAll("update", OUTAGE);
    const reports = new Array<PlayerStoresReport>();
    const harness = createTestServerApp({
      actions: { [grantItem.id]: grantItem },
      playerStores: { progress: s.progress, inventory: s.inventory },
      middleware: [requireStores("inventory")],
      onStoresReady: (_player, report) => reports.push(report),
    });
    const player = createTestPlayer({ userId: 7 });
    harness.join(player);
    await frame();

    expect(reports[0]!.ok).toBe(false);
    expect(reports[0]!.failed).toEqual(["inventory"]);
    expect(reports[0]!.errors["inventory"]!.name).toBe("StoreUnavailableError");
    expect(reports[0]!.statuses["progress"]!.state).toBe("ready");
    expect(harness.app.stores!.isReady(player, ["progress"])).toBe(true);
    expect(harness.app.stores!.isReady(player)).toBe(false);

    let refusal: { readonly name?: string; readonly message?: string } | undefined;
    await harness.invoke(player, "inventory.grant", "sword").catch((err: unknown) => {
      refusal = err as { name?: string; message?: string };
    });
    expect(refusal!.name).toBe("StoreNotReadyError");

    harness.leave(player);
    await frame();
    // The saved record is exactly what was there: never defaulted, never written.
    const record = s.inventoryBackend.record("player_7");
    expect(record.kind === "envelope" && (record.value as { items: string[] }).items).toEqual(["heirloom"]);
    expect(s.inventoryBackend.writes()).toBe(0);
    harness.dispose();
  });

  it("releases every store even when onPlayerRemoving throws", async () => {
    const s = stores();
    const harness = createTestServerApp({
      actions: {},
      playerStores: { progress: s.progress, inventory: s.inventory },
      onPlayerRemoving: () => {
        throw "hook bug";
      },
    });
    const player = createTestPlayer({ userId: 3 });
    harness.join(player);
    await frame();
    harness.leave(player);
    await frame();
    for (const backend of [s.progressBackend, s.inventoryBackend]) {
      const record = backend.record("player_3");
      expect(record.kind === "envelope" && record.lock === undefined).toBe(true);
    }
    harness.dispose();
  });
});

describe("player stores: locks and timing", () => {
  it("reports a live lock held by another server as locked, and leaves the record alone", async () => {
    const s = stores("server-b");
    const player = createTestPlayer({ userId: 6 });
    s.progressBackend.seed("player_6", { level: 2, xp: 0 }, { version: 2, lock: { owner: "server-a" } });
    await s.progress.load(player);
    const status = s.progress.status(player);
    expect(status.state).toBe("failed");
    expect(status.locked).toBe(true);
    const record = s.progressBackend.record("player_6");
    expect(record.kind === "envelope" && record.lock!.owner).toBe("server-a");
    expect(s.progressBackend.writes()).toBe(0);
    expect(describeStoreError(status.error!, { storeId: "player.progress", key: "player_6", operation: "lock" })).toBe(
      `[aruna store player.progress] lock player_6: StoreLockedError (retryable, retry after ${math.ceil(
        status.error!.retryAfterMs!,
      )}ms): ${status.error!.message}`,
    );
  });

  it("takes over a lock whose heartbeat went stale", async () => {
    const s = stores("server-b");
    const player = createTestPlayer({ userId: 8 });
    s.progressBackend.seed("player_8", { level: 4, xp: 2 }, { version: 2, lock: { owner: "crashed", heartbeatMs: 0 } });
    const result = await s.progress.load(player);
    expect(result.ok).toBe(true);
    const record = s.progressBackend.record("player_8");
    expect(record.kind === "envelope" && record.lock!.owner).toBe("server-b");
    expect((s.progress.get(player)!.get() as { level: number }).level).toBe(4);
  });

  it("releases a player who left mid-load, and waitFor does not lock them again", async () => {
    const s = stores();
    const player = createTestPlayer({ userId: 9 });
    s.progressBackend.hold("update");
    const loading = s.progress.load(player);
    expect(s.progress.status(player).state).toBe("loading");
    const released = s.progress.release(player);
    s.progressBackend.resume("update");
    await loading;
    expect((await released).ok).toBe(true);
    const waited = await s.progress.waitFor(player);
    expect(waited.ok).toBe(false);
    if (!waited.ok) {
      expect(waited.error.name).toBe("StoreClosedError");
    }
    const record = s.progressBackend.record("player_9");
    expect(record.kind === "envelope" && record.lock === undefined).toBe(true);
    expect(s.progress.status(player).state).toBe("released");
  });

  it("releases loads still in flight at shutdown", async () => {
    const s = stores();
    const player = createTestPlayer({ userId: 10 });
    s.progressBackend.hold("update");
    void s.progress.load(player);
    const shutdown = s.progress.releaseAll();
    s.progressBackend.resume("update");
    await shutdown;
    const record = s.progressBackend.record("player_10");
    expect(record.kind === "envelope" && record.lock === undefined).toBe(true);
  });

  it("keeps a document dirty when a save fails, and saves it on the next try", async () => {
    const s = stores();
    const player = createTestPlayer({ userId: 11 });
    await s.progress.load(player);
    const document = s.progress.get(player)!;
    document.set({ level: 2, xp: 50 });
    s.progressBackend.failNext("update", 1, OUTAGE);
    const failed = await document.save();
    expect(failed.ok).toBe(false);
    expect(document.isDirty()).toBe(true);
    const before = s.progressBackend.record("player_11");
    expect(before.kind === "envelope" && (before.value as { level: number }).level).toBe(1);
    expect((await document.save()).ok).toBe(true);
    const after = s.progressBackend.record("player_11");
    expect(after.kind === "envelope" && (after.value as { level: number }).level).toBe(2);
  });
});

describe("player stores: migrations and bad records", () => {
  it("migrates an old-version record forward and writes it back at the current version", async () => {
    const s = stores();
    const player = createTestPlayer({ userId: 20 });
    s.progressBackend.seed("player_20", { lvl: 12 }, { version: 1 });
    const result = await s.progress.load(player);
    expect(result.ok).toBe(true);
    expect(s.progress.get(player)!.get()).toEqual({ level: 12, xp: 0 });
    expect(s.progress.get(player)!.snapshot.migrated).toBe(true);
    const record = s.progressBackend.record("player_20");
    expect(record.kind === "envelope" && record.version).toBe(2);
  });

  it("fills a missing defaulted field", async () => {
    const s = stores();
    const player = createTestPlayer({ userId: 21 });
    s.progressBackend.seed("player_21", { level: 3 }, { version: 2 });
    expect((await s.progress.load(player)).ok).toBe(true);
    expect(s.progress.get(player)!.get()).toEqual({ level: 3, xp: 0 });
  });

  it("refuses an invalid record and a failed migration without overwriting either", async () => {
    for (const [key, seeded, version, expected] of [
      ["player_22", { level: "not a number" }, 2, "StoreValidationError"],
      ["player_23", { unknownShape: true }, 1, "StoreMigrationError"],
    ] as const) {
      const s = stores();
      const userId = tonumber(key.sub(8))!;
      const player = createTestPlayer({ userId });
      s.progressBackend.seed(key, seeded, { version });
      const result = await s.progress.load(player);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.name).toBe(expected);
      }
      expect(s.progress.status(player).state).toBe("failed");
      const record = s.progressBackend.record(key);
      expect(record.kind === "envelope" && record.value).toEqual(seeded);
      expect(s.progressBackend.writes()).toBe(0);
    }
  });

  it("refuses a second session while the first holds the lock", async () => {
    const backend = createTestStoreBackend(() => 1_000_000);
    const options = (owner: string) => ({ backend, owner, scheduler: parked, nowMs: () => 1_000_000 });
    const serverA = createPlayerStore(progressDefinition(), options("server-a"));
    const serverB = createPlayerStore(progressDefinition(), options("server-b"));
    const player = createTestPlayer({ userId: 30 });
    expect((await serverA.load(player)).ok).toBe(true);
    const second = await serverB.load(player);
    expect(second.ok).toBe(false);
    expect(serverB.status(player).locked).toBe(true);
    await serverA.release(player);
    expect((await serverB.load(player)).ok).toBe(true);
  });
});

describe("player stores: over the test network", () => {
  it("never overwrites saved data after a failed load, whatever the client does", async () => {
    const s = stores();
    s.inventoryBackend.seed("player_101", { items: ["relic"] });
    s.inventoryBackend.failAll("update", OUTAGE);
    const net = createTestNetwork({
      actions: { [grantItem.id]: grantItem },
      playerStores: { inventory: s.inventory },
      middleware: [requireStores("inventory")],
      players: [101],
    });
    let outcome = "pending";
    net
      .client(101)
      .invoke("inventory.grant", "dupe")
      .catch((err: unknown) => (outcome = (err as { name: string }).name));
    net.flush();
    await frame();
    expect(outcome).toBe("StoreNotReadyError");
    net.disconnect(101);
    await frame();
    const record = s.inventoryBackend.record("player_101");
    expect(record.kind === "envelope" && (record.value as { items: string[] }).items).toEqual(["relic"]);
    expect(s.inventoryBackend.writes()).toBe(0);
    net.dispose();
  });
});

describe("player stores: failure paths", () => {
  it("still reports readiness when onLoadFailed throws, and the load does not stay in flight", async () => {
    const backend = createTestStoreBackend(() => 1_000_000);
    backend.failAll("update", OUTAGE);
    const progress = createPlayerStore(progressDefinition(), {
      backend,
      owner: "server-a",
      scheduler: parked,
      nowMs: () => 1_000_000,
      onLoadFailed: () => {
        throw "handler exploded";
      },
    });
    const reports = new Array<PlayerStoresReport>();
    const harness = createTestServerApp({
      actions: {},
      playerStores: { progress },
      onStoresReady: (_player, report) => reports.push(report),
    });
    const player = createTestPlayer({ userId: 11 });
    harness.join(player);
    await frame();
    expect(reports.size()).toBe(1);
    expect(reports[0]!.failed).toEqual(["progress"]);
    expect(progress.status(player).state).toBe("failed");
    harness.dispose();
  });

  it("keeps no failure for a player released while their load was failing", async () => {
    const s = stores();
    const player = createTestPlayer({ userId: 12 });
    s.progressBackend.hold("update");
    const loading = s.progress.load(player);
    const released = s.progress.release(player);
    s.progressBackend.failAll("update", OUTAGE);
    s.progressBackend.resume("update");
    expect((await loading).ok).toBe(false);
    await released;
    expect(s.progress.status(player).state).toBe("released");
    const waited = await s.progress.waitFor(player);
    expect(!waited.ok && waited.error.name).toBe("StoreClosedError");
  });

  it("does not name the server's stores in the refusal a client sees", async () => {
    const s = stores();
    s.inventoryBackend.failAll("update", OUTAGE);
    const harness = createTestServerApp({
      actions: { [grantItem.id]: grantItem },
      playerStores: { progress: s.progress, inventory: s.inventory },
      middleware: [requireStores("inventory")],
    });
    const player = createTestPlayer({ userId: 13 });
    harness.join(player);
    await frame();
    let message: string | undefined;
    await harness.invoke(player, "inventory.grant", "sword").catch((err: unknown) => {
      message = (err as { message?: string }).message;
    });
    expect(message).toBe("Aruna action inventory.grant needs player data that is not loaded yet.");
    harness.dispose();
  });
});
