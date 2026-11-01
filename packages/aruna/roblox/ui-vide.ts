// Aruna roblox-ts native runtime — Vide bindings for `aruna/ui`.
//
// Vide is handed in, never imported, for the same reason as React:
//
//   import { batch, cleanup, source } from "@rbxts/vide";
//   export const { resourceState, actionState } = createVideBindings({ source, cleanup, batch });
//
// A Vide component runs once, so every field is an accessor. Each is its own
// source: a dependent re-runs only when a field it reads changes, and fields
// that change together are written in one `batch`. Both functions register
// their release with `cleanup`, so they need a stable scope (a component, a
// `Show` or `Switch` branch, a `root`); outside one, Vide's `cleanup` throws
// before anything is held.

import type { ActionCall, ActionStubOutput, AnyActionStub } from "./client-runtime";
import type { ResourceBinding, ResourceStatus } from "./resource";
import {
	observeAction,
	observeResource,
	type ActionObservation,
	type ActionStateOptions,
	type ActionStatus,
	type ObserveResourceOptions,
	type ResourceObservation,
} from "./ui-core";

// The Vide functions the bindings call, typed structurally: `@rbxts/vide`
// satisfies it.
export interface VideFunctions {
	readonly source: <T>(initialValue: T) => (value?: T) => T;
	readonly cleanup: (callback: () => void) => void;
	readonly batch: (setter: () => void) => void;
}

export interface VideBindingsOptions {
	// How long a resource's shared subscription outlives its last reader, in
	// milliseconds. Without it, until the current resumption cycle ends.
	readonly keepAliveMs?: number;
}

// A resource's view, one accessor per field.
export interface ResourceSources<TValue> {
	readonly value: () => TValue | undefined;
	readonly serverValue: () => TValue | undefined;
	readonly status: () => ResourceStatus;
	readonly error: () => string | undefined;
	readonly pending: () => boolean;
	readonly revision: () => number;
}

// A call's state, one accessor per field; the methods are plain functions.
export interface ActionSources<TStub extends AnyActionStub> {
	readonly status: () => ActionStatus;
	readonly data: () => ActionStubOutput<TStub> | undefined;
	readonly error: () => unknown;
	readonly invoke: ActionCall<TStub, void>;
	readonly invokeAsync: ActionCall<TStub, Promise<ActionStubOutput<TStub>>>;
	readonly reset: () => void;
}

export interface VideBindings {
	readonly resourceState: <TValue>(binding: ResourceBinding<TValue>) => ResourceSources<TValue>;
	// Call `invoke` from event handlers, not from `effect` or `derive`: Vide
	// re-runs those whenever what they read changes, and its strict mode runs
	// every update twice, so a call made there can go out more than once.
	readonly actionState: <TStub extends AnyActionStub>(
		stub: TStub,
		options?: ActionStateOptions<TStub>,
	) => ActionSources<TStub>;
}

export function createVideBindings(vide: VideFunctions, options?: VideBindingsOptions): VideBindings {
	const observeOptions: ObserveResourceOptions | undefined =
		options !== undefined && options.keepAliveMs !== undefined ? { keepAliveMs: options.keepAliveMs } : undefined;

	const resourceState = <TValue>(binding: ResourceBinding<TValue>): ResourceSources<TValue> => {
		let observation: ResourceObservation<TValue> | undefined;
		let disconnect: (() => void) | undefined;
		vide.cleanup(() => {
			if (disconnect !== undefined) {
				disconnect();
			}
			if (observation !== undefined) {
				observation.release();
			}
		});
		const held = observeResource(binding, observeOptions);
		observation = held;
		let shown = held.current();
		const value = vide.source(shown.value);
		const serverValue = vide.source(shown.serverValue);
		const status = vide.source(shown.status);
		const errorName = vide.source(shown.error);
		const pending = vide.source(shown.pending);
		const revision = vide.source(shown.revision);
		disconnect = held.onChange(() => {
			const previous = shown;
			const latest = held.current();
			shown = latest;
			// Vide skips an unchanged primitive but treats a mutable table as
			// changed even when the same one is written back, so only what changed
			// is written: a status change never re-runs what reads `value`.
			vide.batch(() => {
				if (latest.value !== previous.value) {
					value(latest.value);
				}
				if (latest.serverValue !== previous.serverValue) {
					serverValue(latest.serverValue);
				}
				if (latest.status !== previous.status) {
					status(latest.status);
				}
				if (latest.error !== previous.error) {
					errorName(latest.error);
				}
				if (latest.pending !== previous.pending) {
					pending(latest.pending);
				}
				if (latest.revision !== previous.revision) {
					revision(latest.revision);
				}
			});
		});
		return { value, serverValue, status, error: errorName, pending, revision };
	};

	const actionState = <TStub extends AnyActionStub>(
		stub: TStub,
		actionOptions?: ActionStateOptions<TStub>,
	): ActionSources<TStub> => {
		let observation: ActionObservation<TStub> | undefined;
		let disconnect: (() => void) | undefined;
		vide.cleanup(() => {
			if (disconnect !== undefined) {
				disconnect();
			}
			if (observation !== undefined) {
				observation.dispose();
			}
		});
		const held = observeAction(stub, actionOptions);
		observation = held;
		let shown = held.current();
		const status = vide.source(shown.status);
		const data = vide.source(shown.data);
		const rejection = vide.source(shown.error);
		disconnect = held.onChange(() => {
			const previous = shown;
			const latest = held.current();
			shown = latest;
			vide.batch(() => {
				if (latest.status !== previous.status) {
					status(latest.status);
				}
				if (latest.data !== previous.data) {
					data(latest.data);
				}
				if (latest.error !== previous.error) {
					rejection(latest.error);
				}
			});
		});
		return {
			status,
			data,
			error: rejection,
			invoke: held.invoke,
			invokeAsync: held.invokeAsync,
			reset: held.reset,
		};
	};

	return { resourceState, actionState };
}
