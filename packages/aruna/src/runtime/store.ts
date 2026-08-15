// Aruna reference runtime — the safe DataStore core.
//
// The safety properties this module owns, and why each exists:
//
//   * No throwing. Every operation resolves with a `StoreResult`. A DataStore
//     outage mid-session must not unwind a game thread through code that never
//     expected persistence to fail.
//   * No blind overwrite. A read that fails — request error, corrupt payload,
//     schema mismatch, failed migration — never degrades into "start from the
//     default and save over it". Data loss is the one failure mode a store
//     cannot apologize for, so a failed load yields an error, not a value.
//   * Bounded retries. Transient DataStore failures are retried with capped
//     exponential backoff and jitter; permanent ones (no API access, oversized
//     payload, bad key) are not retried at all.
//   * Budget awareness. When the backend reports a request budget, an exhausted
//     budget waits instead of burning the request and eating a throttle.
//   * Versioned payloads. Every write carries a version and a timestamp, so an
//     older record can be migrated forward instead of silently reinterpreted.
//
// The Roblox DataStoreService adapter lives in the native runtime
// (`aruna/roblox`); this module is backend-agnostic and drives an in-memory
// backend under test.

import { applyDefaults, validateSchema, type Infer, type Schema } from "../schema/index.js";

// Roblox limits: a key is at most 50 characters and a serialized value at most
// 4 MB. Both are enforced before the request leaves, so an oversized write
// fails locally with a clear error rather than as an opaque DataStore throw.
export const STORE_MAX_KEY_LENGTH = 50;
export const STORE_MAX_VALUE_BYTES = 4_194_304;

// Depth cap for the storability walk, matching the action serialization policy.
// A cyclic table would otherwise recurse forever before the DataStore rejected it.
const STORE_MAX_DEPTH = 32;

// The value type a store holds. Identical to `Infer<TSchema>` once TSchema is
// concrete, but written as a conditional so TypeScript defers evaluating it
// while TSchema is still a type parameter — `Infer` is deep enough that eager
// instantiation inside the store's generic plumbing trips the checker's
// instantiation limit. Same technique as ActionSchemaInput in the action runtime.
//
// The first branch is the same guard applied to the un-narrowed schema: a holder
// that names `Store<Schema>` or `PlayerStore<Schema>` — `createServerApp` does,
// since it owns a player store without knowing its shape — asks for the value
// type of *every* schema, and `Infer` distributes over that union and recurses
// through each nested `Schema` until the checker gives up with TS2589. The
// answer it would arrive at is `unknown` (several branches widen to it), so this
// short-circuits to `unknown` instead of computing it. `Schema extends TSchema`
// holds only for that un-narrowed case; a concrete schema still gets `Infer`.
export type StoreValue<TSchema extends Schema> = Schema extends TSchema
  ? unknown
  : [TSchema] extends [Schema]
    ? Infer<TSchema>
    : never;

export type StoreOperation = "load" | "save" | "update" | "remove" | "lock" | "release";

export type StoreErrorName =
  // The DataStore API is unreachable for this place: Studio without "Enable
  // Studio Access to API Services", an unpublished place, a 403. Not retryable —
  // retrying cannot grant access.
  | "StoreUnavailableError"
  // Request budget exhausted or the service throttled us. Retryable.
  | "StoreThrottledError"
  // The request itself failed (network, 5xx, an unclassified DataStore throw).
  // Retryable by default; `retryable` carries the verdict.
  | "StoreRequestError"
  // The stored payload does not match the store's schema after defaults and
  // migration. Never resolved by retrying, and deliberately not resolved by
  // falling back to the default value either — see the no-blind-overwrite rule.
  | "StoreValidationError"
  // A value handed to the store cannot be persisted: a function, an Instance,
  // NaN, a cycle, or a payload over the size limit.
  | "StoreSerializationError"
  // `migrate` threw, or returned a value that failed validation.
  | "StoreMigrationError"
  // The key is empty or longer than the DataStore limit.
  | "StoreKeyError"
  // Another live server holds the session lock for this key.
  | "StoreLockedError"
  // The document was released (player left, server shutting down) and can no
  // longer be written through.
  | "StoreClosedError";

export type StoreError = {
  readonly name: StoreErrorName;
  readonly message: string;
  // Whether another attempt could plausibly succeed. Drives the retry loop and
  // tells a caller whether to surface "try again" or "contact support".
  readonly retryable: boolean;
  // How many attempts were spent before giving up (1 when the failure was
  // decided without a request).
  readonly attempts?: number;
  // For throttling and lock contention: how long to wait before retrying.
  readonly retryAfterMs?: number;
  // The raw failure the backend produced, for logging. Never inspected by the
  // runtime beyond classification.
  readonly cause?: unknown;
};

export type StoreSuccess<TValue> = { readonly ok: true; readonly value: TValue };

// Split out from the union so a failure can be returned from a function of any
// result type without a cast: `StoreFailure` is assignable to every
// `StoreResult<T>`, which keeps the error paths free of `as` noise.
export type StoreFailure = { readonly ok: false; readonly error: StoreError };

export type StoreResult<TValue> = StoreSuccess<TValue> | StoreFailure;

export function storeOk<TValue>(value: TValue): StoreSuccess<TValue> {
  return { ok: true, value };
}

export function storeFail(
  name: StoreErrorName,
  message: string,
  details?: {
    readonly retryable?: boolean;
    readonly attempts?: number;
    readonly retryAfterMs?: number;
    readonly cause?: unknown;
  },
): StoreFailure {
  return {
    ok: false,
    error: {
      name,
      message,
      retryable: details?.retryable ?? false,
      ...(details?.attempts !== undefined ? { attempts: details.attempts } : {}),
      ...(details?.retryAfterMs !== undefined ? { retryAfterMs: details.retryAfterMs } : {}),
      ...(details?.cause !== undefined ? { cause: details.cause } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Storability
// ---------------------------------------------------------------------------

// What DataStore payloads may contain. Deliberately narrower than the action
// wire policy: RemoteEvents carry Vector3/CFrame/Instance, DataStores carry only
// what JSON survives.
export type StorableValue =
  | undefined
  | string
  | number
  | boolean
  | readonly StorableValue[]
  | { readonly [key: string]: StorableValue };

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function isRobloxInstanceLike(value: object): boolean {
  const candidate = value as { readonly IsA?: unknown; readonly ClassName?: unknown };
  return typeof candidate.IsA === "function" && typeof candidate.ClassName === "string";
}

function describePath(path: readonly string[]): string {
  return path.length === 0 ? "<root>" : path.join(".");
}

// Returns a human-readable reason when `value` cannot be persisted, or undefined
// when it can. Walks the whole tree: a single unserializable leaf makes the
// whole write fail locally instead of at the DataStore.
//
// `seen` is the chain of ancestors, not every object visited: a value reachable
// by two different paths is fine (JSON duplicates it), while a value that
// contains itself is not.
export function findStoreValueViolation(
  value: unknown,
  path: readonly string[] = [],
  seen: readonly object[] = [],
): string | undefined {
  if (path.length > STORE_MAX_DEPTH) {
    return `${describePath(path)} exceeds the maximum store value depth of ${STORE_MAX_DEPTH}`;
  }

  if (value === undefined || value === null) {
    return undefined;
  }

  const kind = typeof value;
  if (kind === "string" || kind === "boolean") {
    return undefined;
  }

  if (kind === "number") {
    return Number.isFinite(value as number)
      ? undefined
      : `${describePath(path)} is ${String(value)}, which DataStores cannot encode`;
  }

  if (kind !== "object") {
    return `${describePath(path)} is a ${kind}, which DataStores cannot encode`;
  }

  const objectValue = value as object;
  if (seen.includes(objectValue)) {
    return `${describePath(path)} is part of a cycle, which DataStores cannot encode`;
  }
  if (isRobloxInstanceLike(objectValue)) {
    return `${describePath(path)} is a Roblox Instance, which DataStores cannot encode`;
  }

  const nextSeen = [...seen, objectValue];

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const violation = findStoreValueViolation(
        value[index],
        [...path, String(index)],
        nextSeen,
      );
      if (violation !== undefined) {
        return violation;
      }
    }
    return undefined;
  }

  if (!isPlainObject(objectValue)) {
    return `${describePath(path)} is a non-plain object, which DataStores cannot encode`;
  }

  for (const key of Object.keys(objectValue)) {
    const violation = findStoreValueViolation(objectValue[key], [...path, key], nextSeen);
    if (violation !== undefined) {
      return violation;
    }
  }

  return undefined;
}

// Approximates the serialized size the DataStore will see. The native runtime
// measures with HttpService:JSONEncode; here JSON.stringify is the same shape.
export function measureStoreValueBytes(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 0 : encoded.length;
  } catch {
    // A value that cannot be encoded is caught by findStoreValueViolation; treat
    // an encoder failure here as "unbounded" so the size check rejects it too.
    return Number.POSITIVE_INFINITY;
  }
}

export function validateStoreKey(key: string): StoreResult<string> {
  if (key.length === 0) {
    return storeFail("StoreKeyError", "Store keys cannot be empty.");
  }
  if (key.length > STORE_MAX_KEY_LENGTH) {
    return storeFail(
      "StoreKeyError",
      `Store key ${JSON.stringify(key)} is ${key.length} characters; DataStore keys are limited to ${STORE_MAX_KEY_LENGTH}.`,
    );
  }
  return storeOk(key);
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

// The session lock a player store writes alongside the data. Kept in the
// envelope (not a sibling key) so acquiring the lock and reading the data are
// one atomic UpdateAsync rather than two racing requests.
export type StoreLockState = {
  // Identifies the holding server: `${jobId}:${placeId}` in production, a test
  // id under Lune/vitest.
  readonly owner: string;
  // When the holder last proved it was alive. A lock whose heartbeat is older
  // than the TTL is stale and may be taken over.
  readonly heartbeatMs: number;
};

// The persisted shape. Field names are single characters because every byte
// counts against the 4 MB per-key budget and this wrapper is pure overhead.
export type StoreEnvelope = {
  readonly v: number;
  readonly d: unknown;
  readonly t: number;
  readonly lock?: StoreLockState;
};

export function isStoreLockState(value: unknown): value is StoreLockState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { readonly owner?: unknown; readonly heartbeatMs?: unknown };
  return typeof candidate.owner === "string" && typeof candidate.heartbeatMs === "number";
}

export function isStoreEnvelope(value: unknown): value is StoreEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { readonly v?: unknown; readonly t?: unknown };
  return typeof candidate.v === "number" && typeof candidate.t === "number";
}

export function createStoreEnvelope(
  version: number,
  data: unknown,
  nowMs: number,
  lock?: StoreLockState,
): StoreEnvelope {
  return {
    v: version,
    d: data,
    t: nowMs,
    ...(lock !== undefined ? { lock } : {}),
  };
}

// What a decoded record carries beyond its value: enough for a caller to tell a
// first-time key from an existing one, and a migrated record from a current one.
export type StoreSnapshot<TValue> = {
  readonly value: TValue;
  // False when the key held nothing and `value` is the store's default.
  readonly existed: boolean;
  // The version the record was stored at (0 for a pre-Aruna raw value).
  readonly version: number;
  readonly migrated: boolean;
  readonly updatedAtMs: number | undefined;
  readonly lock: StoreLockState | undefined;
};

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

// Migrates a record written at an older version forward. Returning undefined
// means "I cannot migrate this", which surfaces as a StoreMigrationError rather
// than a silent reset to the default.
export type StoreMigrate<TSchema extends Schema> = (
  stored: unknown,
  fromVersion: number,
) => StoreValue<TSchema> | undefined;

export type StoreRetryOptions = {
  // Total attempts, including the first. 1 disables retrying.
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  // Fraction of the computed delay to randomize, 0..1. Spreads the retry storm
  // when a whole server's requests fail at once.
  readonly jitter?: number;
};

export const DEFAULT_STORE_RETRY: Required<StoreRetryOptions> = {
  attempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  jitter: 0.25,
};

export type StoreDefinition<TSchema extends Schema = Schema> = {
  // The DataStore name. Also the id the compiler records and `aruna inspect
  // stores` reports, so it must be a static string literal.
  readonly id: string;
  readonly scope?: string;
  readonly schema: TSchema;
  // Bumped by the author when the shape changes; records written at a lower
  // version are handed to `migrate`. Defaults to 1.
  readonly version?: number;
  readonly migrate?: StoreMigrate<TSchema>;
  // The value a key that has never been written resolves to. A factory is
  // called per key, so mutable defaults are not shared between players.
  readonly defaultValue: StoreValue<TSchema> | (() => StoreValue<TSchema>);
  readonly retry?: StoreRetryOptions;
  // Roblox user ids to associate with each write, for the GDPR right-to-erasure
  // tooling. Player stores default this to the owning player.
  readonly userIds?: (key: string) => readonly number[];
};

// Takes the version field rather than the whole definition: a parameter typed
// `StoreDefinition<Schema>` forces TypeScript to compare the deep `Infer` type
// of every caller's schema against it, which blows the instantiation limit.
export function resolveStoreVersion(definition: { readonly version?: number }): number {
  const version = definition.version;
  return version === undefined || !Number.isFinite(version) ? 1 : Math.floor(version);
}

// Erased on purpose. Inferring `StoreValue<TSchema>` through a generic call here is
// what pushes the checker past its instantiation limit, and this helper only
// forwards the value: callers that know the schema assert the result, which is
// free. Returns the declared default, calling it first when it is a factory so
// mutable defaults are never shared between keys.
export function resolveStoreDefault(definition: { readonly defaultValue: unknown }): unknown {
  const fallback = definition.defaultValue;
  return typeof fallback === "function" ? (fallback as () => unknown)() : fallback;
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export type StoreBackendRequestKind = "get" | "set" | "update" | "remove";

// The transform contract mirrors DataStore:UpdateAsync — returning undefined
// cancels the write and leaves the stored value untouched.
export type StoreBackendTransform = (current: unknown) => unknown;

export type StoreBackend = {
  readonly get: (key: string) => Promise<unknown>;
  readonly set: (key: string, value: unknown, userIds?: readonly number[]) => Promise<void>;
  readonly update: (
    key: string,
    transform: StoreBackendTransform,
    userIds?: readonly number[],
  ) => Promise<unknown>;
  readonly remove: (key: string) => Promise<void>;
  // Remaining requests of this kind, when the backend can report it
  // (DataStoreService:GetRequestBudgetForRequestType). A backend that omits it
  // is treated as unmetered.
  readonly getBudget?: (kind: StoreBackendRequestKind) => number;
};

// Receives only what a backend needs to resolve its data store — the name and
// scope — rather than the whole definition, so building one costs no generic
// instantiation.
export type StoreBackendFactory = (definition: {
  readonly id: string;
  readonly scope?: string;
}) => StoreBackend;

export type MemoryStoreBackend = StoreBackend & {
  readonly snapshot: () => Record<string, unknown>;
  readonly reset: () => void;
};

// An in-memory backend with DataStore semantics. Used by the test suite, and by
// the native runtime as the Studio fallback when API access is off — a game that
// runs in Studio should not have to special-case persistence at every call site.
export function createMemoryStoreBackend(
  initial?: Readonly<Record<string, unknown>>,
): MemoryStoreBackend {
  let entries = new Map<string, unknown>(Object.entries(initial ?? {}));

  return {
    get(key) {
      return Promise.resolve(entries.get(key));
    },
    set(key, value) {
      entries.set(key, value);
      return Promise.resolve();
    },
    update(key, transform) {
      const current = entries.get(key);
      const next = transform(current);
      if (next === undefined) {
        // Matches UpdateAsync: a nil transform result cancels the write.
        return Promise.resolve(current);
      }
      entries.set(key, next);
      return Promise.resolve(next);
    },
    remove(key) {
      entries.delete(key);
      return Promise.resolve();
    },
    snapshot() {
      return Object.fromEntries(entries);
    },
    reset() {
      entries = new Map<string, unknown>();
    },
  };
}

// ---------------------------------------------------------------------------
// Scheduling and retry
// ---------------------------------------------------------------------------

export type StoreSchedulerHandle = { readonly cancel: () => void };

// Deferred execution, injectable so tests drive time directly and the native
// runtime can hand over `task.delay`.
export type StoreScheduler = {
  readonly delay: (ms: number, callback: () => void) => StoreSchedulerHandle;
};

export const defaultStoreScheduler: StoreScheduler = {
  delay(ms, callback) {
    const timer = setTimeout(callback, ms);
    return {
      cancel() {
        clearTimeout(timer);
      },
    };
  },
};

export function storeDelay(scheduler: StoreScheduler, ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    scheduler.delay(ms, resolve);
  });
}

function resolveRetry(options: StoreRetryOptions | undefined): Required<StoreRetryOptions> {
  const attempts = options?.attempts;
  const baseDelayMs = options?.baseDelayMs;
  const maxDelayMs = options?.maxDelayMs;
  const jitter = options?.jitter;

  return {
    attempts:
      attempts === undefined || !Number.isFinite(attempts) || attempts < 1
        ? DEFAULT_STORE_RETRY.attempts
        : Math.floor(attempts),
    baseDelayMs:
      baseDelayMs === undefined || !Number.isFinite(baseDelayMs) || baseDelayMs < 0
        ? DEFAULT_STORE_RETRY.baseDelayMs
        : baseDelayMs,
    maxDelayMs:
      maxDelayMs === undefined || !Number.isFinite(maxDelayMs) || maxDelayMs < 0
        ? DEFAULT_STORE_RETRY.maxDelayMs
        : maxDelayMs,
    jitter:
      jitter === undefined || !Number.isFinite(jitter) || jitter < 0
        ? DEFAULT_STORE_RETRY.jitter
        : Math.min(1, jitter),
  };
}

// Capped exponential backoff with symmetric jitter. `attempt` is 1-based: the
// delay *after* the first failure is the base delay.
export function storeRetryDelayMs(
  attempt: number,
  options: StoreRetryOptions | undefined,
  random: () => number = Math.random,
): number {
  const resolved = resolveRetry(options);
  const exponential = resolved.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(resolved.maxDelayMs, exponential);
  if (resolved.jitter === 0) {
    return capped;
  }
  // random() in [0,1) maps to a ±jitter band around the capped delay.
  const spread = capped * resolved.jitter;
  return Math.max(0, capped - spread + random() * spread * 2);
}

// Maps a backend failure onto the error taxonomy. DataStore throws are strings
// or Lua errors, so classification is substring-based on the message — the same
// approach the Roblox community's retry loops use, kept in one place here.
export function classifyStoreError(cause: unknown): {
  readonly name: StoreErrorName;
  readonly retryable: boolean;
  readonly message: string;
} {
  const message =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : String(cause);
  const normalized = message.toLowerCase();

  // No API access is a configuration state, not a transient fault: retrying it
  // just delays the inevitable failure by the whole backoff budget.
  if (
    normalized.includes("403") ||
    normalized.includes("studio access to apis") ||
    normalized.includes("api services") ||
    normalized.includes("not enabled") ||
    normalized.includes("publish this place")
  ) {
    return { name: "StoreUnavailableError", retryable: false, message };
  }

  if (
    normalized.includes("429") ||
    normalized.includes("throttl") ||
    normalized.includes("budget") ||
    normalized.includes("too many requests") ||
    normalized.includes("rate limit")
  ) {
    return { name: "StoreThrottledError", retryable: true, message };
  }

  return { name: "StoreRequestError", retryable: true, message };
}

export type StoreRequestOptions = {
  readonly kind: StoreBackendRequestKind;
  readonly retry?: StoreRetryOptions;
  readonly scheduler?: StoreScheduler;
  readonly random?: () => number;
  // Consulted before each attempt; a zero budget waits out a backoff instead of
  // spending a request that would be throttled anyway.
  readonly getBudget?: (kind: StoreBackendRequestKind) => number;
};

// Runs one backend request under the retry, budget, and classification policy.
// The single choke point every store operation goes through.
export async function runStoreRequest<TValue>(
  request: () => Promise<TValue>,
  options: StoreRequestOptions,
): Promise<StoreResult<TValue>> {
  const retry = resolveRetry(options.retry);
  const scheduler = options.scheduler ?? defaultStoreScheduler;
  const random = options.random ?? Math.random;
  let lastError: StoreError | undefined;

  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    if (attempt > 1) {
      await storeDelay(scheduler, storeRetryDelayMs(attempt - 1, options.retry, random));
    }

    const getBudget = options.getBudget;
    if (getBudget !== undefined && getBudget(options.kind) < 1) {
      lastError = {
        name: "StoreThrottledError",
        message: `No DataStore request budget left for a ${options.kind} request.`,
        retryable: true,
        attempts: attempt,
        retryAfterMs: storeRetryDelayMs(attempt, options.retry, random),
      };
      continue;
    }

    try {
      return storeOk(await request());
    } catch (cause) {
      const classified = classifyStoreError(cause);
      lastError = {
        name: classified.name,
        message: classified.message,
        retryable: classified.retryable,
        attempts: attempt,
        cause,
      };
      if (!classified.retryable) {
        break;
      }
    }
  }

  return {
    ok: false,
    error: lastError ?? {
      name: "StoreRequestError",
      message: "The store request failed with no recorded error.",
      retryable: true,
      attempts: retry.attempts,
    },
  };
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function formatIssuePath(path: readonly string[]): string {
  return path.length === 0 ? "<root>" : path.join(".");
}

// Turns a raw stored value into a validated snapshot. The whole no-blind-
// overwrite rule lives here: every path that cannot produce a trustworthy value
// returns an error, and only a genuinely absent key resolves to the default.
// Erased in both directions, like `encodeStoreValue`: this is the validation
// boundary, so the schema is the authority on the shape and the deep inferred
// type buys nothing here. `Store.loadSnapshot` re-applies the precise type for
// consumers.
export function decodeStoreValue(
  definition: {
    readonly id: string;
    readonly schema: Schema;
    readonly version?: number;
    readonly migrate?: (stored: unknown, fromVersion: number) => unknown;
    readonly defaultValue: unknown;
  },
  raw: unknown,
): StoreResult<StoreSnapshot<unknown>> {
  const currentVersion = resolveStoreVersion(definition);

  if (raw === undefined || raw === null) {
    return storeOk({
      value: resolveStoreDefault(definition),
      existed: false,
      version: currentVersion,
      migrated: false,
      updatedAtMs: undefined,
      lock: undefined,
    });
  }

  const envelope = isStoreEnvelope(raw) ? raw : undefined;
  // A value that is not an Aruna envelope predates the store (a hand-rolled
  // DataStore this store is adopting). Treat it as version 0 so `migrate` gets
  // a chance at it instead of failing validation outright.
  const storedVersion = envelope !== undefined ? envelope.v : 0;
  const storedData = envelope !== undefined ? envelope.d : raw;
  const lock =
    envelope !== undefined && isStoreLockState(envelope.lock) ? envelope.lock : undefined;
  const updatedAtMs = envelope !== undefined ? envelope.t : undefined;

  let value: unknown = storedData;
  let migrated = false;

  if (storedVersion !== currentVersion) {
    const migrate = definition.migrate;
    if (migrate === undefined) {
      return storeFail(
        "StoreMigrationError",
        `Store ${definition.id} read a record at version ${storedVersion} but is at version ${currentVersion}, and no migrate() was declared.`,
      );
    }

    let migrateResult: unknown;
    try {
      migrateResult = migrate(storedData, storedVersion);
    } catch (cause) {
      return storeFail(
        "StoreMigrationError",
        `Store ${definition.id} failed to migrate a record from version ${storedVersion}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { cause },
      );
    }

    if (migrateResult === undefined) {
      return storeFail(
        "StoreMigrationError",
        `Store ${definition.id} could not migrate a record from version ${storedVersion} to ${currentVersion}.`,
      );
    }

    value = migrateResult;
    migrated = true;
  }

  const withDefaults = applyDefaults(definition.schema, value);
  const validation = validateSchema(definition.schema, withDefaults);
  if (!validation.ok) {
    const issue = validation.issues[0];
    const detail =
      issue === undefined
        ? "the value did not match the store schema"
        : `${formatIssuePath(issue.path)}: ${issue.message}`;
    return storeFail(
      migrated ? "StoreMigrationError" : "StoreValidationError",
      migrated
        ? `Store ${definition.id} migrated a record from version ${storedVersion} into a value that does not match its schema (${detail}).`
        : `Store ${definition.id} read a record that does not match its schema (${detail}).`,
    );
  }

  return storeOk({
    value: withDefaults,
    existed: true,
    version: storedVersion,
    migrated,
    updatedAtMs,
    lock,
  });
}

// Gate every outbound value through the same policy: schema first (so a caller
// sees the precise field), then storability, then size.
// Takes `unknown` rather than `StoreValue<TSchema>`: this is the runtime validation
// boundary, so the schema check below is the real gate, and keeping the deep
// inferred type out of the signature keeps the checker inside its instantiation
// budget. The definition is narrowed to the fields actually read for the same
// reason.
export function encodeStoreValue(
  definition: {
    readonly id: string;
    readonly schema: Schema;
    readonly version?: number;
  },
  value: unknown,
  nowMs: number,
  lock?: StoreLockState,
): StoreResult<StoreEnvelope> {
  const validation = validateSchema(definition.schema, value);
  if (!validation.ok) {
    const issue = validation.issues[0];
    const detail =
      issue === undefined
        ? "the value did not match the store schema"
        : `${formatIssuePath(issue.path)}: ${issue.message}`;
    return storeFail(
      "StoreValidationError",
      `Store ${definition.id} was given a value that does not match its schema (${detail}).`,
    );
  }

  const violation = findStoreValueViolation(value);
  if (violation !== undefined) {
    return storeFail(
      "StoreSerializationError",
      `Store ${definition.id} was given a value it cannot persist: ${violation}.`,
    );
  }

  const envelope = createStoreEnvelope(resolveStoreVersion(definition), value, nowMs, lock);
  const bytes = measureStoreValueBytes(envelope);
  if (bytes > STORE_MAX_VALUE_BYTES) {
    return storeFail(
      "StoreSerializationError",
      `Store ${definition.id} was given a value of ~${bytes} bytes; DataStore values are limited to ${STORE_MAX_VALUE_BYTES}.`,
    );
  }

  return storeOk(envelope);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type StoreErrorReporter = (
  error: StoreError,
  info: {
    readonly storeId: string;
    readonly key: string;
    readonly operation: StoreOperation;
  },
) => void;

export type StoreRuntimeOptions = {
  // A ready backend, or a factory the store calls with its definition. The
  // native runtime passes `createDataStoreBackend()`; tests pass an in-memory one.
  readonly backend?: StoreBackend;
  readonly createBackend?: StoreBackendFactory;
  readonly scheduler?: StoreScheduler;
  readonly nowMs?: () => number;
  readonly random?: () => number;
  // Observability hook for every failure, called before the error is returned.
  readonly onError?: StoreErrorReporter;
};

export type Store<TSchema extends Schema = Schema> = {
  readonly id: string;
  readonly definition: StoreDefinition<TSchema>;
  readonly backend: StoreBackend;
  // Reads a key, filling defaults and migrating as needed. A missing key
  // resolves to the store's default value; a corrupt one resolves to an error.
  readonly load: (key: string) => Promise<StoreResult<StoreValue<TSchema>>>;
  // `load` plus the record metadata (existed, version, lock, timestamp).
  readonly loadSnapshot: (key: string) => Promise<StoreResult<StoreSnapshot<StoreValue<TSchema>>>>;
  // Writes through UpdateAsync so a session lock written by a player store is
  // preserved rather than clobbered.
  readonly save: (key: string, value: StoreValue<TSchema>) => Promise<StoreResult<StoreValue<TSchema>>>;
  // Read-modify-write inside a single UpdateAsync: the transform sees the
  // current value (or the default) and returns the next one.
  readonly update: (
    key: string,
    transform: (current: StoreValue<TSchema>) => StoreValue<TSchema>,
  ) => Promise<StoreResult<StoreValue<TSchema>>>;
  readonly remove: (key: string) => Promise<StoreResult<undefined>>;
  // SetAsync, ignoring any session lock. For admin and migration tooling; game
  // code should use `save`/`update`.
  readonly overwrite: (key: string, value: StoreValue<TSchema>) => Promise<StoreResult<StoreValue<TSchema>>>;
};

// The shape the implementation is written against: the same members as `Store`
// with the schema-derived value type erased. The generic value type is a
// consumer-facing contract, and instantiating it throughout the implementation
// is what pushes the checker past its limit — so it is applied once, on return.
type ErasedStore = {
  readonly id: string;
  readonly definition: unknown;
  readonly backend: StoreBackend;
  readonly load: (key: string) => Promise<StoreResult<unknown>>;
  readonly loadSnapshot: (key: string) => Promise<StoreResult<StoreSnapshot<unknown>>>;
  readonly save: (key: string, value: unknown) => Promise<StoreResult<unknown>>;
  readonly update: (
    key: string,
    transform: (current: unknown) => unknown,
  ) => Promise<StoreResult<unknown>>;
  readonly remove: (key: string) => Promise<StoreResult<undefined>>;
  readonly overwrite: (key: string, value: unknown) => Promise<StoreResult<unknown>>;
};

export function createStore<TSchema extends Schema>(
  definition: StoreDefinition<TSchema>,
  options?: StoreRuntimeOptions,
): Store<TSchema> {
  const backend =
    options?.backend ??
    (options?.createBackend !== undefined
      ? options.createBackend(definition)
      : createMemoryStoreBackend());
  const nowMs = options?.nowMs ?? (() => Date.now());
  const onError = options?.onError;

  const requestOptions = (kind: StoreBackendRequestKind): StoreRequestOptions => ({
    kind,
    ...(definition.retry !== undefined ? { retry: definition.retry } : {}),
    ...(options?.scheduler !== undefined ? { scheduler: options.scheduler } : {}),
    ...(options?.random !== undefined ? { random: options.random } : {}),
    ...(backend.getBudget !== undefined ? { getBudget: backend.getBudget } : {}),
  });

  // Routes a failure through the observability hook on its way back to the
  // caller. Returning `StoreFailure` keeps it usable as the return value of any
  // operation regardless of that operation's success type.
  const failed = (result: StoreFailure, key: string, operation: StoreOperation): StoreFailure => {
    if (onError !== undefined) {
      onError(result.error, { storeId: definition.id, key, operation });
    }
    return result;
  };

  const userIdsFor = (key: string): readonly number[] | undefined => definition.userIds?.(key);

  const loadSnapshot = async (key: string): Promise<StoreResult<StoreSnapshot<unknown>>> => {
    const keyResult = validateStoreKey(key);
    if (!keyResult.ok) {
      return failed(keyResult, key, "load");
    }

    const raw = await runStoreRequest(() => backend.get(key), requestOptions("get"));
    if (!raw.ok) {
      return failed(raw, key, "load");
    }

    const decoded = decodeStoreValue(definition, raw.value);
    return decoded.ok ? decoded : failed(decoded, key, "load");
  };

  // Both `save` and `update` funnel here: one UpdateAsync that decodes the
  // current record, computes the next value, and re-wraps it while carrying any
  // existing lock forward.
  const writeThrough = async (
    key: string,
    operation: StoreOperation,
    next: (current: unknown, snapshot: StoreSnapshot<unknown>) => unknown,
  ): Promise<StoreResult<unknown>> => {
    const keyResult = validateStoreKey(key);
    if (!keyResult.ok) {
      return failed(keyResult, key, operation);
    }

    // A failure raised inside the transform cannot travel through UpdateAsync's
    // return channel (undefined there means "cancel the write"), so it is
    // captured here and surfaced after the request settles.
    let failure: StoreFailure | undefined;

    const written = await runStoreRequest(
      () =>
        backend.update(
          key,
          (current) => {
            const decoded = decodeStoreValue(definition, current);
            if (!decoded.ok) {
              failure = decoded;
              return undefined;
            }
            const encoded = encodeStoreValue(
              definition,
              next(decoded.value.value, decoded.value),
              nowMs(),
              decoded.value.lock,
            );
            if (!encoded.ok) {
              failure = encoded;
              return undefined;
            }
            return encoded.value;
          },
          userIdsFor(key),
        ),
      requestOptions("update"),
    );

    if (failure !== undefined) {
      return failed(failure, key, operation);
    }
    if (!written.ok) {
      return failed(written, key, operation);
    }

    const decoded = decodeStoreValue(definition, written.value);
    if (!decoded.ok) {
      return failed(decoded, key, operation);
    }
    return storeOk(decoded.value.value);
  };

  const implementation: ErasedStore = {
    id: definition.id,
    definition,
    backend,
    loadSnapshot,
    async load(key) {
      const snapshot = await loadSnapshot(key);
      return snapshot.ok ? storeOk(snapshot.value.value) : snapshot;
    },
    save(key, value) {
      return writeThrough(key, "save", () => value);
    },
    update(key, transform) {
      return writeThrough(key, "update", (current) => transform(current));
    },
    async overwrite(key, value) {
      const keyResult = validateStoreKey(key);
      if (!keyResult.ok) {
        return failed(keyResult, key, "save");
      }
      const encoded = encodeStoreValue(definition, value, nowMs());
      if (!encoded.ok) {
        return failed(encoded, key, "save");
      }
      const written = await runStoreRequest(
        () => backend.set(key, encoded.value, userIdsFor(key)),
        requestOptions("set"),
      );
      return written.ok ? storeOk(value) : failed(written, key, "save");
    },
    async remove(key) {
      const keyResult = validateStoreKey(key);
      if (!keyResult.ok) {
        return failed(keyResult, key, "remove");
      }
      const removed = await runStoreRequest(() => backend.remove(key), requestOptions("remove"));
      return removed.ok ? storeOk(undefined) : failed(removed, key, "remove");
    },
  };

  // The single boundary cast. The implementation above is fully checked against
  // `ErasedStore`; `Store<TSchema>` re-applies the schema-derived value type for
  // consumers, who are the only ones who benefit from it.
  return implementation as unknown as Store<TSchema>;
}
