// Aruna reference runtime — session-locked player documents.
//
// A player's save file is the one piece of state two servers can plausibly hold
// at once: a player teleports, rejoins during a shutdown, or lands on a second
// server while the first is still writing. Whoever writes last wins, and the
// other server's progress is gone. This module closes that window with a lock
// stored inside the record itself:
//
//   * Acquiring the lock and reading the data are a single UpdateAsync, so there
//     is no window between "I read it" and "I own it".
//   * A live lock held by another server refuses the load. The caller is told to
//     retry rather than handed a stale value it would later save over.
//   * A lock whose heartbeat has aged past the TTL is stale — the holder crashed
//     or the server died — and may be taken over.
//   * The heartbeat doubles as the autosave: every tick refreshes the lock and
//     flushes pending changes, so an unclean shutdown loses at most one interval.
//   * Releasing writes one final time and clears the lock, so the player's next
//     server can start immediately instead of waiting out the TTL.

import { validateSchema, type Schema } from "../schema/index.js";
import {
  createStore,
  createStoreEnvelope,
  decodeStoreValue,
  encodeStoreValue,
  findStoreValueViolation,
  resolveStoreVersion,
  runStoreRequest,
  storeFail,
  storeOk,
  validateStoreKey,
  type Store,
  type StoreBackendRequestKind,
  type StoreDefinition,
  type StoreError,
  type StoreErrorReporter,
  type StoreFailure,
  type StoreLockState,
  type StoreOperation,
  type StoreRequestOptions,
  type StoreResult,
  type StoreRuntimeOptions,
  type StoreSchedulerHandle,
  type StoreSnapshot,
  type StoreValue,
} from "./store.js";

export type StoreSessionOptions = {
  // How long a lock stays valid without a heartbeat. Another server may take
  // over a lock older than this, so it must comfortably exceed `heartbeatMs` —
  // four intervals by default, so a couple of throttled writes cannot cost a
  // player their lock while they are still playing.
  readonly lockTtlMs?: number;
  // How often the holder refreshes the lock and flushes pending changes. This
  // is the autosave interval: an unclean shutdown loses at most one interval of
  // progress.
  readonly heartbeatMs?: number;
  // How many times to retry a load that lost the lock race, before giving up.
  readonly acquireAttempts?: number;
  readonly acquireDelayMs?: number;
};

export const DEFAULT_STORE_SESSION: Required<StoreSessionOptions> = {
  lockTtlMs: 120_000,
  heartbeatMs: 30_000,
  acquireAttempts: 5,
  acquireDelayMs: 3_000,
};

function resolveSession(options: StoreSessionOptions | undefined): Required<StoreSessionOptions> {
  const pick = (value: number | undefined, fallback: number): number =>
    value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : value;

  const heartbeatMs = pick(options?.heartbeatMs, DEFAULT_STORE_SESSION.heartbeatMs);
  const lockTtlMs = pick(options?.lockTtlMs, DEFAULT_STORE_SESSION.lockTtlMs);

  return {
    heartbeatMs,
    // A TTL at or below the heartbeat would let a server steal a lock from a
    // holder that is refreshing it exactly on schedule.
    lockTtlMs: Math.max(lockTtlMs, heartbeatMs * 2),
    acquireAttempts: Math.floor(pick(options?.acquireAttempts, DEFAULT_STORE_SESSION.acquireAttempts)),
    acquireDelayMs: pick(options?.acquireDelayMs, DEFAULT_STORE_SESSION.acquireDelayMs),
  };
}

// Declared as an interface extending the base rather than an intersection:
// intersecting a type whose fields mention `StoreValue<TSchema>` makes every
// assignment to `StoreDefinition<TSchema>` re-expand that conditional type,
// which the checker refuses past a certain depth.
export interface PlayerStoreDefinition<TSchema extends Schema = Schema, TPlayer = unknown>
  extends StoreDefinition<TSchema> {
  // Maps a player onto a DataStore key. Defaults to `player_<UserId>`.
  readonly key?: (player: TPlayer) => string;
  readonly session?: StoreSessionOptions;
}

// A live, session-locked handle on one player's record. Reads are synchronous
// (the value is held in memory for as long as the lock is), writes are staged
// locally and flushed by the heartbeat, an explicit `save`, or `release`.
export type StoreDocument<TValue> = {
  readonly key: string;
  // The current in-memory value. Always schema-valid: it was validated on load
  // and every mutation revalidates before it is accepted.
  readonly get: () => TValue;
  // Replaces the value. Rejects (without mutating) a value that fails the schema
  // or cannot be persisted, so the failure surfaces at the call site rather than
  // silently at the next flush.
  readonly set: (value: TValue) => StoreResult<TValue>;
  // Read-modify-write against the in-memory value, under the same validation.
  readonly update: (transform: (current: TValue) => TValue) => StoreResult<TValue>;
  // Flushes pending changes now. A no-op returning the current value when
  // nothing changed since the last flush.
  readonly save: () => Promise<StoreResult<TValue>>;
  // Final flush plus lock release. The document is closed afterwards: further
  // writes fail with StoreClosedError rather than resurrecting a departed
  // player's record.
  readonly release: () => Promise<StoreResult<undefined>>;
  readonly isActive: () => boolean;
  // True when the in-memory value differs from what was last persisted.
  readonly isDirty: () => boolean;
  // Record metadata as of the load that opened this document.
  readonly snapshot: StoreSnapshot<TValue>;
};

export type PlayerStoreOptions<TPlayer = unknown> = StoreRuntimeOptions & {
  // Identifies this server in the lock. Defaults to a per-process id; the native
  // runtime passes `${game.JobId}:${game.PlaceId}`.
  readonly owner?: string;
  // Called when a load ultimately fails. The player has no document, so the game
  // must decide: kick, retry, or run them in a no-save guest mode. Never
  // defaulted to "start fresh" — that silently overwrites a real save.
  readonly onLoadFailed?: (player: TPlayer, error: StoreError) => void;
  // Called when a background flush (heartbeat or release) fails, where no caller
  // is waiting on the result.
  readonly onSaveFailed?: (player: TPlayer, error: StoreError) => void;
};

export type PlayerStore<TSchema extends Schema = Schema, TPlayer = unknown> = {
  readonly id: string;
  readonly store: Store<TSchema>;
  readonly definition: PlayerStoreDefinition<TSchema, TPlayer>;
  readonly keyFor: (player: TPlayer) => StoreResult<string>;
  // Acquires the session lock and opens a document. Repeated calls for a player
  // that already holds one return the same document rather than re-locking.
  readonly load: (player: TPlayer) => Promise<StoreResult<StoreDocument<StoreValue<TSchema>>>>;
  // The already-loaded document, or undefined while a load is in flight or after
  // a release.
  readonly get: (player: TPlayer) => StoreDocument<StoreValue<TSchema>> | undefined;
  // Resolves once the in-flight load for this player settles. Lets an action
  // that needs the record wait for it instead of failing on a mid-join call.
  readonly waitFor: (player: TPlayer) => Promise<StoreResult<StoreDocument<StoreValue<TSchema>>>>;
  readonly save: (player: TPlayer) => Promise<StoreResult<StoreValue<TSchema>>>;
  readonly release: (player: TPlayer) => Promise<StoreResult<undefined>>;
  // Flushes every held document. Wire this to BindToClose so a shutdown does not
  // discard the last interval of progress.
  readonly saveAll: () => Promise<readonly StoreResult<unknown>[]>;
  readonly releaseAll: () => Promise<readonly StoreResult<undefined>[]>;
  // Stops heartbeats and drops handles without writing. `releaseAll` first
  // unless the process is going away regardless.
  readonly dispose: () => void;
};

// `StoreDocument` for a holder that moves documents around without reading or
// writing them. `StoreDocument<T>` is invariant in T — it both returns and
// accepts one — so a concrete document is assignable to `StoreDocument<unknown>`
// in neither direction. It is assignable to this: every input position is
// `never`, which is what the holder is entitled to (it cannot write through this
// view, and does not want to), and every output widens to `unknown`.
export type AnyStoreDocument = {
  readonly key: string;
  readonly get: () => unknown;
  readonly set: (value: never) => StoreResult<unknown>;
  readonly update: (transform: never) => StoreResult<unknown>;
  readonly save: () => Promise<StoreResult<unknown>>;
  readonly release: () => Promise<StoreResult<undefined>>;
  readonly isActive: () => boolean;
  readonly isDirty: () => boolean;
  readonly snapshot: StoreSnapshot<unknown>;
};

// A player store held by something that owns its lifecycle without knowing what
// it holds — `createServerApp` loads on join, releases on leave, and forwards
// documents to dispatch, none of which touches the value. Naming that
// `PlayerStore<Schema, TPlayer>` would be wrong twice over: the schema-precise
// members are invariant, so no real store is assignable to it, and asking for
// the value type of every schema at once expands `Infer` deep enough to trip
// TS2589. `store` and `definition` are dropped rather than erased — they are the
// schema-precise handles, and they belong to whoever created the store.
export type AnyPlayerStore<TPlayer = unknown> = {
  readonly id: string;
  readonly keyFor: (player: TPlayer) => StoreResult<string>;
  readonly load: (player: TPlayer) => Promise<StoreResult<AnyStoreDocument>>;
  readonly get: (player: TPlayer) => AnyStoreDocument | undefined;
  readonly waitFor: (player: TPlayer) => Promise<StoreResult<AnyStoreDocument>>;
  readonly save: (player: TPlayer) => Promise<StoreResult<unknown>>;
  readonly release: (player: TPlayer) => Promise<StoreResult<undefined>>;
  readonly saveAll: () => Promise<readonly StoreResult<unknown>[]>;
  readonly releaseAll: () => Promise<readonly StoreResult<undefined>[]>;
  readonly dispose: () => void;
};

function isPlayerLike(value: unknown): value is { readonly UserId: number } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { readonly UserId?: unknown };
  return typeof candidate.UserId === "number" && Number.isFinite(candidate.UserId);
}

export function defaultPlayerStoreKey(player: unknown): StoreResult<string> {
  if (isPlayerLike(player)) {
    return storeOk(`player_${player.UserId}`);
  }
  if (typeof player === "number" && Number.isFinite(player)) {
    return storeOk(`player_${player}`);
  }
  if (typeof player === "string" && player.length > 0) {
    return storeOk(`player_${player}`);
  }
  return storeFail(
    "StoreKeyError",
    "Could not derive a store key from the player. Pass key: (player) => string to the store definition.",
  );
}

let ownerCounter = 0;
function defaultOwner(): string {
  ownerCounter += 1;
  return `aruna-server-${ownerCounter}`;
}

// The shapes the implementation is written against, with the schema-derived
// value type erased. As in the store core, the precise types are a
// consumer-facing contract applied once on return rather than threaded through
// every internal signature.
type ErasedDocument = StoreDocument<unknown>;

type ErasedPlayerStore<TPlayer> = {
  readonly id: string;
  readonly store: unknown;
  readonly definition: unknown;
  readonly keyFor: (player: TPlayer) => StoreResult<string>;
  readonly load: (player: TPlayer) => Promise<StoreResult<ErasedDocument>>;
  readonly get: (player: TPlayer) => ErasedDocument | undefined;
  readonly waitFor: (player: TPlayer) => Promise<StoreResult<ErasedDocument>>;
  readonly save: (player: TPlayer) => Promise<StoreResult<unknown>>;
  readonly release: (player: TPlayer) => Promise<StoreResult<undefined>>;
  readonly saveAll: () => Promise<readonly StoreResult<unknown>[]>;
  readonly releaseAll: () => Promise<readonly StoreResult<undefined>[]>;
  readonly dispose: () => void;
};

export function createPlayerStore<TSchema extends Schema, TPlayer = unknown>(
  definition: PlayerStoreDefinition<TSchema, TPlayer>,
  options?: PlayerStoreOptions<TPlayer>,
): PlayerStore<TSchema, TPlayer> {
  const store = createStore<TSchema>(definition, options);
  const backend = store.backend;
  const session = resolveSession(definition.session);
  const owner = options?.owner ?? defaultOwner();
  const nowMs = options?.nowMs ?? (() => Date.now());
  const scheduler = options?.scheduler;
  const version = resolveStoreVersion(definition);
  const onError = options?.onError;

  const requestOptions = (kind: StoreBackendRequestKind): StoreRequestOptions => ({
    kind,
    ...(definition.retry !== undefined ? { retry: definition.retry } : {}),
    ...(scheduler !== undefined ? { scheduler } : {}),
    ...(options?.random !== undefined ? { random: options.random } : {}),
    ...(backend.getBudget !== undefined ? { getBudget: backend.getBudget } : {}),
  });

  const report = (error: StoreError, key: string, operation: StoreOperation): void => {
    const reporter: StoreErrorReporter | undefined = onError;
    if (reporter !== undefined) {
      reporter(error, { storeId: definition.id, key, operation });
    }
  };

  const keyFor = (player: TPlayer): StoreResult<string> => {
    const custom = definition.key;
    const derived = custom !== undefined ? storeOk(custom(player)) : defaultPlayerStoreKey(player);
    return derived.ok ? validateStoreKey(derived.value) : derived;
  };

  // Whether `lock` blocks us right now: our own lock never does, and a lock
  // whose heartbeat has aged past the TTL is treated as abandoned.
  const isLockBlocking = (lock: StoreLockState | undefined, at: number): boolean =>
    lock !== undefined && lock.owner !== owner && at - lock.heartbeatMs < session.lockTtlMs;

  type DocumentState = {
    readonly key: string;
    value: unknown;
    // The last value confirmed written, used for the dirty check.
    persisted: string;
    active: boolean;
    heartbeat: StoreSchedulerHandle | undefined;
    // Serializes writes for this document so a heartbeat flush cannot interleave
    // with an explicit save or a release.
    queue: Promise<unknown>;
  };

  // A cheap value identity for the dirty check. JSON is enough: store values are
  // storable by construction, so they always encode.
  const fingerprint = (value: unknown): string => {
    try {
      return JSON.stringify(value) ?? "";
    } catch {
      return "";
    }
  };

  const documents = new Map<TPlayer, ErasedDocument>();
  const loading = new Map<TPlayer, Promise<StoreResult<ErasedDocument>>>();

  // One UpdateAsync that claims the lock and returns the record under it. The
  // read and the claim cannot be separated, which is the entire point.
  const acquire = async (key: string): Promise<StoreResult<StoreSnapshot<unknown>>> => {
    let failure: StoreFailure | undefined;

    const written = await runStoreRequest(
      () =>
        backend.update(
          key,
          (current) => {
            const at = nowMs();
            const decoded = decodeStoreValue(definition, current);
            if (!decoded.ok) {
              failure = decoded;
              return undefined;
            }

            const lock = decoded.value.lock;
            if (isLockBlocking(lock, at)) {
              failure = storeFail(
                "StoreLockedError",
                `Store ${definition.id} key ${key} is locked by another server (${
                  lock === undefined ? "unknown" : lock.owner
                }).`,
                {
                  retryable: true,
                  retryAfterMs:
                    lock === undefined
                      ? session.acquireDelayMs
                      : Math.max(0, lock.heartbeatMs + session.lockTtlMs - at),
                },
              );
              return undefined;
            }

            // Rewrite the record with our lock. The data is carried through
            // unchanged — this write claims ownership, it does not save progress.
            return createStoreEnvelope(version, decoded.value.value, at, {
              owner,
              heartbeatMs: at,
            });
          },
          definition.userIds?.(key),
        ),
      requestOptions("update"),
    );

    if (failure !== undefined) {
      return failure;
    }
    if (!written.ok) {
      return written;
    }
    return decodeStoreValue(definition, written.value);
  };

  // The heartbeat/save/release write. `lock` is the lock to persist: our own to
  // keep holding it, or undefined to release it.
  const writeDocument = async (
    state: DocumentState,
    value: unknown,
    lock: StoreLockState | undefined,
    operation: StoreOperation,
  ): Promise<StoreResult<unknown>> => {
    const encoded = encodeStoreValue(definition, value, nowMs(), lock);
    if (!encoded.ok) {
      report(encoded.error, state.key, operation);
      return encoded;
    }

    let failure: StoreFailure | undefined;

    const written = await runStoreRequest(
      () =>
        backend.update(
          state.key,
          (current) => {
            const at = nowMs();
            const decoded = decodeStoreValue(definition, current);
            // A record we can no longer decode is still ours to overwrite: we
            // hold the lock and our in-memory value is the authority. Only lock
            // ownership can stop this write.
            const currentLock = decoded.ok ? decoded.value.lock : undefined;
            if (currentLock !== undefined && currentLock.owner !== owner) {
              // Someone took the lock — our TTL lapsed while we were throttled.
              // Their value is newer than ours; refusing here is what prevents
              // the classic "two servers, last writer wins" rollback.
              failure = storeFail(
                "StoreLockedError",
                `Store ${definition.id} key ${state.key} was taken over by ${currentLock.owner}; refusing to overwrite it.`,
              );
              return undefined;
            }
            return createStoreEnvelope(version, value, at, lock);
          },
          definition.userIds?.(state.key),
        ),
      requestOptions("update"),
    );

    if (failure !== undefined) {
      // Losing the lock is terminal for this document: keeping it open would let
      // every later write fail the same way.
      state.active = false;
      state.heartbeat?.cancel();
      state.heartbeat = undefined;
      report(failure.error, state.key, operation);
      return failure;
    }
    if (!written.ok) {
      report(written.error, state.key, operation);
      return written;
    }

    state.persisted = fingerprint(value);
    return storeOk(value);
  };

  const createDocument = (
    player: TPlayer,
    key: string,
    snapshot: StoreSnapshot<unknown>,
  ): ErasedDocument => {
    const state: DocumentState = {
      key,
      value: snapshot.value,
      persisted: fingerprint(snapshot.value),
      active: true,
      heartbeat: undefined,
      queue: Promise.resolve(),
    };

    // Every write for this document goes through the queue, so a heartbeat that
    // is still in flight cannot land after the release that followed it. Queued
    // tasks resolve with a result rather than rejecting, so the chain only has
    // to carry completion, not failure.
    const enqueue = <TValue>(
      task: () => Promise<StoreResult<TValue>>,
    ): Promise<StoreResult<TValue>> => {
      // `previous` is captured synchronously (an async function body runs up to
      // its first await before returning), so calls serialize in enqueue order.
      const previous = state.queue;
      const next = (async () => {
        await previous;
        return task();
      })();
      state.queue = next;
      return next;
    };

    const stage = (value: unknown): StoreResult<unknown> => {
      if (!state.active) {
        return storeFail(
          "StoreClosedError",
          `Store ${definition.id} document ${key} was released and can no longer be written.`,
        );
      }

      const validation = validateSchema(definition.schema, value);
      if (!validation.ok) {
        const issue = validation.issues[0];
        return storeFail(
          "StoreValidationError",
          `Store ${definition.id} was given a value that does not match its schema (${
            issue === undefined
              ? "the value did not match the store schema"
              : `${issue.path.length === 0 ? "<root>" : issue.path.join(".")}: ${issue.message}`
          }).`,
        );
      }

      const violation = findStoreValueViolation(value);
      if (violation !== undefined) {
        return storeFail(
          "StoreSerializationError",
          `Store ${definition.id} was given a value it cannot persist: ${violation}.`,
        );
      }

      state.value = value;
      return storeOk(value);
    };

    // `force` separates the two flush reasons: an explicit `save` on an unchanged
    // document is a no-op, while a heartbeat must write regardless — refreshing
    // the lock is the write's real purpose, and skipping it would let the TTL
    // lapse under an idle player.
    const flush = (
      operation: StoreOperation,
      force: boolean,
    ): Promise<StoreResult<unknown>> =>
      enqueue(() => {
        if (!force && fingerprint(state.value) === state.persisted) {
          return Promise.resolve(storeOk(state.value));
        }
        return writeDocument(state, state.value, { owner, heartbeatMs: nowMs() }, operation);
      });

    const armHeartbeat = (): void => {
      if (scheduler === undefined || !state.active) {
        return;
      }
      state.heartbeat = scheduler.delay(session.heartbeatMs, () => {
        if (!state.active) {
          return;
        }
        void flush("lock", true).then((result) => {
          if (!result.ok && options?.onSaveFailed !== undefined) {
            options.onSaveFailed(player, result.error);
          }
          armHeartbeat();
        });
      });
    };

    const document: ErasedDocument = {
      key,
      snapshot,
      get: () => state.value,
      set: (value) => stage(value),
      update: (transform) => {
        if (!state.active) {
          return storeFail(
            "StoreClosedError",
            `Store ${definition.id} document ${key} was released and can no longer be written.`,
          );
        }
        return stage(transform(state.value));
      },
      save: () => flush("save", false),
      isActive: () => state.active,
      isDirty: () => fingerprint(state.value) !== state.persisted,
      release: () =>
        enqueue(async () => {
          if (!state.active) {
            return storeOk(undefined);
          }
          state.active = false;
          state.heartbeat?.cancel();
          state.heartbeat = undefined;
          // One last write that also clears the lock, so the player's next
          // server can load immediately instead of waiting out the TTL.
          const written = await writeDocument(state, state.value, undefined, "release");
          return written.ok ? storeOk(undefined) : (written);
        }),
    };

    armHeartbeat();
    return document;
  };

  const load = (player: TPlayer): Promise<StoreResult<ErasedDocument>> => {
    const existing = documents.get(player);
    if (existing !== undefined && existing.isActive()) {
      return Promise.resolve(storeOk(existing));
    }

    const inFlight = loading.get(player);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const keyResult = keyFor(player);
    if (!keyResult.ok) {
      report(keyResult.error, "<unknown>", "lock");
      return Promise.resolve(keyResult);
    }
    const key = keyResult.value;

    const attemptLoad = async (): Promise<StoreResult<ErasedDocument>> => {
      let lastError: StoreError | undefined;

      for (let attempt = 1; attempt <= session.acquireAttempts; attempt += 1) {
        const acquired = await acquire(key);
        if (acquired.ok) {
          const document = createDocument(player, key, acquired.value);
          documents.set(player, document);
          return storeOk(document);
        }

        lastError = acquired.error;
        // Only lock contention is worth waiting out here; the request layer has
        // already retried everything transient.
        if (acquired.error.name !== "StoreLockedError") {
          break;
        }
        if (attempt < session.acquireAttempts) {
          await new Promise<void>((resolve) => {
            if (scheduler === undefined) {
              resolve();
              return;
            }
            scheduler.delay(session.acquireDelayMs, resolve);
          });
        }
      }

      const error: StoreError = lastError ?? {
        name: "StoreLockedError",
        message: `Store ${definition.id} could not acquire the session lock for ${key}.`,
        retryable: true,
      };
      report(error, key, "lock");
      if (options?.onLoadFailed !== undefined) {
        options.onLoadFailed(player, error);
      }
      return { ok: false, error };
    };

    const pending = attemptLoad().then((result) => {
      loading.delete(player);
      return result;
    });
    loading.set(player, pending);
    return pending;
  };

  const release = async (player: TPlayer): Promise<StoreResult<undefined>> => {
    // A player who leaves mid-load must still be released, or the lock lingers
    // until the TTL lapses and their next server stalls behind it.
    const pending = loading.get(player);
    if (pending !== undefined) {
      await pending;
    }
    const document = documents.get(player);
    documents.delete(player);
    if (document === undefined) {
      return storeOk(undefined);
    }
    const result = await document.release();
    if (!result.ok && options?.onSaveFailed !== undefined) {
      options.onSaveFailed(player, result.error);
    }
    return result;
  };

  const implementation: ErasedPlayerStore<TPlayer> = {
    id: definition.id,
    store,
    definition,
    keyFor,
    load,
    get: (player) => {
      const document = documents.get(player);
      return document !== undefined && document.isActive() ? document : undefined;
    },
    waitFor: (player) => {
      const pending = loading.get(player);
      return pending ?? load(player);
    },
    save: async (player) => {
      const document = documents.get(player);
      if (document === undefined) {
        return storeFail(
          "StoreClosedError",
          `Store ${definition.id} has no open document for this player.`,
        );
      }
      return document.save();
    },
    release,
    saveAll: () => Promise.all([...documents.values()].map((document) => document.save())),
    releaseAll: () => Promise.all([...documents.keys()].map((player) => release(player))),
    dispose: () => {
      documents.clear();
      loading.clear();
    },
  };

  // The single boundary cast, matching `createStore`.
  return implementation as unknown as PlayerStore<TSchema, TPlayer>;
}
