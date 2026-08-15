// Aruna roblox-ts native runtime — the DataStoreService backend.
//
// The store core is backend-agnostic; this is the adapter that talks to the
// real service. It does three things and nothing else:
//
//   * Wraps the yielding DataStore calls in promises, so the core's retry and
//     budget policy can drive them without blocking a game thread.
//   * Reports the request budget, so the core can wait instead of spending a
//     request the service would throttle.
//   * Detects Studio without API access at creation time and falls back to an
//     in-memory backend, so a Studio playtest exercises the same code path
//     instead of erroring on every save.
//
// Errors are deliberately re-thrown as-is: classification belongs to the core.

import {
	createMemoryStoreBackend,
	type StoreBackend,
	type StoreBackendRequestKind,
	type StoreBackendTarget,
	type StoreBackendTransform,
} from "./store";

function dataStoreService(): DataStoreService {
	return game.GetService("DataStoreService");
}

function runService(): RunService {
	return game.GetService("RunService");
}

// Runs a yielding DataStore call on its own thread and settles a promise with
// the result. `pcall` keeps the failure on the promise instead of taking the
// spawned thread down with it.
function request<TValue>(call: () => TValue): Promise<TValue> {
	return new Promise<TValue>((resolve, reject) => {
		task.spawn(() => {
			const [ok, result] = pcall(call);
			if (ok) {
				resolve(result as TValue);
			} else {
				reject(result);
			}
		});
	});
}

// Resolved per call rather than in a module-level table: reading `Enum` at load
// time would make importing this module fail anywhere the enum is absent (the
// Lune spec environment, for one), and the lookup is trivial.
function budgetTypeFor(kind: StoreBackendRequestKind): Enum.DataStoreRequestType {
	if (kind === "get") {
		return Enum.DataStoreRequestType.GetAsync;
	}
	if (kind === "update") {
		return Enum.DataStoreRequestType.UpdateAsync;
	}
	// SetAsync and RemoveAsync share the set/increment budget.
	return Enum.DataStoreRequestType.SetIncrementAsync;
}

export interface RobloxDataStoreBackendOptions {
	// When Studio has no API access, fall back to an in-memory backend instead of
	// failing every request. Defaults to true: a playtest that cannot persist
	// should still run the same load/save code path. Set false to make the
	// missing access loud.
	readonly studioFallback?: boolean;
	// Called once when the fallback engages, so the choice is visible rather than
	// silent. Defaults to a `warn`.
	readonly onFallback?: (reason: string) => void;
}

// True when this place cannot reach the DataStore API. Probed with one real
// request against a sentinel key: with API access off the call errors
// immediately (it never reaches the network), so this costs nothing in a live
// server, where it is not run at all.
function studioApiAccessMissing(target: StoreBackendTarget): boolean {
	if (!runService().IsStudio()) {
		return false;
	}
	const [ok] = pcall(() =>
		dataStoreService().GetDataStore(target.id, target.scope).GetAsync("__aruna_api_probe"),
	);
	return !ok;
}

// Builds the backend for one store. Pass it as `createBackend`:
//
//   createPlayerStore(profile, { createBackend: robloxDataStoreBackend })
export function robloxDataStoreBackend(
	target: StoreBackendTarget,
	options?: RobloxDataStoreBackendOptions,
): StoreBackend {
	const studioFallback = options === undefined || options.studioFallback !== false;

	if (studioFallback && studioApiAccessMissing(target)) {
		const reason = `Aruna store "${target.id}" is running on an in-memory backend: Studio access to API services is off, so nothing will persist.`;
		if (options !== undefined && options.onFallback !== undefined) {
			options.onFallback(reason);
		} else {
			warn(reason);
		}
		return createMemoryStoreBackend();
	}

	const store = dataStoreService().GetDataStore(target.id, target.scope);

	return {
		get: (key) =>
			request(() => {
				const [value] = store.GetAsync<unknown>(key);
				return value;
			}),
		set: (key, value, userIds) =>
			request(() => {
				store.SetAsync(key, value, userIds);
			}),
		update: (key, transform: StoreBackendTransform, userIds) =>
			request(() => {
				const [updated] = store.UpdateAsync<unknown, unknown>(key, (current) => {
					// A nil newValue cancels the write — exactly the contract the core
					// relies on to abort a write whose transform failed. The user ids
					// ride along so a GDPR erasure request can find the record.
					const nextValue = transform(current);
					// `$tuple` is a compiler macro and only valid as the whole return
					// expression, so the two shapes are two return statements. The
					// user-ids slot is omitted entirely when there are none: an explicit
					// nil is a different tuple.
					if (userIds !== undefined) {
						return $tuple(nextValue, userIds);
					}
					return $tuple(nextValue);
				});
				return updated;
			}),
		remove: (key) =>
			request(() => {
				store.RemoveAsync(key);
			}),
		getBudget: (kind) => dataStoreService().GetRequestBudgetForRequestType(budgetTypeFor(kind)),
	};
}

// A `createBackend` factory with the options baked in, for
// `createStore(definition, { createBackend: robloxDataStore({ studioFallback: false }) })`.
export function robloxDataStore(
	options?: RobloxDataStoreBackendOptions,
): (target: StoreBackendTarget) => StoreBackend {
	return (target) => robloxDataStoreBackend(target, options);
}
