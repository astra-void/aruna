// Aruna roblox-ts native runtime — store test utilities, from `aruna/testing`.
//
// A spec about persistence needs three things the plain memory backend does not
// give it: records as an older build wrote them (a migration's input), a
// backend that fails when told to (a DataStore outage mid-load or mid-save),
// and a way to read back exactly what was written (that a failure overwrote
// nothing). `createTestStoreBackend` is the memory backend plus those three.
// Records are written in the format a real server writes (store.ts), so the
// store under test decodes them through its own code path.

import {
	createMemoryStoreBackend,
	createStoreEnvelope,
	readStoreRecord,
	type MemoryStoreBackend,
	type StoreBackendRequestKind,
	type StoreLockState,
} from "./store";

export interface TestStoreRecordOptions {
	// The store version the record claims (default 1). A version below the
	// store's goes to its `migrate`; one above it is refused.
	readonly version?: number;
	// A session lock held by another server: `owner` and when it last
	// heartbeated (default: now, so the lock is live).
	readonly lock?: { readonly owner: string; readonly heartbeatMs?: number };
	readonly updatedAtMs?: number;
}

// What a key holds, decoded: the envelope a store wrote, a raw value written
// before (or around) the store, or nothing.
export type TestStoreRecord =
	| { readonly kind: "absent" }
	| { readonly kind: "legacy"; readonly value: unknown }
	| {
			readonly kind: "envelope";
			readonly version: number;
			readonly value: unknown;
			readonly updatedAtMs: number;
			readonly lock: StoreLockState | undefined;
	  }
	// Written by a newer Aruna (another format, a must-understand key), or
	// marked as an envelope with fields that do not fit one.
	| { readonly kind: "unreadable"; readonly reason: string };

export interface TestStoreBackend extends MemoryStoreBackend {
	// Writes a record as a server running `options.version` of the store would.
	readonly seed: (key: string, value: unknown, options?: TestStoreRecordOptions) => void;
	// Writes anything at all: a corrupt record, a pre-Aruna value.
	readonly seedRaw: (key: string, raw: unknown) => void;
	// What the key holds now.
	readonly record: (key: string) => TestStoreRecord;
	// Makes the next `count` requests of `kind` fail with `message` (default a
	// transient DataStore error, which the store retries). `"403: ..."` is
	// permanent, `"429: ..."` throttling: the store classifies the message.
	readonly failNext: (kind: StoreBackendRequestKind, count?: number, message?: string) => void;
	// Fails every request of `kind` until `heal(kind)` (an outage).
	readonly failAll: (kind: StoreBackendRequestKind, message?: string) => void;
	readonly heal: (kind?: StoreBackendRequestKind) => void;
	// Holds every request of `kind` until `resume(kind)`: a DataStore call still
	// in flight (a player leaving mid-load, a shutdown mid-save).
	readonly hold: (kind: StoreBackendRequestKind) => void;
	readonly resume: (kind: StoreBackendRequestKind) => void;
	// How many requests of `kind` reached the backend, failed ones included.
	readonly requests: (kind: StoreBackendRequestKind) => number;
	// How many writes changed a key (an `update` whose transform cancelled is
	// not one).
	readonly writes: () => number;
}

const DEFAULT_FAILURE = "500: Internal error (test backend)";

export function createTestStoreBackend(nowMs?: () => number): TestStoreBackend {
	const inner = createMemoryStoreBackend();
	const readNow = nowMs !== undefined ? nowMs : () => 0;
	const pending = new Map<StoreBackendRequestKind, Array<string>>();
	const outages = new Map<StoreBackendRequestKind, string>();
	const counts = new Map<StoreBackendRequestKind, number>();
	let writes = 0;
	const held = new Map<StoreBackendRequestKind, Array<() => void>>();

	// Runs `request` now, or once `kind` is resumed.
	const gate = <T>(kind: StoreBackendRequestKind, request: () => Promise<T>): Promise<T> => {
		const queue = held.get(kind);
		if (queue === undefined) {
			return request();
		}
		return new Promise<T>((resolve, reject) => {
			queue.push(() => {
				request().then(resolve, reject);
			});
		});
	};

	// Returns the failure for this request, if it fails.
	const take = (kind: StoreBackendRequestKind): string | undefined => {
		counts.set(kind, (counts.get(kind) ?? 0) + 1);
		const outage = outages.get(kind);
		if (outage !== undefined) {
			return outage;
		}
		const queued = pending.get(kind);
		if (queued !== undefined && queued.size() > 0) {
			return queued.remove(0);
		}
		return undefined;
	};

	return {
		...inner,
		get: (key) =>
			gate("get", () => {
				const failure = take("get");
				return failure !== undefined ? Promise.reject(failure) : inner.get(key);
			}),
		set: (key, value, userIds) => {
			const failure = take("set");
			if (failure !== undefined) {
				return Promise.reject(failure) as Promise<void>;
			}
			writes += 1;
			return inner.set(key, value, userIds);
		},
		update: (key, transform, userIds) =>
			gate("update", () => {
				const failure = take("update");
				if (failure !== undefined) {
					return Promise.reject(failure);
				}
				return inner.update(
					key,
					(current) => {
						const updated = transform(current);
						if (updated !== undefined) {
							writes += 1;
						}
						return updated;
					},
					userIds,
				);
			}),
		remove: (key) => {
			const failure = take("remove");
			if (failure !== undefined) {
				return Promise.reject(failure) as Promise<void>;
			}
			writes += 1;
			return inner.remove(key);
		},
		seed: (key, value, options) => {
			const at = readNow();
			const lock =
				options !== undefined && options.lock !== undefined
					? {
							owner: options.lock.owner,
							heartbeatMs: options.lock.heartbeatMs !== undefined ? options.lock.heartbeatMs : at,
						}
					: undefined;
			const envelope = createStoreEnvelope(
				options !== undefined && options.version !== undefined ? options.version : 1,
				value,
				options !== undefined && options.updatedAtMs !== undefined ? options.updatedAtMs : at,
				lock,
			);
			void inner.set(key, envelope);
		},
		seedRaw: (key, raw) => {
			void inner.set(key, raw);
		},
		record: (key) => {
			const raw = inner.snapshot().get(key);
			const read = readStoreRecord(raw);
			if (read.kind === "absent") {
				return { kind: "absent" };
			}
			if (read.kind === "legacy") {
				return { kind: "legacy", value: read.data };
			}
			if (read.kind === "envelope") {
				return {
					kind: "envelope",
					version: read.version,
					value: read.data,
					updatedAtMs: read.updatedAtMs,
					lock: read.lock,
				};
			}
			return {
				kind: "unreadable",
				reason: read.kind === "malformed" ? read.reason : read.kind === "format-ahead" ? "format-ahead" : "meta-ahead",
			};
		},
		failNext: (kind, count, message) => {
			let queued = pending.get(kind);
			if (queued === undefined) {
				queued = new Array<string>();
				pending.set(kind, queued);
			}
			for (let index = 0; index < (count !== undefined ? count : 1); index += 1) {
				queued.push(message !== undefined ? message : DEFAULT_FAILURE);
			}
		},
		failAll: (kind, message) => {
			outages.set(kind, message !== undefined ? message : DEFAULT_FAILURE);
		},
		heal: (kind) => {
			if (kind !== undefined) {
				outages.delete(kind);
				pending.delete(kind);
			} else {
				outages.clear();
				pending.clear();
			}
		},
		hold: (kind) => {
			if (!held.has(kind)) {
				held.set(kind, new Array<() => void>());
			}
		},
		resume: (kind) => {
			const queue = held.get(kind);
			held.delete(kind);
			if (queue !== undefined) {
				for (const run of queue) {
					run();
				}
			}
		},
		requests: (kind) => counts.get(kind) ?? 0,
		writes: () => writes,
	};
}
