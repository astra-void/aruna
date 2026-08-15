// Aruna roblox-ts native runtime — session-locked player documents.
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
//   * A lock whose heartbeat aged past the TTL is stale — the holder crashed or
//     the server died — and may be taken over.
//   * The heartbeat doubles as the autosave: every tick refreshes the lock and
//     flushes pending changes, so an unclean shutdown loses at most one interval.
//   * Releasing writes one final time and clears the lock, so the player's next
//     server can start immediately instead of waiting out the TTL.
//
// The reference implementation is `src/runtime/player-store.ts`.

import type { Infer, Schema } from "./schema";
import {
	createStore,
	createStoreEnvelope,
	defaultStoreScheduler,
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
	type StoreCodecDefinition,
	type StoreDefinition,
	type StoreError,
	type StoreFailure,
	type StoreLockState,
	type StoreOperation,
	type StoreRequestOptions,
	type StoreResult,
	type StoreRuntimeOptions,
	type StoreSchedulerHandle,
	type StoreSnapshot,
} from "./store";

export interface StoreSessionOptions {
	// How long a lock stays valid without a heartbeat. Another server may take
	// over a lock older than this, so it comfortably exceeds `heartbeatMs` —
	// four intervals by default, so a couple of throttled writes cannot cost a
	// player their lock while they are still playing.
	readonly lockTtlMs?: number;
	// How often the holder refreshes the lock and flushes pending changes. This
	// is the autosave interval: an unclean shutdown loses at most one interval of
	// progress.
	readonly heartbeatMs?: number;
	// How many times to retry a load that lost the lock race before giving up.
	readonly acquireAttempts?: number;
	readonly acquireDelayMs?: number;
}

export const DEFAULT_STORE_SESSION = {
	lockTtlMs: 120_000,
	heartbeatMs: 30_000,
	acquireAttempts: 5,
	acquireDelayMs: 3_000,
} as const;

interface ResolvedSession {
	readonly lockTtlMs: number;
	readonly heartbeatMs: number;
	readonly acquireAttempts: number;
	readonly acquireDelayMs: number;
}

function pick(value: number | undefined, fallback: number): number {
	// `value !== value` is the NaN check; a non-positive interval would busy-loop.
	if (value === undefined || value !== value || value <= 0) {
		return fallback;
	}
	return value;
}

function resolveSession(options: StoreSessionOptions | undefined): ResolvedSession {
	const heartbeatMs = pick(options?.heartbeatMs, DEFAULT_STORE_SESSION.heartbeatMs);
	const lockTtlMs = pick(options?.lockTtlMs, DEFAULT_STORE_SESSION.lockTtlMs);

	return {
		heartbeatMs,
		// A TTL at or below the heartbeat would let a server steal a lock from a
		// holder that is refreshing it exactly on schedule.
		lockTtlMs: math.max(lockTtlMs, heartbeatMs * 2),
		acquireAttempts: math.floor(
			pick(options?.acquireAttempts, DEFAULT_STORE_SESSION.acquireAttempts),
		),
		acquireDelayMs: pick(options?.acquireDelayMs, DEFAULT_STORE_SESSION.acquireDelayMs),
	};
}

export interface PlayerStoreDefinition<TSchema extends Schema = Schema, TPlayer = Player>
	extends StoreDefinition<TSchema> {
	// Maps a player onto a DataStore key. Defaults to `player_<UserId>`.
	readonly key?: (player: TPlayer) => string;
	readonly session?: StoreSessionOptions;
}

// A live, session-locked handle on one player's record. Reads are synchronous
// (the value is held in memory for as long as the lock is), writes are staged
// locally and flushed by the heartbeat, an explicit `save`, or `release`.
export interface StoreDocument<TValue> {
	readonly key: string;
	// The current in-memory value. Always schema-valid: validated on load, and
	// every mutation revalidates before it is accepted.
	readonly get: () => TValue;
	// Replaces the value. Rejects (without mutating) a value that fails the
	// schema or cannot be persisted, so the failure surfaces at the call site
	// rather than silently at the next flush.
	readonly set: (value: TValue) => StoreResult<TValue>;
	// Read-modify-write against the in-memory value, under the same validation.
	readonly update: (transform: (current: TValue) => TValue) => StoreResult<TValue>;
	// Flushes pending changes now; a no-op when nothing changed.
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
}

export interface PlayerStoreOptions<TPlayer = Player> extends StoreRuntimeOptions {
	// Identifies this server in the lock. Defaults to `${JobId}:${PlaceId}`.
	readonly owner?: string;
	// Called when a load ultimately fails. The player has no document, so the
	// game must decide: kick, retry, or run them in a no-save guest mode. Never
	// defaulted to "start fresh" — that silently overwrites a real save.
	readonly onLoadFailed?: (player: TPlayer, error: StoreError) => void;
	// Called when a background flush (heartbeat or release) fails, where no
	// caller is waiting on the result.
	readonly onSaveFailed?: (player: TPlayer, error: StoreError) => void;
}

export interface PlayerStore<TSchema extends Schema = Schema, TPlayer = Player> {
	readonly id: string;
	readonly store: Store<TSchema>;
	readonly definition: PlayerStoreDefinition<TSchema, TPlayer>;
	readonly keyFor: (player: TPlayer) => StoreResult<string>;
	// Acquires the session lock and opens a document. A player who already holds
	// one gets the same document rather than a re-lock.
	readonly load: (player: TPlayer) => Promise<StoreResult<StoreDocument<Infer<TSchema>>>>;
	// The already-loaded document, or undefined while a load is in flight or
	// after a release.
	readonly get: (player: TPlayer) => StoreDocument<Infer<TSchema>> | undefined;
	// Resolves once the in-flight load for this player settles, so an action that
	// needs the record can wait instead of failing on a mid-join call.
	readonly waitFor: (player: TPlayer) => Promise<StoreResult<StoreDocument<Infer<TSchema>>>>;
	readonly save: (player: TPlayer) => Promise<StoreResult<Infer<TSchema>>>;
	readonly release: (player: TPlayer) => Promise<StoreResult<undefined>>;
	// Flushes every held document. `createServerApp` wires this to BindToClose so
	// a shutdown does not discard the last interval of progress.
	readonly saveAll: () => Promise<Array<StoreResult<unknown>>>;
	readonly releaseAll: () => Promise<Array<StoreResult<undefined>>>;
	// Stops heartbeats and drops handles without writing. Call `releaseAll` first
	// unless the server is going away regardless.
	readonly dispose: () => void;
}

// `StoreDocument` for a holder that moves documents around without reading or
// writing them. `StoreDocument<T>` is invariant in T — it both returns and
// accepts one — so a concrete document is assignable to `StoreDocument<unknown>`
// in neither direction. It is assignable to this: every input position is
// `never`, which is what the holder is entitled to (it cannot write through this
// view, and does not want to), and every output widens to `unknown`.
export interface AnyStoreDocument {
	readonly key: string;
	readonly get: () => unknown;
	readonly set: (value: never) => StoreResult<unknown>;
	readonly update: (transform: never) => StoreResult<unknown>;
	readonly save: () => Promise<StoreResult<unknown>>;
	readonly release: () => Promise<StoreResult<undefined>>;
	readonly isActive: () => boolean;
	readonly isDirty: () => boolean;
	readonly snapshot: StoreSnapshot<unknown>;
}

// A player store held by something that owns its lifecycle without knowing what
// it holds — `createServerApp` loads on join, releases on leave, and forwards
// documents to dispatch, none of which touches the value. Naming that
// `PlayerStore<Schema, TPlayer>` would be wrong twice over: the schema-precise
// members are invariant, so no real store is assignable to it, and asking for
// the value type of every schema at once expands `Infer` deep enough to trip
// TS2589. `store` and `definition` are dropped rather than erased — they are the
// schema-precise handles, and they belong to whoever created the store.
export interface AnyPlayerStore<TPlayer = Player> {
	readonly id: string;
	readonly keyFor: (player: TPlayer) => StoreResult<string>;
	readonly load: (player: TPlayer) => Promise<StoreResult<AnyStoreDocument>>;
	readonly get: (player: TPlayer) => AnyStoreDocument | undefined;
	readonly waitFor: (player: TPlayer) => Promise<StoreResult<AnyStoreDocument>>;
	readonly save: (player: TPlayer) => Promise<StoreResult<unknown>>;
	readonly release: (player: TPlayer) => Promise<StoreResult<undefined>>;
	readonly saveAll: () => Promise<Array<StoreResult<unknown>>>;
	readonly releaseAll: () => Promise<Array<StoreResult<undefined>>>;
	readonly dispose: () => void;
}

export function defaultPlayerStoreKey(player: unknown): StoreResult<string> {
	if (typeIs(player, "Instance") && player.IsA("Player")) {
		return storeOk(`player_${player.UserId}`);
	}
	if (typeIs(player, "table")) {
		const candidate = player as { readonly UserId?: unknown };
		if (typeIs(candidate.UserId, "number")) {
			return storeOk(`player_${candidate.UserId}`);
		}
	}
	if (typeIs(player, "number")) {
		return storeOk(`player_${player}`);
	}
	return storeFail(
		"StoreKeyError",
		"Could not derive a store key from the player. Pass key: (player) => string to the store definition.",
	);
}

// Identifies this server in the lock. JobId is empty in Studio, where a
// per-session id keeps two Studio playtests from looking like the same holder.
let studioOwnerCounter = 0;
function defaultOwner(): string {
	const jobId = game.JobId;
	if (jobId !== "") {
		return `${jobId}:${game.PlaceId}`;
	}
	studioOwnerCounter += 1;
	return `studio-${game.PlaceId}-${studioOwnerCounter}`;
}

function defaultNowMs(): number {
	return DateTime.now().UnixTimestampMillis;
}

interface DocumentState {
	readonly key: string;
	value: unknown;
	// The last value confirmed written, used for the dirty check.
	persisted: string;
	active: boolean;
	heartbeat: StoreSchedulerHandle | undefined;
	// Serializes writes for this document so a heartbeat flush cannot interleave
	// with an explicit save or a release.
	queue: Promise<unknown>;
}

type ErasedDocument = StoreDocument<unknown>;

export function createPlayerStore<TSchema extends Schema, TPlayer = Player>(
	definition: PlayerStoreDefinition<TSchema, TPlayer>,
	options?: PlayerStoreOptions<TPlayer>,
): PlayerStore<TSchema, TPlayer> {
	const store = createStore<TSchema>(definition, options);
	const backend = store.backend;
	const session = resolveSession(definition.session);
	const owner = options !== undefined && options.owner !== undefined ? options.owner : defaultOwner();
	const nowMs = options !== undefined && options.nowMs !== undefined ? options.nowMs : defaultNowMs;
	const scheduler = options !== undefined ? options.scheduler : undefined;
	const version = resolveStoreVersion(definition);
	const onError = options !== undefined ? options.onError : undefined;
	const codec = definition as unknown as StoreCodecDefinition;

	const requestOptions = (kind: StoreBackendRequestKind): StoreRequestOptions => ({
		kind,
		...(definition.retry !== undefined ? { retry: definition.retry } : {}),
		...(scheduler !== undefined ? { scheduler } : {}),
		...(options !== undefined && options.random !== undefined ? { random: options.random } : {}),
		...(backend.getBudget !== undefined ? { getBudget: backend.getBudget } : {}),
	});

	// Parameter named `failure`, not `error`: the roblox-ts compiler reserves
	// `error` (the Lua global) as an identifier.
	const report = (failure: StoreError, key: string, operation: StoreOperation): void => {
		if (onError !== undefined) {
			onError(failure, { storeId: definition.id, key, operation });
		}
	};

	const keyFor = (player: TPlayer): StoreResult<string> => {
		const custom = definition.key;
		const derived = custom !== undefined ? storeOk(custom(player)) : defaultPlayerStoreKey(player);
		return derived.ok ? validateStoreKey(derived.value) : derived;
	};

	// Whether `lock` blocks us right now: our own lock never does, and a lock
	// whose heartbeat aged past the TTL is treated as abandoned.
	const isLockBlocking = (lock: StoreLockState | undefined, at: number): boolean =>
		lock !== undefined && lock.owner !== owner && at - lock.heartbeatMs < session.lockTtlMs;

	// A cheap value identity for the dirty check. JSONEncode is the same encoder
	// the size check uses; a value it refuses never reaches here.
	const fingerprint = (value: unknown): string => {
		const [encoded, result] = pcall(() =>
			game.GetService("HttpService").JSONEncode(value),
		);
		return encoded && typeIs(result, "string") ? (result as string) : "";
	};

	const documents = new Map<TPlayer, ErasedDocument>();
	const loading = new Map<TPlayer, Promise<StoreResult<ErasedDocument>>>();

	// One UpdateAsync that claims the lock and returns the record under it. The
	// read and the claim cannot be separated, which is the entire point.
	const acquire = (key: string): Promise<StoreResult<StoreSnapshot<unknown>>> => {
		let failure: StoreFailure | undefined;

		return runStoreRequest(
			() =>
				backend.update(
					key,
					(current) => {
						const at = nowMs();
						const decoded = decodeStoreValue(codec, current);
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
											: math.max(0, lock.heartbeatMs + session.lockTtlMs - at),
								},
							);
							return undefined;
						}

						// Rewrite the record with our lock. The data passes through
						// unchanged — this write claims ownership, it does not save progress.
						return createStoreEnvelope(version, decoded.value.value, at, {
							owner,
							heartbeatMs: at,
						});
					},
					definition.userIds !== undefined ? definition.userIds(key) : undefined,
				),
			requestOptions("update"),
		).then((written) => {
			if (failure !== undefined) {
				return failure;
			}
			if (!written.ok) {
				return written;
			}
			return decodeStoreValue(codec, written.value);
		});
	};

	// The heartbeat/save/release write. `lock` is the lock to persist: our own to
	// keep holding it, or undefined to release it.
	const writeDocument = (
		state: DocumentState,
		value: unknown,
		lock: StoreLockState | undefined,
		operation: StoreOperation,
	): Promise<StoreResult<unknown>> => {
		const encoded = encodeStoreValue(definition, value, nowMs(), lock);
		if (!encoded.ok) {
			report(encoded.error, state.key, operation);
			return Promise.resolve(encoded);
		}

		let failure: StoreFailure | undefined;

		return runStoreRequest(
			() =>
				backend.update(
					state.key,
					(current) => {
						const at = nowMs();
						const decoded = decodeStoreValue(codec, current);
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
					definition.userIds !== undefined ? definition.userIds(state.key) : undefined,
				),
			requestOptions("update"),
		).then((written) => {
			if (failure !== undefined) {
				// Losing the lock is terminal for this document: keeping it open would
				// let every later write fail the same way.
				state.active = false;
				if (state.heartbeat !== undefined) {
					state.heartbeat.cancel();
					state.heartbeat = undefined;
				}
				report(failure.error, state.key, operation);
				return failure;
			}
			if (!written.ok) {
				report(written.error, state.key, operation);
				return written;
			}
			state.persisted = fingerprint(value);
			return storeOk(value);
		});
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
			queue: Promise.resolve(undefined),
		};

		// Every write for this document goes through the queue, so a heartbeat
		// still in flight cannot land after the release that followed it. Queued
		// tasks resolve with a result rather than rejecting, so the chain only has
		// to carry completion.
		const enqueue = <TValue>(
			// Named `work`, not `task`: `task` is the Roblox scheduler global and the
			// compiler reserves it.
			work: () => Promise<StoreResult<TValue>>,
		): Promise<StoreResult<TValue>> => {
			const queued = state.queue.then(work);
			state.queue = queued;
			return queued;
		};

		const closed = (): StoreFailure =>
			storeFail(
				"StoreClosedError",
				`Store ${definition.id} document ${key} was released and can no longer be written.`,
			);

		const stage = (value: unknown): StoreResult<unknown> => {
			if (!state.active) {
				return closed();
			}
			if (!definition.schema.validate(value)) {
				return storeFail(
					"StoreValidationError",
					`Store ${definition.id} was given a value that does not match its schema.`,
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

		// `force` separates the two flush reasons: an explicit `save` on an
		// unchanged document is a no-op, while a heartbeat must write regardless —
		// refreshing the lock is the write's real purpose, and skipping it would
		// let the TTL lapse under an idle player.
		const flush = (operation: StoreOperation, force: boolean): Promise<StoreResult<unknown>> =>
			enqueue(() => {
				if (!force && fingerprint(state.value) === state.persisted) {
					return Promise.resolve(storeOk(state.value));
				}
				return writeDocument(state, state.value, { owner, heartbeatMs: nowMs() }, operation);
			});

		const armHeartbeat = (): void => {
			// Unlike the reference runtime there is always a real timer available, so
			// a store created without an explicit scheduler still heartbeats.
			const activeScheduler = scheduler !== undefined ? scheduler : defaultStoreScheduler;
			if (!state.active) {
				return;
			}
			state.heartbeat = activeScheduler.delay(session.heartbeatMs, () => {
				if (!state.active) {
					return;
				}
				flush("lock", true).then((result) => {
					if (!result.ok && options !== undefined && options.onSaveFailed !== undefined) {
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
			update: (transform) => (state.active ? stage(transform(state.value)) : closed()),
			save: () => flush("save", false),
			isActive: () => state.active,
			isDirty: () => fingerprint(state.value) !== state.persisted,
			release: () =>
				enqueue(() => {
					if (!state.active) {
						return Promise.resolve(storeOk(undefined));
					}
					state.active = false;
					if (state.heartbeat !== undefined) {
						state.heartbeat.cancel();
						state.heartbeat = undefined;
					}
					// One last write that also clears the lock, so the player's next
					// server can load immediately instead of waiting out the TTL.
					return writeDocument(state, state.value, undefined, "release").then((written) =>
						written.ok ? storeOk(undefined) : written,
					);
				}) as Promise<StoreResult<undefined>>,
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

		const attempt = (
			index: number,
			lastError: StoreError | undefined,
		): Promise<StoreResult<ErasedDocument>> => {
			if (index > session.acquireAttempts) {
				const failure: StoreError =
					lastError !== undefined
						? lastError
						: {
								name: "StoreLockedError",
								message: `Store ${definition.id} could not acquire the session lock for ${key}.`,
								retryable: true,
							};
				report(failure, key, "lock");
				if (options !== undefined && options.onLoadFailed !== undefined) {
					options.onLoadFailed(player, failure);
				}
				return Promise.resolve({ ok: false, error: failure });
			}

			return acquire(key).then((acquired) => {
				if (acquired.ok) {
					const document = createDocument(player, key, acquired.value);
					documents.set(player, document);
					return storeOk(document);
				}

				// Only lock contention is worth waiting out here; the request layer has
				// already retried everything transient.
				if (acquired.error.name !== "StoreLockedError") {
					report(acquired.error, key, "lock");
					if (options !== undefined && options.onLoadFailed !== undefined) {
						options.onLoadFailed(player, acquired.error);
					}
					return acquired;
				}

				// Give up immediately on the last attempt instead of waiting out a
				// delay whose retry the loop is about to refuse anyway.
				if (index >= session.acquireAttempts) {
					return attempt(index + 1, acquired.error);
				}

				const activeScheduler = scheduler !== undefined ? scheduler : defaultStoreScheduler;
				return new Promise<StoreResult<ErasedDocument>>((resolve) => {
					activeScheduler.delay(session.acquireDelayMs, () => {
						attempt(index + 1, acquired.error).then(resolve);
					});
				});
			});
		};

		const pending = attempt(1, undefined).then((result) => {
			loading.delete(player);
			return result;
		});
		loading.set(player, pending);
		return pending;
	};

	const release = (player: TPlayer): Promise<StoreResult<undefined>> => {
		// A player who leaves mid-load must still be released, or the lock lingers
		// until the TTL lapses and their next server stalls behind it.
		const pending = loading.get(player);
		const after = pending !== undefined ? pending.then(() => undefined) : Promise.resolve(undefined);

		return after.then(() => {
			const document = documents.get(player);
			documents.delete(player);
			if (document === undefined) {
				return storeOk(undefined);
			}
			return document.release().then((result) => {
				if (!result.ok && options !== undefined && options.onSaveFailed !== undefined) {
					options.onSaveFailed(player, result.error);
				}
				return result;
			});
		});
	};

	const implementation = {
		id: definition.id,
		store,
		definition,
		keyFor,
		load,
		get: (player: TPlayer) => {
			const document = documents.get(player);
			return document !== undefined && document.isActive() ? document : undefined;
		},
		waitFor: (player: TPlayer) => {
			const pending = loading.get(player);
			return pending !== undefined ? pending : load(player);
		},
		save: (player: TPlayer) => {
			const document = documents.get(player);
			if (document === undefined) {
				return Promise.resolve(
					storeFail(
						"StoreClosedError",
						`Store ${definition.id} has no open document for this player.`,
					),
				);
			}
			return document.save();
		},
		release,
		saveAll: () => {
			const pending: Array<Promise<StoreResult<unknown>>> = [];
			for (const [, document] of documents) {
				pending.push(document.save());
			}
			return Promise.all(pending);
		},
		releaseAll: () => {
			const pending: Array<Promise<StoreResult<undefined>>> = [];
			for (const [player] of documents) {
				pending.push(release(player));
			}
			return Promise.all(pending);
		},
		dispose: () => {
			documents.clear();
			loading.clear();
		},
	};

	// The implementation works in erased values; the generic type is the
	// consumer-facing contract, applied once here.
	return implementation as unknown as PlayerStore<TSchema, TPlayer>;
}
