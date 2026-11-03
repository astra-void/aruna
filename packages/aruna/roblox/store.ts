// Aruna roblox-ts native runtime — the safe DataStore core.
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
//   * Budget awareness. When the backend reports a request budget
//     (GetRequestBudgetForRequestType), an exhausted budget waits instead of
//     burning the request and eating a throttle.
//   * Versioned payloads. Every write carries a version and a timestamp, so an
//     older record can be migrated forward instead of silently reinterpreted.

import type { Infer, Schema } from "./schema";
import { applyDefaults, firstSchemaIssue } from "./schema-check";

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
	// The record was written by a newer version of the game than this server
	// runs. Never migrated, never written back: migrating it down, or saving
	// over it, would destroy what the newer server wrote.
	| "StoreVersionAheadError"
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
// Envelope: persisted format v1 (docs/stores.md, "Persisted format v1")
// ---------------------------------------------------------------------------
//
// Every record Aruna writes is wrapped in this envelope. It is permanent: once a
// game has saved records, a reader handles every format it ever wrote. Short
// field names because the wrapper is pure overhead against the 4 MB per-key
// budget.
//
//   { "$aruna": 1, v, d, t, m?, l? }
//
// The marker is an explicit field rather than a shape test: any table whose
// marker is not a positive integer is a raw value the store is adopting, however
// much it looks like an envelope.
//
// How it evolves: the top level is closed — a v1 envelope with any other field
// is malformed — and changes only by bumping STORE_ENVELOPE_FORMAT. Additive
// fields go in `m`, which is open: a key this reader does not know is carried
// through every write verbatim (up to STORE_MAX_PRESERVED_META_BYTES) and
// otherwise ignored, unless it starts with STORE_MUST_UNDERSTAND_PREFIX, in
// which case the reader refuses the record (StoreVersionAheadError) and never
// writes it back. A field is must-understand only when ignoring it would cause
// harm.

// The marker field. Its value is the envelope format version.
export const STORE_ENVELOPE_MARKER = "$aruna";
// The envelope format this runtime writes, and the newest it reads.
export const STORE_ENVELOPE_FORMAT = 1;
// Processed purchase receipt ids kept per record: the most recent N, oldest
// evicted first.
export const STORE_MAX_RECEIPTS = 100;
// Upper bound on a receipt id and on a handoff token, in UTF-8 bytes.
export const STORE_MAX_META_ID_BYTES = 128;
// A metadata key that starts with this must be understood: a reader that does
// not know it refuses the record instead of ignoring the key.
export const STORE_MUST_UNDERSTAND_PREFIX = "!";
// Upper bound on the metadata a reader carries without understanding it — every
// `m` key it does not know, JSON-encoded together. Over it, the record is
// refused (StoreValidationError), never truncated.
export const STORE_MAX_PRESERVED_META_BYTES = 4096;

// The envelope's fields; any other top-level key makes a v1 envelope malformed.
const STORE_ENVELOPE_FIELDS = new Set<string>([STORE_ENVELOPE_MARKER, "v", "d", "t", "m", "l"]);
// The `m` keys this reader understands.
const META_RECEIPTS = "!r";
const META_HANDOFF = "h";
const META_ERASED = "e";

// The session lock a player store writes alongside the data. It lives inside
// the record so claiming it and reading the data are one atomic UpdateAsync
// (docs/stores.md, "Where the session lock lives").
export interface StoreLockState {
	// `${JobId}:${PlaceId}` for a live server.
	readonly owner: string;
	// When the holder last proved it was alive. Older than the TTL means the
	// lock is stale and may be taken over.
	readonly heartbeatMs: number;
}

// A one-time token a server leaves for the server a player is teleporting to,
// so that server can take the session lock without waiting out the TTL.
export interface StoreHandoff {
	readonly token: string;
	readonly expiresAtMs: number;
}

// Framework-owned metadata. Never validated against the store's schema, never
// passed to `migrate`, and carried through every write unchanged unless the
// framework itself changes it.
export interface StoreMeta {
	// Processed purchase receipt ids, oldest first, at most STORE_MAX_RECEIPTS.
	readonly receipts: ReadonlyArray<string>;
	readonly handoff?: StoreHandoff;
	// When the record's data was erased on a right-to-erasure request.
	readonly erasedAtMs?: number;
	// The `m` keys this runtime does not understand, as read: written back
	// verbatim on every write, never interpreted. Absent when there are none.
	readonly preserved?: { readonly [key: string]: unknown };
}

// The persisted forms. `StoreLockState`/`StoreMeta` are what the runtime works
// with; these are what a DataStore holds.
export interface StoreEnvelopeLock {
	readonly o: string;
	readonly h: number;
}

export interface StoreEnvelopeMeta {
	readonly "!r"?: Array<string>;
	readonly h?: { readonly k: string; readonly x: number };
	readonly e?: number;
	// Keys a newer Aruna wrote, carried through as they were.
	readonly [key: string]: unknown;
}

export interface StoreEnvelope {
	readonly "$aruna": number;
	readonly v: number;
	readonly d: unknown;
	readonly t: number;
	readonly m?: StoreEnvelopeMeta;
	readonly l?: StoreEnvelopeLock;
}

export function emptyStoreMeta(): StoreMeta {
	return { receipts: [] };
}

function isMetaId(value: unknown): value is string {
	return typeIs(value, "string") && value.size() > 0 && value.size() <= STORE_MAX_META_ID_BYTES;
}

function isFiniteValue(value: unknown): value is number {
	return typeIs(value, "number") && isFiniteNumber(value);
}

// Records a processed receipt id, evicting the oldest beyond STORE_MAX_RECEIPTS.
// An id already recorded leaves the metadata as it was.
export function recordStoreReceipt(meta: StoreMeta, receiptId: string): StoreResult<StoreMeta> {
	if (!isMetaId(receiptId)) {
		return storeFail(
			"StoreValidationError",
			`A receipt id must be a non-empty string of at most ${STORE_MAX_META_ID_BYTES} bytes.`,
		);
	}
	if (meta.receipts.includes(receiptId)) {
		return storeOk(meta);
	}
	const receipts = [...meta.receipts, receiptId];
	while (receipts.size() > STORE_MAX_RECEIPTS) {
		receipts.shift();
	}
	return storeOk({ ...meta, receipts });
}

export function hasStoreReceipt(meta: StoreMeta, receiptId: string): boolean {
	return meta.receipts.includes(receiptId);
}

// Why `m` could not be read: it does not fit (malformed), or it carries a key
// this reader must understand and does not (ahead).
interface MetaRefusal {
	readonly refusal: "malformed" | "ahead";
	readonly reason: string;
}

function readEnvelopeMeta(raw: unknown): StoreMeta | MetaRefusal {
	if (raw === undefined) {
		return emptyStoreMeta();
	}
	if (!typeIs(raw, "table")) {
		return { refusal: "malformed", reason: "m must be a table" };
	}
	const fields = raw as { readonly [key: string]: unknown };
	// Every key first: an unknown must-understand key refuses the record however
	// the rest of it reads, and what is not understood is set aside verbatim.
	let preserved: { [key: string]: unknown } | undefined;
	for (const [key, value] of pairs(fields)) {
		if (!typeIs(key, "string")) {
			return { refusal: "malformed", reason: "m must have only string keys" };
		}
		if (key === META_RECEIPTS || key === META_HANDOFF || key === META_ERASED) {
			continue;
		}
		if (key.sub(1, STORE_MUST_UNDERSTAND_PREFIX.size()) === STORE_MUST_UNDERSTAND_PREFIX) {
			return { refusal: "ahead", reason: key };
		}
		if (preserved === undefined) {
			preserved = {};
		}
		preserved[key] = value;
	}
	if (preserved !== undefined) {
		const bytes = measureStoreValueBytes(preserved);
		if (bytes > STORE_MAX_PRESERVED_META_BYTES) {
			return {
				refusal: "malformed",
				reason: `m holds ${bytes === math.huge ? "unencodable" : `${bytes} bytes of`} metadata this server does not read, over the ${STORE_MAX_PRESERVED_META_BYTES}-byte bound`,
			};
		}
	}

	const receiptsField = fields[META_RECEIPTS];
	const receipts: Array<string> = [];
	if (receiptsField !== undefined) {
		if (!typeIs(receiptsField, "table")) {
			return { refusal: "malformed", reason: "m.!r must be an array" };
		}
		for (const id of receiptsField as Array<unknown>) {
			if (!isMetaId(id)) {
				return {
					refusal: "malformed",
					reason: `m.!r holds an id that is not a string of 1..${STORE_MAX_META_ID_BYTES} bytes`,
				};
			}
			receipts.push(id);
		}
		// Bounds are enforced on read as well as on write.
		while (receipts.size() > STORE_MAX_RECEIPTS) {
			receipts.shift();
		}
	}
	const handoffField = fields[META_HANDOFF];
	let handoff: StoreHandoff | undefined;
	if (handoffField !== undefined) {
		const token = typeIs(handoffField, "table") ? (handoffField as { k?: unknown; x?: unknown }) : undefined;
		if (token === undefined || !isMetaId(token.k) || !isFiniteValue(token.x)) {
			return { refusal: "malformed", reason: "m.h must be { k: token, x: expiry ms }" };
		}
		handoff = { token: token.k, expiresAtMs: token.x };
	}
	const erasedField = fields[META_ERASED];
	if (erasedField !== undefined && !isFiniteValue(erasedField)) {
		return { refusal: "malformed", reason: "m.e must be a number" };
	}
	return {
		receipts,
		...(handoff !== undefined ? { handoff } : {}),
		...(erasedField !== undefined ? { erasedAtMs: erasedField as number } : {}),
		...(preserved !== undefined ? { preserved } : {}),
	};
}

function writeEnvelopeMeta(meta: StoreMeta | undefined): StoreEnvelopeMeta | undefined {
	if (meta === undefined) {
		return undefined;
	}
	const receipts = [...meta.receipts];
	while (receipts.size() > STORE_MAX_RECEIPTS) {
		receipts.shift();
	}
	const m: { [key: string]: unknown } = {};
	let empty = true;
	// What this runtime does not understand goes back exactly as it was read. A
	// key it does understand is always written from its own field, below.
	if (meta.preserved !== undefined) {
		for (const [key, value] of pairs(meta.preserved)) {
			m[key] = value;
			empty = false;
		}
	}
	if (receipts.size() > 0) {
		m[META_RECEIPTS] = receipts;
		empty = false;
	}
	if (meta.handoff !== undefined) {
		m[META_HANDOFF] = { k: meta.handoff.token, x: meta.handoff.expiresAtMs };
		empty = false;
	}
	if (meta.erasedAtMs !== undefined) {
		m[META_ERASED] = meta.erasedAtMs;
		empty = false;
	}
	// Empty metadata is omitted, so a record without any reads back the same.
	return empty ? undefined : (m as StoreEnvelopeMeta);
}

function readEnvelopeLock(raw: unknown): StoreLockState | undefined | string {
	if (raw === undefined) {
		return undefined;
	}
	const candidate = typeIs(raw, "table") ? (raw as { o?: unknown; h?: unknown }) : undefined;
	if (candidate === undefined || !typeIs(candidate.o, "string") || !isFiniteValue(candidate.h)) {
		return "l must be { o: owner, h: heartbeat ms }";
	}
	return { owner: candidate.o, heartbeatMs: candidate.h };
}

export function createStoreEnvelope(
	version: number,
	data: unknown,
	nowMs: number,
	lock?: StoreLockState,
	meta?: StoreMeta,
): StoreEnvelope {
	const m = writeEnvelopeMeta(meta);
	return {
		"$aruna": STORE_ENVELOPE_FORMAT,
		v: version,
		d: data,
		t: nowMs,
		...(m !== undefined ? { m } : {}),
		...(lock !== undefined ? { l: { o: lock.owner, h: lock.heartbeatMs } } : {}),
	};
}

// What a stored value turned out to be.
export type StoreRecord =
	// Nothing at the key.
	| { readonly kind: "absent" }
	// A value with no valid marker: data from before this store owned the key
	// (or written by hand). Adopted at version 0 and sent to `migrate`.
	| { readonly kind: "legacy"; readonly data: unknown }
	| {
			readonly kind: "envelope";
			readonly version: number;
			readonly data: unknown;
			readonly updatedAtMs: number;
			readonly meta: StoreMeta;
			readonly lock: StoreLockState | undefined;
	  }
	// Marked with a format this runtime does not read.
	| { readonly kind: "format-ahead"; readonly format: number }
	// A v1 envelope whose metadata holds a must-understand key this runtime does
	// not know: written by a newer Aruna.
	| { readonly kind: "meta-ahead"; readonly key: string }
	// Marked as a v1 envelope, with fields that do not fit it.
	| { readonly kind: "malformed"; readonly reason: string };

export function readStoreRecord(raw: unknown): StoreRecord {
	if (raw === undefined) {
		return { kind: "absent" };
	}
	if (!typeIs(raw, "table")) {
		return { kind: "legacy", data: raw };
	}
	const candidate = raw as {
		readonly "$aruna"?: unknown;
		readonly v?: unknown;
		readonly d?: unknown;
		readonly t?: unknown;
		readonly m?: unknown;
		readonly l?: unknown;
	};
	const format = candidate["$aruna"];
	// The marker check: a positive integer, or this is not an envelope at all.
	if (!isFiniteValue(format) || format < 1 || math.floor(format) !== format) {
		return { kind: "legacy", data: raw };
	}
	if (format > STORE_ENVELOPE_FORMAT) {
		return { kind: "format-ahead", format };
	}
	// The top level is closed: a field v1 does not define means the record is not
	// what it claims to be (an additive field belongs in `m`).
	for (const [key] of pairs(raw as { readonly [key: string]: unknown })) {
		if (!typeIs(key, "string") || !STORE_ENVELOPE_FIELDS.has(key)) {
			return { kind: "malformed", reason: `unknown top-level field ${tostring(key)}` };
		}
	}
	if (!isFiniteValue(candidate.v) || candidate.v < 0) {
		return { kind: "malformed", reason: "v must be a non-negative number" };
	}
	if (!isFiniteValue(candidate.t)) {
		return { kind: "malformed", reason: "t must be a number" };
	}
	const meta = readEnvelopeMeta(candidate.m);
	if ((meta as Partial<MetaRefusal>).refusal !== undefined) {
		const refused = meta as MetaRefusal;
		return refused.refusal === "ahead"
			? { kind: "meta-ahead", key: refused.reason }
			: { kind: "malformed", reason: refused.reason };
	}
	const understood = meta as StoreMeta;
	const lock = readEnvelopeLock(candidate.l);
	if (typeIs(lock, "string")) {
		return { kind: "malformed", reason: lock };
	}
	return {
		kind: "envelope",
		version: candidate.v,
		data: candidate.d,
		updatedAtMs: candidate.t,
		meta: understood,
		lock,
	};
}

export function isStoreEnvelope(value: unknown): value is StoreEnvelope {
	return readStoreRecord(value).kind === "envelope";
}

export interface StoreSnapshot<TValue> {
	readonly value: TValue;
	// False when the key held nothing and `value` is the store's default.
	readonly existed: boolean;
	// The version the record was stored at (0 for an adopted raw value).
	readonly version: number;
	readonly migrated: boolean;
	readonly updatedAtMs: number | undefined;
	readonly lock: StoreLockState | undefined;
	readonly meta: StoreMeta;
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
	// Marks a backend that persists nothing: what a player store reports as
	// `memoryOnly` (the Studio fallback, a spec's backend).
	readonly memory: true;
}

// Whether a backend keeps nothing past the server: an in-memory one.
export function isMemoryStoreBackend(backend: StoreBackend): boolean {
	return (backend as { readonly memory?: unknown }).memory === true;
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
		memory: true,
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

	const record = readStoreRecord(raw);

	if (record.kind === "absent") {
		return storeOk({
			value: resolveStoreDefault(definition),
			existed: false,
			version: currentVersion,
			migrated: false,
			updatedAtMs: undefined,
			lock: undefined,
			meta: emptyStoreMeta(),
		});
	}

	// Written by a newer runtime. Reading it as a raw value would hand the whole
	// envelope to `migrate`, and a save would bury it inside a v1 envelope.
	if (record.kind === "format-ahead") {
		return storeFail(
			"StoreVersionAheadError",
			`Store ${definition.id} read a record in envelope format ${record.format}; this server reads format ${STORE_ENVELOPE_FORMAT}. This server is running an older version of Aruna.`,
		);
	}

	// Metadata a newer Aruna marked must-understand. Ignoring it could do harm
	// (a processed receipt granted twice, say), and writing the record back
	// would carry it unread, so the record is refused like a newer format.
	if (record.kind === "meta-ahead") {
		return storeFail(
			"StoreVersionAheadError",
			`Store ${definition.id} read a record whose metadata holds "${record.key}", which this server must understand and does not. This server is running an older version of Aruna.`,
		);
	}

	if (record.kind === "malformed") {
		return storeFail(
			"StoreValidationError",
			`Store ${definition.id} read a record whose envelope is malformed (${record.reason}).`,
		);
	}

	// A raw value predates the store (a hand-rolled DataStore this store is
	// adopting). It is version 0, so `migrate` gets a chance at it instead of
	// failing validation outright.
	const storedVersion = record.kind === "envelope" ? record.version : 0;
	const storedData = record.data;
	const lock = record.kind === "envelope" ? record.lock : undefined;
	const updatedAtMs = record.kind === "envelope" ? record.updatedAtMs : undefined;
	const meta = record.kind === "envelope" ? record.meta : emptyStoreMeta();

	// A record from the future. Handing it to `migrate` would let a permissive
	// migration pass newer data through, which this server would then save under
	// its older version — and the next new server would migrate it again.
	if (storedVersion > currentVersion) {
		return storeFail(
			"StoreVersionAheadError",
			`Store ${definition.id} read a record at version ${storedVersion}, newer than this server's version ${currentVersion}. This server is running an older version of the game.`,
		);
	}

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
		meta,
	});
}

// Gates every outbound value: schema first (so the caller sees the precise
// field), then storability, then size. The size counts the whole envelope,
// metadata and lock included.
export function encodeStoreValue(
	definition: { readonly id: string; readonly schema: Schema; readonly version?: number },
	value: unknown,
	nowMs: number,
	lock?: StoreLockState,
	meta?: StoreMeta,
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

	const envelope = createStoreEnvelope(resolveStoreVersion(definition), value, nowMs, lock, meta);
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

// One line for a log, with what a failure is and none of the data: the store,
// the operation, the key, the error's category, whether the store will retry
// it, how many attempts it took, and when to retry. Never the record's value.
export function describeStoreError(failure: StoreError, info?: StoreErrorInfo): string {
	const facts = new Array<string>();
	facts.push(failure.retryable ? "retryable" : "not retryable");
	if (failure.attempts !== undefined) {
		facts.push(`${failure.attempts} ${failure.attempts === 1 ? "attempt" : "attempts"}`);
	}
	if (failure.retryAfterMs !== undefined) {
		facts.push(`retry after ${math.ceil(failure.retryAfterMs)}ms`);
	}
	const where =
		info !== undefined ? `[aruna store ${info.storeId}] ${info.operation} ${info.key}` : "[aruna store]";
	return `${where}: ${failure.name} (${facts.join(", ")}): ${failure.message}`;
}

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
	// `load` plus the record metadata (existed, version, lock, timestamp, meta).
	readonly loadSnapshot: (key: string) => Promise<StoreResult<StoreSnapshot<Infer<TSchema>>>>;
	// Writes through UpdateAsync so a session lock is preserved, not clobbered.
	readonly save: (key: string, value: Infer<TSchema>) => Promise<StoreResult<Infer<TSchema>>>;
	// Read-modify-write inside a single UpdateAsync.
	readonly update: (
		key: string,
		transform: (current: Infer<TSchema>) => Infer<TSchema>,
	) => Promise<StoreResult<Infer<TSchema>>>;
	readonly remove: (key: string) => Promise<StoreResult<undefined>>;
	// SetAsync, ignoring the current record entirely: the session lock and the
	// framework metadata (processed receipts among it) are not carried over. For
	// admin and migration tooling; game code should use `save`/`update`.
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
	// current record, computes the next value, and re-wraps it while carrying the
	// existing lock and metadata forward.
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
							decoded.value.meta,
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
