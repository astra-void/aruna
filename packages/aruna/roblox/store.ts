// Aruna roblox-ts native runtime — the safe DataStore core.
//
// The reference implementation and its rationale live in
// `src/runtime/store.ts`; this is the Luau-side mirror. The safety properties
// are the same:
//
//   * No throwing. Every operation resolves with a `StoreResult`, so a
//     DataStore outage cannot unwind a game thread.
//   * No blind overwrite. A read that fails never degrades into "start from the
//     default and save over it".
//   * Bounded retries with capped backoff and jitter; permanent failures (no
//     API access, oversized payload, bad key) are not retried.
//   * Budget awareness through GetRequestBudgetForRequestType.
//   * Versioned payloads, so an older record is migrated rather than
//     reinterpreted.

import { applyDefaults, firstSchemaIssue, type Infer, type Schema } from "./schema";

export const STORE_MAX_KEY_LENGTH = 50;
export const STORE_MAX_VALUE_BYTES = 4_194_304;

const STORE_MAX_DEPTH = 32;

export type StoreOperation = "load" | "save" | "update" | "remove" | "lock" | "release";

export type StoreErrorName =
	| "StoreUnavailableError"
	| "StoreThrottledError"
	| "StoreRequestError"
	| "StoreValidationError"
	| "StoreSerializationError"
	| "StoreMigrationError"
	| "StoreKeyError"
	| "StoreLockedError"
	| "StoreClosedError";

export interface StoreError {
	readonly name: StoreErrorName;
	readonly message: string;
	readonly retryable: boolean;
	readonly attempts?: number;
	readonly retryAfterMs?: number;
	readonly cause?: unknown;
}

export interface StoreSuccess<TValue> {
	readonly ok: true;
	readonly value: TValue;
}

// Split from the union so a failure is assignable to every `StoreResult<T>`,
// which keeps the error paths free of casts.
export interface StoreFailure {
	readonly ok: false;
	readonly error: StoreError;
}

export type StoreResult<TValue> = StoreSuccess<TValue> | StoreFailure;

export function storeOk<TValue>(value: TValue): StoreSuccess<TValue> {
	return { ok: true, value };
}

export interface StoreFailDetails {
	readonly retryable?: boolean;
	readonly attempts?: number;
	readonly retryAfterMs?: number;
	readonly cause?: unknown;
}

export function storeFail(
	name: StoreErrorName,
	message: string,
	details?: StoreFailDetails,
): StoreFailure {
	return {
		ok: false,
		error: {
			name,
			message,
			retryable: details !== undefined && details.retryable === true,
			...(details !== undefined && details.attempts !== undefined
				? { attempts: details.attempts }
				: {}),
			...(details !== undefined && details.retryAfterMs !== undefined
				? { retryAfterMs: details.retryAfterMs }
				: {}),
			...(details !== undefined && details.cause !== undefined ? { cause: details.cause } : {}),
		},
	};
}

// ---------------------------------------------------------------------------
// Storability
// ---------------------------------------------------------------------------

function isFiniteNumber(value: number): boolean {
	// NaN is the only value that differs from itself; the infinities are
	// compared directly. JSONEncode rejects all three.
	return value === value && value !== math.huge && value !== -math.huge;
}

function describePath(path: string): string {
	return path === "" ? "<root>" : path;
}

function joinStorePath(path: string, key: string): string {
	return path === "" ? key : `${path}.${key}`;
}

// Returns a reason when `value` cannot be persisted, or undefined when it can.
// Narrower than the action wire policy: RemoteEvents carry Vector3/CFrame/
// Instance, DataStores carry only what JSON survives.
//
// `seen` holds the ancestor chain, so a table reachable by two paths is fine
// while a table that contains itself is not.
export function findStoreValueViolation(
	value: unknown,
	path?: string,
	seen?: Set<object>,
): string | undefined {
	const at = path !== undefined ? path : "";
	const ancestors = seen !== undefined ? seen : new Set<object>();

	if (value === undefined) {
		return undefined;
	}
	if (typeIs(value, "string") || typeIs(value, "boolean")) {
		return undefined;
	}
	if (typeIs(value, "number")) {
		return isFiniteNumber(value)
			? undefined
			: `${describePath(at)} is ${tostring(value)}, which DataStores cannot encode`;
	}
	if (typeIs(value, "Instance")) {
		return `${describePath(at)} is a Roblox Instance, which DataStores cannot encode`;
	}
	if (!typeIs(value, "table")) {
		return `${describePath(at)} is a ${typeOf(value)}, which DataStores cannot encode`;
	}

	const tableValue = value as object;
	if (ancestors.has(tableValue)) {
		return `${describePath(at)} is part of a cycle, which DataStores cannot encode`;
	}
	if (ancestors.size() >= STORE_MAX_DEPTH) {
		return `${describePath(at)} exceeds the maximum store value depth of ${STORE_MAX_DEPTH}`;
	}
	ancestors.add(tableValue);

	let violation: string | undefined;
	for (const [key, entry] of pairs(value as { [key: string]: unknown })) {
		if (!typeIs(key, "string") && !typeIs(key, "number")) {
			violation = `${describePath(at)} has a ${typeOf(key)} key, which DataStores cannot encode`;
			break;
		}
		const child = findStoreValueViolation(entry, joinStorePath(at, tostring(key)), ancestors);
		if (child !== undefined) {
			violation = child;
			break;
		}
	}

	ancestors.delete(tableValue);
	return violation;
}

function httpService(): HttpService {
	return game.GetService("HttpService");
}

// The size the DataStore will measure. JSONEncode is the same encoder the
// service uses, so a value it refuses is reported as unbounded and rejected by
// the size check.
export function measureStoreValueBytes(value: unknown): number {
	const [encoded, result] = pcall(() => httpService().JSONEncode(value));
	if (!encoded || !typeIs(result, "string")) {
		return math.huge;
	}
	return (result as string).size();
}

export function validateStoreKey(key: string): StoreResult<string> {
	if (key.size() === 0) {
		return storeFail("StoreKeyError", "Store keys cannot be empty.");
	}
	if (key.size() > STORE_MAX_KEY_LENGTH) {
		return storeFail(
			"StoreKeyError",
			`Store key "${key}" is ${key.size()} characters; DataStore keys are limited to ${STORE_MAX_KEY_LENGTH}.`,
		);
	}
	return storeOk(key);
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

// The session lock a player store writes alongside the data. It lives inside
// the record so claiming it and reading the data are one atomic UpdateAsync.
export interface StoreLockState {
	// `${JobId}:${PlaceId}` for a live server.
	readonly owner: string;
	// When the holder last proved it was alive. Older than the TTL means the
	// lock is stale and may be taken over.
	readonly heartbeatMs: number;
}

// The persisted shape. Single-character fields because this wrapper is pure
// overhead against the 4 MB per-key budget.
export interface StoreEnvelope {
	readonly v: number;
	readonly d: unknown;
	readonly t: number;
	readonly lock?: StoreLockState;
}

export function isStoreLockState(value: unknown): value is StoreLockState {
	if (!typeIs(value, "table")) {
		return false;
	}
	const candidate = value as { readonly owner?: unknown; readonly heartbeatMs?: unknown };
	return typeIs(candidate.owner, "string") && typeIs(candidate.heartbeatMs, "number");
}

export function isStoreEnvelope(value: unknown): value is StoreEnvelope {
	if (!typeIs(value, "table")) {
		return false;
	}
	const candidate = value as { readonly v?: unknown; readonly t?: unknown };
	return typeIs(candidate.v, "number") && typeIs(candidate.t, "number");
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

export interface StoreSnapshot<TValue> {
	readonly value: TValue;
	// False when the key held nothing and `value` is the store's default.
	readonly existed: boolean;
	// The version the record was stored at (0 for a pre-Aruna raw value).
	readonly version: number;
	readonly migrated: boolean;
	readonly updatedAtMs: number | undefined;
	readonly lock: StoreLockState | undefined;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

// Migrates a record written at an older version forward. Returning undefined
// means "I cannot migrate this", which surfaces as a StoreMigrationError rather
// than a silent reset to the default.
export type StoreMigrate<TSchema extends Schema> = (
	stored: unknown,
	fromVersion: number,
) => Infer<TSchema> | undefined;

export interface StoreRetryOptions {
	// Total attempts including the first; 1 disables retrying.
	readonly attempts?: number;
	readonly baseDelayMs?: number;
	readonly maxDelayMs?: number;
	// Fraction of the delay to randomize, 0..1, so a server's failed requests do
	// not all retry on the same tick.
	readonly jitter?: number;
}

export const DEFAULT_STORE_RETRY = {
	attempts: 4,
	baseDelayMs: 250,
	maxDelayMs: 8_000,
	jitter: 0.25,
} as const;

export interface StoreDefinition<TSchema extends Schema = Schema> {
	// The DataStore name, and the id the compiler records. Must be a static
	// string literal.
	readonly id: string;
	readonly scope?: string;
	readonly schema: TSchema;
	// Bumped when the shape changes; older records go to `migrate`. Defaults to 1.
	readonly version?: number;
	readonly migrate?: StoreMigrate<TSchema>;
	// The value a never-written key resolves to. A factory is called per key, so
	// mutable defaults are not shared between players.
	readonly defaultValue: Infer<TSchema> | (() => Infer<TSchema>);
	readonly retry?: StoreRetryOptions;
	// User ids to associate with each write, for the GDPR erasure tooling. Player
	// stores default this to the owning player.
	readonly userIds?: (key: string) => Array<number>;
}

export function resolveStoreVersion(definition: { readonly version?: number }): number {
	const version = definition.version;
	return version === undefined || version !== version ? 1 : math.floor(version);
}

export function resolveStoreDefault(definition: { readonly defaultValue: unknown }): unknown {
	const fallback = definition.defaultValue;
	return typeIs(fallback, "function") ? (fallback as () => unknown)() : fallback;
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export type StoreBackendRequestKind = "get" | "set" | "update" | "remove";

// Mirrors DataStore:UpdateAsync — returning undefined cancels the write.
export type StoreBackendTransform = (current: unknown) => unknown;

export interface StoreBackend {
	readonly get: (key: string) => Promise<unknown>;
	readonly set: (key: string, value: unknown, userIds?: Array<number>) => Promise<void>;
	readonly update: (
		key: string,
		transform: StoreBackendTransform,
		userIds?: Array<number>,
	) => Promise<unknown>;
	readonly remove: (key: string) => Promise<void>;
	// Remaining requests of this kind, when the backend can report it. A backend
	// that omits it is treated as unmetered.
	readonly getBudget?: (kind: StoreBackendRequestKind) => number;
}

export interface StoreBackendTarget {
	readonly id: string;
	readonly scope?: string;
}

export type StoreBackendFactory = (definition: StoreBackendTarget) => StoreBackend;

export interface MemoryStoreBackend extends StoreBackend {
	readonly snapshot: () => Map<string, unknown>;
	readonly reset: () => void;
}

// An in-memory backend with DataStore semantics. Backs the Studio fallback when
// API access is off, so a game running in Studio does not have to special-case
// persistence at every call site.
// Copied entry by entry: the Luau Map constructor takes an entry array, not
// another Map, and a shared reference would let a caller mutate the backend.
function cloneEntries(source: Map<string, unknown>): Map<string, unknown> {
	const copy = new Map<string, unknown>();
	for (const [key, value] of source) {
		copy.set(key, value);
	}
	return copy;
}

export function createMemoryStoreBackend(initial?: Map<string, unknown>): MemoryStoreBackend {
	let entries = initial !== undefined ? cloneEntries(initial) : new Map<string, unknown>();

	return {
		get: (key) => Promise.resolve(entries.get(key)),
		set: (key, value) => {
			entries.set(key, value);
			return Promise.resolve(undefined as unknown as void);
		},
		update: (key, transform) => {
			const current = entries.get(key);
			// `next` and `error` are reserved by the roblox-ts compiler, so locals
			// here take longer names than their reference-runtime counterparts.
			const nextValue = transform(current);
			if (nextValue === undefined) {
				return Promise.resolve(current);
			}
			entries.set(key, nextValue);
			return Promise.resolve(nextValue);
		},
		remove: (key) => {
			entries.delete(key);
			return Promise.resolve(undefined as unknown as void);
		},
		snapshot: () => cloneEntries(entries),
		reset: () => {
			entries = new Map<string, unknown>();
		},
	};
}

// ---------------------------------------------------------------------------
// Scheduling and retry
// ---------------------------------------------------------------------------

export interface StoreSchedulerHandle {
	readonly cancel: () => void;
}

export interface StoreScheduler {
	readonly delay: (ms: number, callback: () => void) => StoreSchedulerHandle;
}

// task.delay takes seconds; the thread is cancellable so a released document
// stops heartbeating immediately.
export const defaultStoreScheduler: StoreScheduler = {
	delay: (ms, callback) => {
		const thread = task.delay(ms / 1000, callback);
		return {
			cancel: () => {
				task.cancel(thread);
			},
		};
	},
};

export function storeDelay(scheduler: StoreScheduler, ms: number): Promise<void> {
	if (ms <= 0) {
		return Promise.resolve(undefined as unknown as void);
	}
	return new Promise<void>((resolve) => {
		scheduler.delay(ms, () => {
			resolve(undefined as unknown as void);
		});
	});
}

interface ResolvedRetry {
	readonly attempts: number;
	readonly baseDelayMs: number;
	readonly maxDelayMs: number;
	readonly jitter: number;
}

function positiveOr(value: number | undefined, fallback: number, minimum: number): number {
	if (value === undefined || value !== value || value < minimum) {
		return fallback;
	}
	return value;
}

function resolveRetry(options: StoreRetryOptions | undefined): ResolvedRetry {
	return {
		attempts: math.floor(
			positiveOr(options?.attempts, DEFAULT_STORE_RETRY.attempts, 1),
		),
		baseDelayMs: positiveOr(options?.baseDelayMs, DEFAULT_STORE_RETRY.baseDelayMs, 0),
		maxDelayMs: positiveOr(options?.maxDelayMs, DEFAULT_STORE_RETRY.maxDelayMs, 0),
		jitter: math.min(1, positiveOr(options?.jitter, DEFAULT_STORE_RETRY.jitter, 0)),
	};
}

// Capped exponential backoff with symmetric jitter. `attempt` is 1-based: the
// delay after the first failure is the base delay.
export function storeRetryDelayMs(
	attempt: number,
	options: StoreRetryOptions | undefined,
	random?: () => number,
): number {
	const resolved = resolveRetry(options);
	const exponent = math.max(0, attempt - 1);
	let exponential = resolved.baseDelayMs;
	for (let index = 0; index < exponent; index += 1) {
		exponential *= 2;
	}
	const capped = math.min(resolved.maxDelayMs, exponential);
	if (resolved.jitter === 0) {
		return capped;
	}
	const roll = random !== undefined ? random() : math.random();
	const spread = capped * resolved.jitter;
	return math.max(0, capped - spread + roll * spread * 2);
}

export interface StoreErrorClassification {
	readonly name: StoreErrorName;
	readonly retryable: boolean;
	readonly message: string;
}

// DataStore failures arrive as thrown strings, so classification is
// substring-based — kept in one place instead of scattered across retry loops.
export function classifyStoreError(cause: unknown): StoreErrorClassification {
	const message = typeIs(cause, "string") ? cause : tostring(cause);
	const normalized = message.lower();

	const contains = (needle: string): boolean => normalized.find(needle, 1, true)[0] !== undefined;

	// No API access is a configuration state, not a transient fault: retrying it
	// only delays the failure by the whole backoff budget.
	if (
		contains("403") ||
		contains("studio access to apis") ||
		contains("api services") ||
		contains("not enabled") ||
		contains("publish this place")
	) {
		return { name: "StoreUnavailableError", retryable: false, message };
	}

	if (
		contains("429") ||
		contains("throttl") ||
		contains("budget") ||
		contains("too many requests") ||
		contains("rate limit")
	) {
		return { name: "StoreThrottledError", retryable: true, message };
	}

	return { name: "StoreRequestError", retryable: true, message };
}

export interface StoreRequestOptions {
	readonly kind: StoreBackendRequestKind;
	readonly retry?: StoreRetryOptions;
	readonly scheduler?: StoreScheduler;
	readonly random?: () => number;
	// Checked before each attempt; a zero budget waits out a backoff instead of
	// spending a request that would be throttled anyway.
	readonly getBudget?: (kind: StoreBackendRequestKind) => number;
}

// The single choke point every store operation goes through: retry policy,
// budget gate, and error classification.
export function runStoreRequest<TValue>(
	request: () => Promise<TValue>,
	options: StoreRequestOptions,
): Promise<StoreResult<TValue>> {
	const retry = resolveRetry(options.retry);
	const scheduler = options.scheduler !== undefined ? options.scheduler : defaultStoreScheduler;

	const attemptFrom = (attempt: number, lastError: StoreError | undefined): Promise<StoreResult<TValue>> => {
		if (attempt > retry.attempts) {
			return Promise.resolve({
				ok: false,
				error:
					lastError !== undefined
						? lastError
						: {
								name: "StoreRequestError" as StoreErrorName,
								message: "The store request failed with no recorded error.",
								retryable: true,
								attempts: retry.attempts,
							},
			});
		}

		const wait =
			attempt > 1
				? storeDelay(scheduler, storeRetryDelayMs(attempt - 1, options.retry, options.random))
				: Promise.resolve(undefined as unknown as void);

		return wait.then(() => {
			const getBudget = options.getBudget;
			if (getBudget !== undefined && getBudget(options.kind) < 1) {
				return attemptFrom(attempt + 1, {
					name: "StoreThrottledError",
					message: `No DataStore request budget left for a ${options.kind} request.`,
					retryable: true,
					attempts: attempt,
					retryAfterMs: storeRetryDelayMs(attempt, options.retry, options.random),
				});
			}

			return request().then(
				(value) => storeOk(value) as StoreResult<TValue>,
				(cause: unknown) => {
					const classified = classifyStoreError(cause);
					const failure: StoreError = {
						name: classified.name,
						message: classified.message,
						retryable: classified.retryable,
						attempts: attempt,
						cause,
					};
					if (!classified.retryable) {
						return { ok: false, error: failure } as StoreResult<TValue>;
					}
					return attemptFrom(attempt + 1, failure);
				},
			);
		});
	};

	return attemptFrom(1, undefined);
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

export interface StoreCodecDefinition {
	readonly id: string;
	readonly schema: Schema;
	readonly version?: number;
	readonly migrate?: (stored: unknown, fromVersion: number) => unknown;
	readonly defaultValue: unknown;
}

// Turns a raw stored value into a validated snapshot. The no-blind-overwrite
// rule lives here: every path that cannot produce a trustworthy value returns an
// error, and only a genuinely absent key resolves to the default.
export function decodeStoreValue(
	definition: StoreCodecDefinition,
	raw: unknown,
): StoreResult<StoreSnapshot<unknown>> {
	const currentVersion = resolveStoreVersion(definition);

	if (raw === undefined) {
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
	// DataStore this store is adopting). Treat it as version 0 so `migrate` gets a
	// chance at it instead of failing validation outright.
	const storedVersion = envelope !== undefined ? envelope.v : 0;
	const storedData = envelope !== undefined ? envelope.d : raw;
	const lock = envelope !== undefined && isStoreLockState(envelope.lock) ? envelope.lock : undefined;
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

		const [invoked, migrateResult] = pcall(() => migrate(storedData, storedVersion));
		if (!invoked) {
			return storeFail(
				"StoreMigrationError",
				`Store ${definition.id} failed to migrate a record from version ${storedVersion}: ${tostring(migrateResult)}`,
				{ cause: migrateResult },
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
	if (!definition.schema.validate(withDefaults)) {
		const issue = firstSchemaIssue(definition.schema, withDefaults);
		const detail = issue !== undefined ? issue : "the value did not match the store schema";
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

// Gates every outbound value: schema first (so the caller sees the precise
// field), then storability, then size.
export function encodeStoreValue(
	definition: { readonly id: string; readonly schema: Schema; readonly version?: number },
	value: unknown,
	nowMs: number,
	lock?: StoreLockState,
): StoreResult<StoreEnvelope> {
	if (!definition.schema.validate(value)) {
		const issue = firstSchemaIssue(definition.schema, value);
		const detail = issue !== undefined ? issue : "the value did not match the store schema";
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

export interface StoreErrorInfo {
	readonly storeId: string;
	readonly key: string;
	readonly operation: StoreOperation;
}

export type StoreErrorReporter = (error: StoreError, info: StoreErrorInfo) => void;

export interface StoreRuntimeOptions {
	// A ready backend, or a factory called with the store's id and scope. Pass
	// `robloxDataStoreBackend` from `aruna/roblox` for the real service.
	readonly backend?: StoreBackend;
	readonly createBackend?: StoreBackendFactory;
	readonly scheduler?: StoreScheduler;
	readonly nowMs?: () => number;
	readonly random?: () => number;
	// Observability hook for every failure, called before the error is returned.
	readonly onError?: StoreErrorReporter;
}

export interface Store<TSchema extends Schema = Schema> {
	readonly id: string;
	readonly definition: StoreDefinition<TSchema>;
	readonly backend: StoreBackend;
	// Reads a key, filling defaults and migrating as needed. A missing key
	// resolves to the default; a corrupt one resolves to an error.
	readonly load: (key: string) => Promise<StoreResult<Infer<TSchema>>>;
	// `load` plus the record metadata (existed, version, lock, timestamp).
	readonly loadSnapshot: (key: string) => Promise<StoreResult<StoreSnapshot<Infer<TSchema>>>>;
	// Writes through UpdateAsync so a session lock is preserved, not clobbered.
	readonly save: (key: string, value: Infer<TSchema>) => Promise<StoreResult<Infer<TSchema>>>;
	// Read-modify-write inside a single UpdateAsync.
	readonly update: (
		key: string,
		transform: (current: Infer<TSchema>) => Infer<TSchema>,
	) => Promise<StoreResult<Infer<TSchema>>>;
	readonly remove: (key: string) => Promise<StoreResult<undefined>>;
	// SetAsync, ignoring any session lock. For admin and migration tooling; game
	// code should use `save`/`update`.
	readonly overwrite: (key: string, value: Infer<TSchema>) => Promise<StoreResult<Infer<TSchema>>>;
}

function defaultNowMs(): number {
	return DateTime.now().UnixTimestampMillis;
}

export function createStore<TSchema extends Schema>(
	definition: StoreDefinition<TSchema>,
	options?: StoreRuntimeOptions,
): Store<TSchema> {
	const backend =
		options !== undefined && options.backend !== undefined
			? options.backend
			: options !== undefined && options.createBackend !== undefined
				? options.createBackend(definition)
				: createMemoryStoreBackend();
	const nowMs = options !== undefined && options.nowMs !== undefined ? options.nowMs : defaultNowMs;
	const onError = options !== undefined ? options.onError : undefined;
	const codec = definition as unknown as StoreCodecDefinition;

	const requestOptions = (kind: StoreBackendRequestKind): StoreRequestOptions => ({
		kind,
		...(definition.retry !== undefined ? { retry: definition.retry } : {}),
		...(options !== undefined && options.scheduler !== undefined
			? { scheduler: options.scheduler }
			: {}),
		...(options !== undefined && options.random !== undefined ? { random: options.random } : {}),
		...(backend.getBudget !== undefined ? { getBudget: backend.getBudget } : {}),
	});

	// Routes a failure through the observability hook on its way back to the
	// caller.
	const failed = (result: StoreFailure, key: string, operation: StoreOperation): StoreFailure => {
		if (onError !== undefined) {
			onError(result.error, { storeId: definition.id, key, operation });
		}
		return result;
	};

	const userIdsFor = (key: string): Array<number> | undefined =>
		definition.userIds !== undefined ? definition.userIds(key) : undefined;

	const loadSnapshot = (key: string): Promise<StoreResult<StoreSnapshot<unknown>>> => {
		const keyResult = validateStoreKey(key);
		if (!keyResult.ok) {
			return Promise.resolve(failed(keyResult, key, "load"));
		}

		return runStoreRequest(() => backend.get(key), requestOptions("get")).then((raw) => {
			if (!raw.ok) {
				return failed(raw, key, "load");
			}
			const decoded = decodeStoreValue(codec, raw.value);
			return decoded.ok ? decoded : failed(decoded, key, "load");
		});
	};

	// Both `save` and `update` funnel here: one UpdateAsync that decodes the
	// current record, computes the next value, and re-wraps it while carrying any
	// existing lock forward.
	const writeThrough = (
		key: string,
		operation: StoreOperation,
		computeNext: (current: unknown, snapshot: StoreSnapshot<unknown>) => unknown,
	): Promise<StoreResult<unknown>> => {
		const keyResult = validateStoreKey(key);
		if (!keyResult.ok) {
			return Promise.resolve(failed(keyResult, key, operation));
		}

		// A failure raised inside the transform cannot travel through UpdateAsync's
		// return channel (undefined there means "cancel the write"), so it is
		// captured here and surfaced once the request settles.
		let failure: StoreFailure | undefined;

		return runStoreRequest(
			() =>
				backend.update(
					key,
					(current) => {
						const decoded = decodeStoreValue(codec, current);
						if (!decoded.ok) {
							failure = decoded;
							return undefined;
						}
						const encoded = encodeStoreValue(
							definition,
							computeNext(decoded.value.value, decoded.value),
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
		).then((written) => {
			if (failure !== undefined) {
				return failed(failure, key, operation);
			}
			if (!written.ok) {
				return failed(written, key, operation);
			}
			const decoded = decodeStoreValue(codec, written.value);
			if (!decoded.ok) {
				return failed(decoded, key, operation);
			}
			return storeOk(decoded.value.value);
		});
	};

	const implementation = {
		id: definition.id,
		definition,
		backend,
		loadSnapshot,
		load: (key: string) =>
			loadSnapshot(key).then((snapshot) =>
				snapshot.ok ? storeOk(snapshot.value.value) : snapshot,
			),
		save: (key: string, value: unknown) => writeThrough(key, "save", () => value),
		update: (key: string, transform: (current: unknown) => unknown) =>
			writeThrough(key, "update", (current) => transform(current)),
		overwrite: (key: string, value: unknown) => {
			const keyResult = validateStoreKey(key);
			if (!keyResult.ok) {
				return Promise.resolve(failed(keyResult, key, "save"));
			}
			const encoded = encodeStoreValue(definition, value, nowMs());
			if (!encoded.ok) {
				return Promise.resolve(failed(encoded, key, "save"));
			}
			return runStoreRequest(
				() => backend.set(key, encoded.value, userIdsFor(key)),
				requestOptions("set"),
			).then((written) => (written.ok ? storeOk(value) : failed(written, key, "save")));
		},
		remove: (key: string) => {
			const keyResult = validateStoreKey(key);
			if (!keyResult.ok) {
				return Promise.resolve(failed(keyResult, key, "remove"));
			}
			return runStoreRequest(() => backend.remove(key), requestOptions("remove")).then((removed) =>
				removed.ok ? storeOk(undefined) : failed(removed, key, "remove"),
			);
		},
	};

	// The implementation works in erased values; `Store<TSchema>` re-applies the
	// schema-derived type for consumers, who are the ones who benefit from it.
	return implementation as unknown as Store<TSchema>;
}
