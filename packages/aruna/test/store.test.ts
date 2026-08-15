import { describe, expect, it } from "vitest";
import { schema } from "../src/schema.js";
import {
  createMemoryStoreBackend,
  createStore,
  decodeStoreValue,
  encodeStoreValue,
  findStoreValueViolation,
  runStoreRequest,
  storeRetryDelayMs,
  validateStoreKey,
  type StoreBackend,
  type StoreDefinition,
  type StoreScheduler,
} from "../src/runtime/store.js";

const profileSchema = schema.object({
  coins: schema.number(),
  name: schema.string(),
});

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
  delay(_ms, callback) {
    callback();
    return { cancel: () => undefined };
  },
};

function failingBackend(
  failures: number,
  error: unknown = "DataStoreService: 502 request failed",
): StoreBackend & { readonly calls: () => number } {
  const inner = createMemoryStoreBackend();
  let calls = 0;

  return {
    calls: () => calls,
    get(key) {
      calls += 1;
      if (calls <= failures) {
        return Promise.reject(error);
      }
      return inner.get(key);
    },
    set: inner.set,
    update: inner.update,
    remove: inner.remove,
  };
}

describe("store keys and values", () => {
  it("rejects keys the DataStore would reject", () => {
    expect(validateStoreKey("").ok).toBe(false);
    expect(validateStoreKey("a".repeat(51)).ok).toBe(false);
    expect(validateStoreKey("player_1").ok).toBe(true);
  });

  it("rejects values a DataStore cannot encode", () => {
    expect(findStoreValueViolation({ coins: 1 })).toBeUndefined();
    expect(findStoreValueViolation({ coins: Number.NaN })).toContain("NaN");
    expect(findStoreValueViolation({ run: () => undefined })).toContain("function");
    expect(
      findStoreValueViolation({ part: { IsA: () => true, ClassName: "Part" } }),
    ).toContain("Roblox Instance");
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
    expect(first.ok && second.ok && first.value.value).not.toBe(
      second.ok ? second.value.value : undefined,
    );
  });

  it("fails rather than resetting when the stored value is corrupt", () => {
    const decoded = decodeStoreValue(profileStore(), { v: 1, t: 0, d: { coins: "lots" } });
    expect(decoded.ok).toBe(false);
    expect(decoded.ok === false && decoded.error.name).toBe("StoreValidationError");
  });

  it("fails when a record is older than the store and no migrate is declared", () => {
    const decoded = decodeStoreValue(profileStore({ version: 2 }), {
      v: 1,
      t: 0,
      d: { coins: 5, name: "a" },
    });
    expect(decoded.ok === false && decoded.error.name).toBe("StoreMigrationError");
  });

  it("migrates an older record forward", () => {
    const definition = profileStore({
      version: 2,
      migrate: (stored, from) =>
        from === 1 ? { coins: (stored as { coins: number }).coins, name: "migrated" } : undefined,
    });

    const decoded = decodeStoreValue(definition, { v: 1, t: 0, d: { coins: 7 } });
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
    const decoded = decodeStoreValue(definition, { v: 1, t: 0, d: {} });
    expect(decoded.ok === false && decoded.error.name).toBe("StoreMigrationError");
  });

  it("fails when migrate throws instead of letting the throw escape", () => {
    const definition = profileStore({
      version: 2,
      migrate: () => {
        throw new Error("bad migration");
      },
    });
    const decoded = decodeStoreValue(definition, { v: 1, t: 0, d: {} });
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
      get(key) {
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
    const errors: string[] = [];
    const store = createStore(profileStore({ retry: { attempts: 1 } }), {
      backend: failingBackend(10),
      scheduler: immediateScheduler,
      onError: (error, info) => errors.push(`${info.operation}:${error.name}`),
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
    expect(storeRetryDelayMs(1, retry, () => 0.999_999)).toBeCloseTo(150, 3);
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

    const stored = backend.snapshot()["player_1"] as { v: number; d: unknown };
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

    const saved = await store.save("k", { blob: "x".repeat(4_200_000) });
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
    const backend = createMemoryStoreBackend({ player_1: { v: 1, t: 0, d: { coins: "junk" } } });
    const store = createStore(profileStore(), { backend });

    const saved = await store.save("player_1", { coins: 1, name: "ada" });
    expect(saved.ok === false && saved.error.name).toBe("StoreValidationError");
    // The corrupt record is still there: a human can inspect it instead of it
    // having been silently replaced.
    expect(backend.snapshot()["player_1"]).toEqual({ v: 1, t: 0, d: { coins: "junk" } });
  });

  it("carries an existing session lock through a save", async () => {
    const backend = createMemoryStoreBackend({
      player_1: { v: 1, t: 0, d: { coins: 1, name: "ada" }, lock: { owner: "s1", heartbeatMs: 5 } },
    });
    const store = createStore(profileStore(), { backend });

    await store.save("player_1", { coins: 2, name: "ada" });

    const stored = backend.snapshot()["player_1"] as { lock?: unknown };
    expect(stored.lock).toEqual({ owner: "s1", heartbeatMs: 5 });
  });

  it("removes a key", async () => {
    const backend = createMemoryStoreBackend();
    const store = createStore(profileStore(), { backend });
    await store.save("player_1", { coins: 1, name: "ada" });

    const removed = await store.remove("player_1");
    expect(removed.ok).toBe(true);
    expect(backend.snapshot()["player_1"]).toBeUndefined();
  });
});
