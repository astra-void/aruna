// Aruna roblox-ts native runtime — optimistic calls (docs/rfcs/ui-bindings.md).
//
// An optimistic update is display-only: the resource client applies it over the
// newest snapshot until the snapshot that contains its call arrives, and never
// sends it. The call carries an idempotency key and `optimistic`; the server tags
// its invalidations with the key, and the first item of each tagged resource
// says so (`k`), so the update leaves in the very step that applies it. Nothing
// is ever written to a snapshot, so rollback is removal.

import type { ActionInvokeOptions, ActionStubInput, ActionStubOutput, AnyActionStub } from "./client-runtime";
import { createIdempotencyKey } from "./idempotency";
import {
	beginOptimisticCall,
	currentResourceClient,
	DEFAULT_OPTIMISTIC_SETTLE_TIMEOUT_MS,
	type ResourceBinding,
} from "./resource";

// Registers an update of one resource for the call being made. It is re-run
// against every snapshot until the one that contains the call arrives, so it
// must be pure, and must not change `current`.
export type OptimisticUpdate = <TValue>(resource: ResourceBinding<TValue>, updater: (current: TValue) => TValue) => void;

export interface InvokeOptimisticOptions extends ActionInvokeOptions {
	// How long an update outlives the call's response while the snapshot that
	// contains the call is still on its way. Defaults to 10 seconds.
	readonly settleTimeoutMs?: number;
}

// Calls `stub` with `input`, showing `apply`'s updates until the server's
// snapshots contain the call. Updates of a resource the client is not
// subscribed to are ignored. A key passed in `options` is the call's; two
// calls with one key are one call, and its updates are applied once.
export function invokeOptimistic<TStub extends AnyActionStub>(
	stub: TStub,
	input: ActionStubInput<TStub>,
	apply: (update: OptimisticUpdate) => void,
	options?: InvokeOptimisticOptions,
): Promise<ActionStubOutput<TStub>> {
	const client = currentResourceClient();
	if (client === undefined) {
		throw "Aruna resource client is not installed: optimistic updates need createClientApp({ resources: true }).";
	}
	const key =
		options !== undefined && options.idempotencyKey !== undefined ? options.idempotencyKey : createIdempotencyKey();
	const call = beginOptimisticCall(
		client,
		key,
		options !== undefined && options.settleTimeoutMs !== undefined
			? options.settleTimeoutMs
			: DEFAULT_OPTIMISTIC_SETTLE_TIMEOUT_MS,
	);
	const [applied, failure] = pcall(() =>
		apply((resource, updater) => call.update(resource.id, updater as (current: unknown) => unknown)),
	);
	if (!applied) {
		// A broken `apply` sends nothing and leaves no update behind.
		call.failed();
		return Promise.reject(failure) as Promise<ActionStubOutput<TStub>>;
	}
	const send = stub as unknown as (
		input: unknown,
		invokeOptions: ActionInvokeOptions,
	) => Promise<ActionStubOutput<TStub>>;
	const [called, result] = pcall(() => send(input, { ...options, idempotencyKey: key, optimistic: true }));
	const promise = called ? result : (Promise.reject(result) as Promise<ActionStubOutput<TStub>>);
	promise.then(
		() => call.succeeded(),
		() => call.failed(),
	);
	return promise;
}
