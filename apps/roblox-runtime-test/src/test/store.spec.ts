// The DataStore core: key and value checks, the versioned envelope, migrations,
// the retry and budget policy, and the no-blind-overwrite write path. Port of
// packages/aruna/test/store.test.ts against the native runtime's in-memory
// backend (`createMemoryStoreBackend`).
import { schema } from "aruna/schema";
import {
  createMemoryStoreBackend,
  createStore,
  decodeStoreValue,
  encodeStoreValue,
  findStoreValueViolation,
  hasStoreReceipt,
  readStoreRecord,
  recordStoreReceipt,
  runStoreRequest,
  STORE_MAX_PRESERVED_META_BYTES,
  STORE_MAX_RECEIPTS,
  storeRetryDelayMs,
  validateStoreKey,
  type StoreBackend,
  type StoreDefinition,
  type StoreMeta,
  type StoreScheduler,
} from "aruna/server";
import { describe, expect, it } from "aruna/testing";

const profileSchema = schema.object({
  coins: schema.number(),
  name: schema.string(),
});

type Profile = { coins: number; name: string };

function profileStore(
  overrides?: Partial<StoreDefinition<typeof profileSchema>>,
): StoreDefinition<typeof profileSchema> {
  return {
    id: "player.profile",
    schema: profileSchema,
    defaultValue: { coins: 0, name: "guest" },
    ...overrides,
  };
}

// Runs every scheduled callback immediately, so retry backoff costs no real
// time in tests while still exercising the delay path.
const immediateScheduler: StoreScheduler = {
  delay: (_ms, callback) => {
    callback();
    return { cancel: () => undefined };
  },
};

function failingBackend(
  failures: number,
  failure: unknown = "DataStoreService: 502 request failed",
): StoreBackend & { readonly calls: () => number } {
  const inner = createMemoryStoreBackend();
  let calls = 0;

  return {
    calls: () => calls,
    get: (key) => {
      calls += 1;
      if (calls <= failures) {
        return Promise.reject(failure);
      }
      return inner.get(key);
    },
    set: inner.set,
    update: inner.update,
    remove: inner.remove,
  };
}

function entries(initial: Record<string, unknown>): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const [key, value] of pairs(initial)) {
    map.set(key as string, value);
  }
  return map;
}

describe("store keys and values", () => {
  it("rejects keys the DataStore would reject", () => {
    expect(validateStoreKey("").ok).toBe(false);
    expect(validateStoreKey("a".rep(51)).ok).toBe(false);
    expect(validateStoreKey("player_1").ok).toBe(true);
  });

  it("rejects values a DataStore cannot encode", () => {
    expect(findStoreValueViolation({ coins: 1 })).toBeUndefined();
    expect(findStoreValueViolation({ run: () => undefined })).toContain("function");
    // The Node runtime recognises an Instance structurally ({ IsA, ClassName });
    // the native one asks typeof, so this table is refused as what it really is,
    // a table holding a function. A real Instance cannot be constructed from a
    // roblox-ts spec under Lune (see the mapping note).
    const duckPart = findStoreValueViolation({ part: { IsA: () => true, ClassName: "Part" } });
    expect(duckPart).toBeDefined();
    expect(duckPart).toContain("part");
    // The retired Node runtime printed "NaN"; native spells it as Luau's tostring does.
    const nanViolation = findStoreValueViolation({ coins: 0 / 0 });
    expect(nanViolation).toContain("nan");
    expect(nanViolation).toBe("coins is nan, which DataStores cannot encode");
  });

  it("accepts a value shared by two paths but rejects a cycle", () => {
    const shared = { coins: 1 };
    expect(findStoreValueViolation({ a: shared, b: shared })).toBeUndefined();

    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(findStoreValueViolation(cyclic)).toContain("cycle");
  });

  it("refuses to encode a value that does not match the schema", () => {
    const encoded = encodeStoreValue(profileStore(), { coins: "many", name: "a" }, 0);
    expect(encoded.ok).toBe(false);
    expect(encoded.ok === false && encoded.error.name).toBe("StoreValidationError");
  });
});

describe("decoding", () => {
  it("returns the default for a key that was never written", () => {
    const decoded = decodeStoreValue(profileStore(), undefined);
    expect(decoded.ok && decoded.value.existed).toBe(false);
    expect(decoded.ok && decoded.value.value).toEqual({ coins: 0, name: "guest" });
  });

  it("calls a default factory per read so mutable defaults are not shared", () => {
    const definition = profileStore({ defaultValue: () => ({ coins: 0, name: "guest" }) });
    const first = decodeStoreValue(definition, undefined);
    const second = decodeStoreValue(definition, undefined);
    expect(first.ok && second.ok).toBe(true);
    expect(first.ok && first.value.value).not.toBe(second.ok ? second.value.value : undefined);
  });

  it("fails rather than resetting when the stored value is corrupt", () => {
    const decoded = decodeStoreValue(profileStore(), { "$aruna": 1, v: 1, t: 0, d: { coins: "lots" } });
    expect(decoded.ok).toBe(false);
    expect(decoded.ok === false && decoded.error.name).toBe("StoreValidationError");
  });

  it("fails when a record is older than the store and no migrate is declared", () => {
    const decoded = decodeStoreValue(profileStore({ version: 2 }), {
      "$aruna": 1,
      v: 1,
      t: 0,
      d: { coins: 5, name: "a" },
    });
    expect(decoded.ok === false && decoded.error.name).toBe("StoreMigrationError");
  });

  it("refuses a record from a newer version without calling migrate", () => {
    let migrateCalls = 0;
    const definition = profileStore({
      version: 2,
      migrate: (stored) => {
        migrateCalls += 1;
        return stored as Profile;
      },
    });

    const decoded = decodeStoreValue(definition, { "$aruna": 1, v: 3, t: 0, d: { coins: 5, name: "a" } });
    expect(decoded.ok).toBe(false);
    expect(decoded.ok === false && decoded.error.name).toBe("StoreVersionAheadError");
    expect(decoded.ok === false && decoded.error.retryable).toBe(false);
    expect(decoded.ok === false && decoded.error.message).toContain("version 3");
    expect(migrateCalls).toBe(0);
  });

  it("never writes back over a record from a newer version", async () => {
    const newer = { "$aruna": 1, v: 3, t: 0, d: { coins: 500, name: "from the future" } };
    const backend = createMemoryStoreBackend(entries({ ada: newer }));
    let migrateCalls = 0;
    const store = createStore(
      profileStore({
        version: 2,
        migrate: (stored) => {
          migrateCalls += 1;
          return stored as Profile;
        },
      }),
      { backend },
    );

    const loaded = await store.load("ada");
    const saved = await store.save("ada", { coins: 1, name: "ada" });
    const updated = await store.update("ada", (current) => ({ ...current, coins: 2 }));

    expect(loaded.ok === false && loaded.error.name).toBe("StoreVersionAheadError");
    expect(saved.ok === false && saved.error.name).toBe("StoreVersionAheadError");
    expect(updated.ok === false && updated.error.name).toBe("StoreVersionAheadError");
    expect(migrateCalls).toBe(0);
    expect(backend.snapshot().get("ada")).toEqual(newer);
  });

  it("migrates an older record forward", () => {
    const definition = profileStore({
      version: 2,
      migrate: (stored, from) =>
        from === 1 ? { coins: (stored as { coins: number }).coins, name: "migrated" } : undefined,
    });

    const decoded = decodeStoreValue(definition, { "$aruna": 1, v: 1, t: 0, d: { coins: 7 } });
    expect(decoded.ok && decoded.value.migrated).toBe(true);
    expect(decoded.ok && decoded.value.value).toEqual({ coins: 7, name: "migrated" });
  });

  it("treats a raw pre-Aruna value as version 0 and migrates it", () => {
    const definition = profileStore({
      migrate: (stored, from) =>
        from === 0 ? { coins: (stored as { coins: number }).coins, name: "adopted" } : undefined,
    });

    const decoded = decodeStoreValue(definition, { coins: 3 });
    expect(decoded.ok && decoded.value.value).toEqual({ coins: 3, name: "adopted" });
  });

  it("fails when migrate cannot handle the record", () => {
    const definition = profileStore({ version: 2, migrate: () => undefined });
    const decoded = decodeStoreValue(definition, { "$aruna": 1, v: 1, t: 0, d: {} });
    expect(decoded.ok === false && decoded.error.name).toBe("StoreMigrationError");
  });

  it("fails when migrate throws instead of letting the throw escape", () => {
    const definition = profileStore({
      version: 2,
      migrate: () => {
        throw "bad migration";
      },
    });
    const decoded = decodeStoreValue(definition, { "$aruna": 1, v: 1, t: 0, d: {} });
    expect(decoded.ok === false && decoded.error.message).toContain("bad migration");
  });
});

describe("request policy", () => {
  it("retries a transient failure and then succeeds", async () => {
    const backend = failingBackend(2);
    const store = createStore(profileStore(), { backend, scheduler: immediateScheduler });

    const loaded = await store.load("player_1");
    expect(loaded.ok).toBe(true);
    expect(backend.calls()).toBe(3);
  });

  it("does not retry a permanent failure", async () => {
    const backend = failingBackend(10, "403: Studio access to APIs is not enabled");
    const store = createStore(profileStore(), { backend, scheduler: immediateScheduler });

    const loaded = await store.load("player_1");
    expect(loaded.ok === false && loaded.error.name).toBe("StoreUnavailableError");
    expect(loaded.ok === false && loaded.error.retryable).toBe(false);
    expect(backend.calls()).toBe(1);
  });

  it("gives up after the attempt budget and reports the failure", async () => {
    const backend = failingBackend(10);
    const store = createStore(profileStore({ retry: { attempts: 2 } }), {
      backend,
      scheduler: immediateScheduler,
    });

    const loaded = await store.load("player_1");
    expect(loaded.ok === false && loaded.error.name).toBe("StoreRequestError");
    expect(backend.calls()).toBe(2);
  });

  it("waits out an exhausted request budget instead of spending the request", async () => {
    const inner = createMemoryStoreBackend();
    let budget = 0;
    let gets = 0;
    const backend: StoreBackend = {
      get: (key) => {
        gets += 1;
        return inner.get(key);
      },
      set: inner.set,
      update: inner.update,
      remove: inner.remove,
      getBudget: () => {
        // Empty on the first check, replenished by the time the retry lands.
        budget += 1;
        return budget > 1 ? 10 : 0;
      },
    };

    const store = createStore(profileStore(), { backend, scheduler: immediateScheduler });
    const loaded = await store.load("player_1");

    expect(loaded.ok).toBe(true);
    expect(gets).toBe(1);
  });

  it("reports a failure once through onError", async () => {
    const errors = new Array<string>();
    const store = createStore(profileStore({ retry: { attempts: 1 } }), {
      backend: failingBackend(10),
      scheduler: immediateScheduler,
      onError: (failure, info) => {
        errors.push(`${info.operation}:${failure.name}`);
      },
    });

    await store.load("player_1");
    expect(errors).toEqual(["load:StoreRequestError"]);
  });

  it("grows the backoff and keeps it under the cap", () => {
    const retry = { baseDelayMs: 100, maxDelayMs: 400, jitter: 0 };
    expect(storeRetryDelayMs(1, retry)).toBe(100);
    expect(storeRetryDelayMs(2, retry)).toBe(200);
    expect(storeRetryDelayMs(3, retry)).toBe(400);
    expect(storeRetryDelayMs(9, retry)).toBe(400);
  });

  it("keeps jittered delays inside the band around the capped delay", () => {
    const retry = { baseDelayMs: 100, maxDelayMs: 1_000, jitter: 0.5 };
    expect(storeRetryDelayMs(1, retry, () => 0)).toBe(50);
    // toBeCloseTo(150, 3): within 0.0005.
    const high = storeRetryDelayMs(1, retry, () => 0.999_999);
    expect(math.abs(high - 150) < 0.0005).toBe(true);
  });

  it("surfaces a non-retryable classification without spending attempts", async () => {
    let calls = 0;
    const result = await runStoreRequest(
      () => {
        calls += 1;
        return Promise.reject("403 forbidden");
      },
      { kind: "get", scheduler: immediateScheduler },
    );

    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });
});

describe("writes", () => {
  it("round-trips a value through a versioned envelope", async () => {
    const backend = createMemoryStoreBackend();
    const store = createStore(profileStore({ version: 3 }), { backend });

    const saved = await store.save("player_1", { coins: 10, name: "ada" });
    expect(saved.ok).toBe(true);

    const stored = backend.snapshot().get("player_1") as { v: number; d: unknown };
    expect(stored.v).toBe(3);
    expect(stored.d).toEqual({ coins: 10, name: "ada" });

    const loaded = await store.load("player_1");
    expect(loaded.ok && loaded.value).toEqual({ coins: 10, name: "ada" });
  });

  it("refuses a write that does not match the schema and leaves the record alone", async () => {
    const backend = createMemoryStoreBackend();
    const store = createStore(profileStore(), { backend });
    await store.save("player_1", { coins: 1, name: "ada" });

    const saved = await store.save("player_1", { coins: "lots", name: "ada" } as never);
    expect(saved.ok === false && saved.error.name).toBe("StoreValidationError");

    const loaded = await store.load("player_1");
    expect(loaded.ok && loaded.value).toEqual({ coins: 1, name: "ada" });
  });

  it("refuses a write larger than the DataStore value limit", async () => {
    const bigSchema = schema.object({ blob: schema.string() });
    const store = createStore(
      { id: "big", schema: bigSchema, defaultValue: { blob: "" } },
      { backend: createMemoryStoreBackend() },
    );

    const saved = await store.save("k", { blob: "x".rep(4_200_000) });
    expect(saved.ok === false && saved.error.name).toBe("StoreSerializationError");
  });

  it("updates read-modify-write against the stored value", async () => {
    const store = createStore(profileStore(), { backend: createMemoryStoreBackend() });
    await store.save("player_1", { coins: 5, name: "ada" });

    const updated = await store.update("player_1", (current) => ({
      ...current,
      coins: current.coins + 3,
    }));

    expect(updated.ok && updated.value.coins).toBe(8);
  });

  it("refuses to write over a record it could not decode", async () => {
    const backend = createMemoryStoreBackend(
      entries({ player_1: { "$aruna": 1, v: 1, t: 0, d: { coins: "junk" } } }),
    );
    const store = createStore(profileStore(), { backend });

    const saved = await store.save("player_1", { coins: 1, name: "ada" });
    expect(saved.ok === false && saved.error.name).toBe("StoreValidationError");
    // The corrupt record is still there: a human can inspect it instead of it
    // having been silently replaced.
    expect(backend.snapshot().get("player_1")).toEqual({ "$aruna": 1, v: 1, t: 0, d: { coins: "junk" } });
  });

  it("carries an existing session lock through a save", async () => {
    const backend = createMemoryStoreBackend(
      entries({
        player_1: {
          "$aruna": 1,
          v: 1,
          t: 0,
          d: { coins: 1, name: "ada" },
          l: { o: "s1", h: 5 },
        },
      }),
    );
    const store = createStore(profileStore(), { backend });

    await store.save("player_1", { coins: 2, name: "ada" });

    const stored = backend.snapshot().get("player_1") as { l?: unknown };
    expect(stored.l).toEqual({ o: "s1", h: 5 });
  });

  it("removes a key", async () => {
    const backend = createMemoryStoreBackend();
    const store = createStore(profileStore(), { backend });
    await store.save("player_1", { coins: 1, name: "ada" });

    const removed = await store.remove("player_1");
    expect(removed.ok).toBe(true);
    expect(backend.snapshot().get("player_1")).toBeUndefined();
  });
});

// Persisted format v1 (docs/stores.md): the three ways a stored value is read,
// the framework metadata slot, and its bounds.
describe("persisted format v1", () => {
  function receiptIds(count: number, from = 1): Array<string> {
    const ids = new Array<string>();
    for (let index = from; index < from + count; index += 1) {
      ids.push(`receipt-${index}`);
    }
    return ids;
  }

  it("round-trips an envelope v1", async () => {
    const backend = createMemoryStoreBackend();
    const store = createStore(profileStore({ version: 2 }), { backend, nowMs: () => 1_234 });

    await store.save("ada", { coins: 4, name: "ada" });
    // Exactly the v1 fields: the marker, the user version, the data, the write
    // time. No metadata or lock was set, so neither is written.
    expect(backend.snapshot().get("ada")).toEqual({
      "$aruna": 1,
      v: 2,
      t: 1_234,
      d: { coins: 4, name: "ada" },
    });

    const loaded = await store.loadSnapshot("ada");
    expect(loaded.ok && loaded.value.value).toEqual({ coins: 4, name: "ada" });
    expect(loaded.ok && loaded.value.version).toBe(2);
    expect(loaded.ok && loaded.value.migrated).toBe(false);
    expect(loaded.ok && loaded.value.updatedAtMs).toBe(1_234);
    expect(loaded.ok && loaded.value.meta.receipts).toEqual([]);
  });

  it("adopts a raw legacy value at version 0 through migrate, then writes it as v1", async () => {
    const seen = new Array<number>();
    const backend = createMemoryStoreBackend(entries({ ada: { gold: 9 } }));
    const store = createStore(
      profileStore({
        migrate: (stored, from) => {
          seen.push(from);
          return { coins: (stored as { gold: number }).gold, name: "adopted" };
        },
      }),
      { backend, nowMs: () => 5 },
    );

    const loaded = await store.loadSnapshot("ada");
    expect(loaded.ok && loaded.value.version).toBe(0);
    expect(loaded.ok && loaded.value.value).toEqual({ coins: 9, name: "adopted" });
    expect(seen).toEqual([0]);

    await store.save("ada", { coins: 9, name: "adopted" });
    expect(backend.snapshot().get("ada")).toEqual({
      "$aruna": 1,
      v: 1,
      t: 5,
      d: { coins: 9, name: "adopted" },
    });
    const reloaded = await store.loadSnapshot("ada");
    expect(reloaded.ok && reloaded.value.version).toBe(1);
    expect(reloaded.ok && reloaded.value.value).toEqual({ coins: 9, name: "adopted" });
  });

  it("does not mistake { v: 1, t: 2 } for an envelope", async () => {
    const lookalike = { v: 1, t: 2 };
    expect(readStoreRecord(lookalike).kind).toBe("legacy");

    // The whole table is the legacy value: migrate sees it, at version 0.
    let migrated: unknown;
    let migratedFrom = -1;
    const backend = createMemoryStoreBackend(entries({ ada: lookalike }));
    const store = createStore(
      profileStore({
        migrate: (stored, from) => {
          migrated = stored;
          migratedFrom = from;
          return { coins: 0, name: "adopted" };
        },
      }),
      { backend },
    );

    const loaded = await store.loadSnapshot("ada");
    expect(loaded.ok && loaded.value.version).toBe(0);
    expect(migrated).toEqual({ v: 1, t: 2 });
    expect(migratedFrom).toBe(0);

    // And it round-trips: saved, it becomes a v1 envelope that reads back as one.
    await store.save("ada", { coins: 1, name: "adopted" });
    expect(readStoreRecord(backend.snapshot().get("ada")).kind).toBe("envelope");
    const reloaded = await store.load("ada");
    expect(reloaded.ok && reloaded.value).toEqual({ coins: 1, name: "adopted" });
  });

  it("treats a value that fails the marker check as raw legacy", () => {
    const lookalikes: Array<unknown> = [
      { v: 1, t: 2, d: { coins: 1, name: "a" } },
      { "$aruna": "1", v: 1, t: 2, d: { coins: 1, name: "a" } },
      { "$aruna": 0, v: 1, t: 2, d: { coins: 1, name: "a" } },
      { "$aruna": 1.5, v: 1, t: 2, d: { coins: 1, name: "a" } },
      7,
      "text",
    ];
    for (const value of lookalikes) {
      expect(readStoreRecord(value).kind).toBe("legacy");
    }

    // Without a migrate, an adopted value is a migration failure, never read as
    // the data it seems to wrap.
    const decoded = decodeStoreValue(profileStore(), lookalikes[0]);
    expect(decoded.ok === false && decoded.error.name).toBe("StoreMigrationError");
  });

  it("refuses a malformed v1 envelope instead of adopting it", () => {
    let migrateCalls = 0;
    const definition = profileStore({
      migrate: () => {
        migrateCalls += 1;
        return { coins: 0, name: "x" };
      },
    });
    const malformed: Array<unknown> = [
      { "$aruna": 1, v: "1", t: 0, d: {} },
      { "$aruna": 1, v: 1, d: {} },
      { "$aruna": 1, v: 1, t: 0, d: {}, m: { "!r": "receipt" } },
      { "$aruna": 1, v: 1, t: 0, d: {}, l: { o: 5, h: 0 } },
      { "$aruna": 1, v: 1, t: 0, d: {}, m: [1, 2] },
    ];
    for (const value of malformed) {
      const decoded = decodeStoreValue(definition, value);
      expect(decoded.ok === false && decoded.error.name).toBe("StoreValidationError");
    }
    expect(migrateCalls).toBe(0);
  });

  it("keeps the metadata slot untouched through a user migrate and the save after it", async () => {
    // Every key this runtime reads, plus one a newer Aruna added: may-ignore
    // (no `!`), so it is carried through as it was.
    const meta = {
      "!r": ["receipt-1", "receipt-2"],
      h: { k: "handoff-token", x: 99_000 },
      e: 42,
      future: { region: "eu", n: [1, 2] },
    };
    const backend = createMemoryStoreBackend(
      entries({ ada: { "$aruna": 1, v: 1, t: 0, d: { coins: 7 }, m: meta } }),
    );
    let migrateInput: unknown;
    const store = createStore(
      profileStore({
        version: 2,
        migrate: (stored) => {
          migrateInput = stored;
          // A careless migrate that copies everything it is given: it must not
          // be given the metadata to copy.
          return { ...(stored as object), coins: (stored as { coins: number }).coins, name: "v2" } as Profile;
        },
      }),
      { backend },
    );

    const loaded = await store.loadSnapshot("ada");
    expect(migrateInput).toEqual({ coins: 7 });
    expect(loaded.ok && loaded.value.migrated).toBe(true);
    expect(loaded.ok && loaded.value.meta).toEqual({
      receipts: ["receipt-1", "receipt-2"],
      handoff: { token: "handoff-token", expiresAtMs: 99_000 },
      erasedAtMs: 42,
      preserved: { future: { region: "eu", n: [1, 2] } },
    });

    await store.update("ada", (current) => ({ ...current, coins: current.coins + 1 }));
    const stored = backend.snapshot().get("ada") as { v: number; d: unknown; m: unknown };
    expect(stored.v).toBe(2);
    expect(stored.d).toEqual({ coins: 8, name: "v2" });
    expect(stored.m).toEqual(meta);
  });

  it("evicts the oldest receipt ids beyond the bound", () => {
    let meta: StoreMeta = { receipts: [] };
    for (const id of receiptIds(STORE_MAX_RECEIPTS + 5)) {
      const recorded = recordStoreReceipt(meta, id);
      expect(recorded.ok).toBe(true);
      if (recorded.ok) {
        meta = recorded.value;
      }
    }
    expect(meta.receipts.size()).toBe(STORE_MAX_RECEIPTS);
    expect(meta.receipts[0]).toBe("receipt-6");
    expect(hasStoreReceipt(meta, "receipt-5")).toBe(false);
    expect(hasStoreReceipt(meta, `receipt-${STORE_MAX_RECEIPTS + 5}`)).toBe(true);

    // Recording an id already there changes nothing.
    const again = recordStoreReceipt(meta, "receipt-50");
    expect(again.ok && again.value.receipts).toEqual(meta.receipts);
    // An id outside the size bound is refused rather than stored.
    expect(recordStoreReceipt(meta, "").ok).toBe(false);
    expect(recordStoreReceipt(meta, "x".rep(129)).ok).toBe(false);
  });

  it("enforces the receipt bound on a record that holds too many", async () => {
    const backend = createMemoryStoreBackend(
      entries({
        ada: {
          "$aruna": 1,
          v: 1,
          t: 0,
          d: { coins: 1, name: "ada" },
          m: { "!r": receiptIds(STORE_MAX_RECEIPTS + 3) },
        },
      }),
    );
    const store = createStore(profileStore(), { backend });

    const loaded = await store.loadSnapshot("ada");
    expect(loaded.ok && loaded.value.meta.receipts.size()).toBe(STORE_MAX_RECEIPTS);
    expect(loaded.ok && loaded.value.meta.receipts[0]).toBe("receipt-4");

    await store.save("ada", { coins: 2, name: "ada" });
    const stored = backend.snapshot().get("ada") as { m: { "!r": Array<string> } };
    expect(stored.m["!r"]).toEqual(receiptIds(STORE_MAX_RECEIPTS, 4));
  });

  it("refuses a record in a newer envelope format without migrating or writing it", async () => {
    const ahead = { "$aruna": 2, v: 1, t: 0, d: { coins: 1, name: "ada" }, x: "new field" };
    const backend = createMemoryStoreBackend(entries({ ada: ahead }));
    let migrateCalls = 0;
    const store = createStore(
      profileStore({
        migrate: (stored) => {
          migrateCalls += 1;
          return stored as Profile;
        },
      }),
      { backend },
    );

    const loaded = await store.load("ada");
    const saved = await store.save("ada", { coins: 2, name: "ada" });
    expect(loaded.ok === false && loaded.error.name).toBe("StoreVersionAheadError");
    expect(loaded.ok === false && loaded.error.message).toContain("envelope format 2");
    expect(saved.ok === false && saved.error.name).toBe("StoreVersionAheadError");
    expect(migrateCalls).toBe(0);
    expect(backend.snapshot().get("ada")).toEqual(ahead);
  });

  it("still refuses a v1 envelope at a newer user version", async () => {
    const newer = { "$aruna": 1, v: 5, t: 0, d: { coins: 1, name: "ada" } };
    const backend = createMemoryStoreBackend(entries({ ada: newer }));
    const store = createStore(profileStore({ version: 4, migrate: (stored) => stored as Profile }), {
      backend,
    });

    const loaded = await store.load("ada");
    expect(loaded.ok === false && loaded.error.name).toBe("StoreVersionAheadError");
    expect(loaded.ok === false && loaded.error.message).toContain("version 5");
    expect(backend.snapshot().get("ada")).toEqual(newer);
  });
  it("carries an unknown may-ignore metadata key through load, update, save, and a receipt", async () => {
    const backend = createMemoryStoreBackend(
      entries({
        ada: { "$aruna": 1, v: 1, t: 0, d: { coins: 1, name: "ada" }, m: { "next.flag": true } },
      }),
    );
    const store = createStore(profileStore(), { backend, nowMs: () => 10 });

    const loaded = await store.loadSnapshot("ada");
    expect(loaded.ok && loaded.value.meta.preserved).toEqual({ "next.flag": true });
    await store.update("ada", (current) => ({ ...current, coins: current.coins + 1 }));
    await store.save("ada", { coins: 5, name: "ada" });
    expect(backend.snapshot().get("ada")).toEqual({
      "$aruna": 1,
      v: 1,
      t: 10,
      d: { coins: 5, name: "ada" },
      m: { "next.flag": true },
    });

    // The framework changing its own metadata leaves the unknown key alone.
    const reloaded = await store.loadSnapshot("ada");
    const recorded = reloaded.ok ? recordStoreReceipt(reloaded.value.meta, "receipt-1") : undefined;
    expect(recorded !== undefined && recorded.ok).toBe(true);
    const encoded =
      recorded !== undefined && recorded.ok
        ? encodeStoreValue(profileStore(), { coins: 5, name: "ada" }, 11, undefined, recorded.value)
        : undefined;
    expect(encoded !== undefined && encoded.ok && (encoded.value as { m: unknown }).m).toEqual({
      "next.flag": true,
      "!r": ["receipt-1"],
    });
  });

  it("refuses a must-understand metadata key it does not know, and never writes the record back", async () => {
    const ahead = {
      "$aruna": 1,
      v: 1,
      t: 0,
      d: { coins: 1, name: "ada" },
      m: { "!r": ["receipt-1"], "!grants": { pending: 2 } },
    };
    expect(readStoreRecord(ahead)).toEqual({ kind: "meta-ahead", key: "!grants" });
    const backend = createMemoryStoreBackend(entries({ ada: ahead }));
    let migrateCalls = 0;
    const store = createStore(
      profileStore({
        version: 2,
        migrate: (stored) => {
          migrateCalls += 1;
          return stored as Profile;
        },
      }),
      { backend },
    );

    const loaded = await store.load("ada");
    const saved = await store.save("ada", { coins: 2, name: "ada" });
    const updated = await store.update("ada", (current) => current);
    for (const result of [loaded, saved, updated]) {
      expect(result.ok === false && result.error.name).toBe("StoreVersionAheadError");
    }
    expect(loaded.ok === false && loaded.error.message).toContain('"!grants"');
    expect(migrateCalls).toBe(0);
    expect(backend.snapshot().get("ada")).toEqual(ahead);
  });

  it("refuses preserved metadata over the bound rather than truncating it", async () => {
    // `{"k":"…"}` is 8 bytes plus the string: at the bound it is carried, one
    // byte over it is refused.
    const atBound = { "$aruna": 1, v: 1, t: 0, d: { coins: 1, name: "ada" }, m: { k: "x".rep(STORE_MAX_PRESERVED_META_BYTES - 8) } };
    const overBound = { "$aruna": 1, v: 1, t: 0, d: { coins: 1, name: "ada" }, m: { k: "x".rep(STORE_MAX_PRESERVED_META_BYTES - 7) } };
    expect(readStoreRecord(atBound).kind).toBe("envelope");
    expect(readStoreRecord(overBound).kind).toBe("malformed");

    const backend = createMemoryStoreBackend(entries({ ada: overBound }));
    const store = createStore(profileStore(), { backend });
    const loaded = await store.load("ada");
    const saved = await store.save("ada", { coins: 2, name: "ada" });
    expect(loaded.ok === false && loaded.error.name).toBe("StoreValidationError");
    expect(loaded.ok === false && loaded.error.message).toContain(`${STORE_MAX_PRESERVED_META_BYTES}-byte bound`);
    expect(saved.ok === false && saved.error.name).toBe("StoreValidationError");
    expect(backend.snapshot().get("ada")).toEqual(overBound);
  });

  it("refuses a v1 envelope with an unknown top-level field", async () => {
    const extra = { "$aruna": 1, v: 1, t: 0, d: { coins: 1, name: "ada" }, x: "not v1" };
    expect(readStoreRecord(extra)).toEqual({ kind: "malformed", reason: "unknown top-level field x" });
    const backend = createMemoryStoreBackend(entries({ ada: extra }));
    const store = createStore(profileStore(), { backend });
    const loaded = await store.load("ada");
    const saved = await store.save("ada", { coins: 2, name: "ada" });
    expect(loaded.ok === false && loaded.error.name).toBe("StoreValidationError");
    expect(saved.ok === false && saved.error.name).toBe("StoreValidationError");
    expect(backend.snapshot().get("ada")).toEqual(extra);
  });
});
