// Aruna roblox-ts native runtime — the renderer-agnostic core of `aruna/ui`.
//
// The adapters (ui-react.ts, ui-vide.ts) are thin; what they share is here
// (docs/rfcs/ui-bindings.md):
//
//   * `observeResource` gives every reader of a resource on a client one shared
//     subscription and an immutable view of it. When the last reader goes, the
//     subscription is kept until the current resumption cycle ends (or for
//     `keepAliveMs`), so a screen that goes away while the next one appears
//     never drops the value, and never sends an unsubscribe and a subscribe in
//     one frame.
//   * `observeAction` is the state of the calls one component makes: the latest
//     call wins, `exclusive` drops repeats while one is pending, and nothing is
//     written once the component is gone.
//
// Nothing here imports a renderer: the runtime is vendored and compiled whole,
// so a renderer import would fail to resolve in every project without it.

import { invokeOptimistic, type OptimisticUpdate } from "./optimistic";
import type {
	ActionCall,
	ActionInvokeOptions,
	ActionStubInput,
	ActionStubOutput,
	AnyActionStub,
} from "./client-runtime";
import {
	installedResourceClient,
	type ResourceBinding,
	type ResourceClient,
	type ResourceStatus,
	type ResourceSubscription,
} from "./resource";

// --- Resources -----------------------------------------------------------------

// What a reader of a resource sees. Immutable: a change replaces the whole view,
// so a renderer that compares by identity re-renders only on a change.
export interface ResourceView<TValue> {
	// The value to show: the newest snapshot, with pending optimistic updates
	// applied once there are any.
	readonly value: TValue | undefined;
	// The newest snapshot alone.
	readonly serverValue: TValue | undefined;
	readonly status: ResourceStatus;
	// The error name while `status` is "error". The last value stays.
	readonly error: string | undefined;
	// Whether `value` has optimistic updates applied.
	readonly pending: boolean;
	// The revision of the newest snapshot applied (0 before any).
	readonly revision: number;
}

export interface ObserveResourceOptions {
	// How long the shared subscription outlives its last reader, in
	// milliseconds. Without it, until the current resumption cycle ends.
	readonly keepAliveMs?: number;
}

export interface ResourceObservation<TValue> {
	readonly current: () => ResourceView<TValue>;
	// Runs `listener` after every change of `current()`. Returns a disconnect.
	readonly onChange: (listener: () => void) => () => void;
	// Ends this reader's hold on the shared subscription. Idempotent.
	readonly release: () => void;
}

interface Holder {
	readonly client: ResourceClient;
	readonly resourceId: string;
	subscription: ResourceSubscription<unknown> | undefined;
	view: ResourceView<unknown>;
	readonly listeners: Set<() => void>;
	readers: number;
	// Bumped by every hold and release, so a scheduled release that a new reader
	// overtook does nothing when it runs.
	generation: number;
}

// One holder per resource: every reader of a resource on a client shares it.
const holders = new Map<string, Holder>();

const LOADING: ResourceView<never> = {
	value: undefined,
	serverValue: undefined,
	status: "loading",
	error: undefined,
	pending: false,
	revision: 0,
};

// The shared subscription is an optimistic one: `get` is the value to show, and
// the client's own `get` is the snapshot alone.
function viewOf(holder: Holder, subscription: ResourceSubscription<unknown>): ResourceView<unknown> {
	return {
		value: subscription.get(),
		serverValue: holder.client.get(holder.resourceId),
		status: subscription.status(),
		error: subscription.error(),
		pending: subscription.pending(),
		revision: subscription.revision(),
	};
}

function sameView(a: ResourceView<unknown>, b: ResourceView<unknown>): boolean {
	return (
		a.value === b.value &&
		a.serverValue === b.serverValue &&
		a.status === b.status &&
		a.error === b.error &&
		a.pending === b.pending &&
		a.revision === b.revision
	);
}

function notify(listeners: Set<() => void>): void {
	// A copy: a listener may release itself, or another reader, while it runs. A
	// released one is skipped, so a component that is gone hears nothing more.
	const snapshot = new Array<() => void>();
	for (const listener of listeners) {
		snapshot.push(listener);
	}
	for (const listener of snapshot) {
		if (listeners.has(listener)) {
			listener();
		}
	}
}

function refresh(holder: Holder): void {
	const subscription = holder.subscription;
	if (subscription === undefined) {
		return;
	}
	const latest = viewOf(holder, subscription);
	if (sameView(holder.view, latest)) {
		return;
	}
	holder.view = latest;
	notify(holder.listeners);
}

function dropHolder(holder: Holder): void {
	if (holders.get(holder.resourceId) === holder) {
		holders.delete(holder.resourceId);
	}
	holder.generation += 1;
	holder.listeners.clear();
	if (holder.subscription !== undefined) {
		holder.subscription.disconnect();
	}
}

function holderFor(resourceId: string): Holder {
	const client = installedResourceClient(resourceId);
	const existing = holders.get(resourceId);
	if (existing !== undefined && existing.client === client) {
		return existing;
	}
	if (existing !== undefined) {
		// Held through a client app that has since been replaced (a spec, a
		// restarted client): that subscription hears nothing more.
		dropHolder(existing);
	}
	const holder: Holder = {
		client,
		resourceId,
		subscription: undefined,
		view: LOADING,
		listeners: new Set(),
		readers: 0,
		generation: 0,
	};
	holders.set(resourceId, holder);
	// The listener can run inside `subscribe`, when the resource already has a
	// value from another subscriber, before the subscription is assigned; the
	// view is read from the subscription once it is.
	const subscription = client.subscribe(resourceId, () => refresh(holder), {
		onError: () => refresh(holder),
		optimistic: true,
	});
	holder.subscription = subscription;
	holder.view = viewOf(holder, subscription);
	return holder;
}

function releaseHold(holder: Holder, keepAliveMs: number | undefined): void {
	holder.readers -= 1;
	if (holder.readers > 0) {
		return;
	}
	holder.generation += 1;
	const generation = holder.generation;
	const drop = () => {
		if (holder.generation === generation && holder.readers === 0) {
			dropHolder(holder);
		}
	};
	if (keepAliveMs !== undefined && keepAliveMs > 0) {
		task.delay(keepAliveMs / 1000, drop);
	} else {
		task.defer(drop);
	}
}

// Holds the shared subscription to `binding`'s resource until `release`.
// Needs the installed client, as the generated bindings do.
export function observeResource<TValue>(
	binding: ResourceBinding<TValue>,
	options?: ObserveResourceOptions,
): ResourceObservation<TValue> {
	const holder = holderFor(binding.id);
	holder.readers += 1;
	holder.generation += 1;
	const keepAliveMs = options !== undefined ? options.keepAliveMs : undefined;
	const own = new Set<() => void>();
	let released = false;
	return {
		current: () => holder.view as ResourceView<TValue>,
		onChange: (listener) => {
			if (released) {
				return () => {};
			}
			// Wrapped, so the same function registered twice stays two listeners.
			const entry = () => listener();
			own.add(entry);
			holder.listeners.add(entry);
			return () => {
				own.delete(entry);
				holder.listeners.delete(entry);
			};
		},
		release: () => {
			if (released) {
				return;
			}
			released = true;
			for (const entry of own) {
				holder.listeners.delete(entry);
			}
			own.clear();
			releaseHold(holder, keepAliveMs);
		},
	};
}

// The view a reader would start from, holding nothing: the shared view while
// one is held, otherwise whatever the client already has. For a renderer that
// must not subscribe while it renders.
export function peekResource<TValue>(binding: ResourceBinding<TValue>): ResourceView<TValue> {
	const client = installedResourceClient(binding.id);
	const holder = holders.get(binding.id);
	if (holder !== undefined && holder.client === client) {
		return holder.view as ResourceView<TValue>;
	}
	const value = client.get(binding.id) as TValue | undefined;
	if (value === undefined) {
		return LOADING;
	}
	return {
		value,
		serverValue: value,
		status: "ready",
		error: undefined,
		pending: false,
		revision: 0,
	};
}

// --- Actions -------------------------------------------------------------------

export type ActionStatus = "idle" | "pending" | "success" | "error";

export interface ActionSnapshot<TOutput> {
	// Of the latest call.
	readonly status: ActionStatus;
	// The latest call's output, while `status` is "success".
	readonly data: TOutput | undefined;
	// The latest call's rejection, while `status` is "error". Narrow it with
	// `isActionError(error, stub, name)`.
	readonly error: unknown;
}

export interface ActionStateOptions<TStub extends AnyActionStub> {
	// Ignore `invoke` while a call is pending (`invokeAsync` returns the pending
	// call's promise), so a second click does not buy twice.
	readonly exclusive?: boolean;
	// Run for every call that settles while the state is alive, not only the
	// latest one.
	readonly onSuccess?: (data: ActionStubOutput<TStub>, input: ActionStubInput<TStub>) => void;
	readonly onError?: (reason: unknown, input: ActionStubInput<TStub>) => void;
	// Updates to show until the server's snapshots contain the call
	// (`invokeOptimistic`): `update(resource, (current) => next)`.
	readonly optimistic?: (input: ActionStubInput<TStub>, update: OptimisticUpdate) => void;
}

export interface ActionObservation<TStub extends AnyActionStub> {
	readonly current: () => ActionSnapshot<ActionStubOutput<TStub>>;
	// Runs `listener` after every change of `current()`. Returns a disconnect.
	readonly onChange: (listener: () => void) => () => void;
	// Starts a call. A rejection goes to `error` and `onError`, never to an
	// unhandled promise.
	readonly invoke: ActionCall<TStub, void>;
	// Starts a call and returns its promise, which rejects.
	readonly invokeAsync: ActionCall<TStub, Promise<ActionStubOutput<TStub>>>;
	// Back to "idle"; a call still running no longer writes the state.
	readonly reset: () => void;
	// Replaces the options; the React adapter hands over each render's.
	readonly setOptions: (options: ActionStateOptions<TStub> | undefined) => void;
	// After this, a call that settles writes nothing and runs no callback. It is
	// not cancelled: that would stop the client waiting, not the server running,
	// and would hide a purchase that happened.
	readonly dispose: () => void;
}

const IDLE: ActionSnapshot<never> = { status: "idle", data: undefined, error: undefined };
const PENDING: ActionSnapshot<never> = { status: "pending", data: undefined, error: undefined };

export function observeAction<TStub extends AnyActionStub>(
	stub: TStub,
	options?: ActionStateOptions<TStub>,
): ActionObservation<TStub> {
	type Output = ActionStubOutput<TStub>;
	type Input = ActionStubInput<TStub>;
	const call = stub as unknown as (input: unknown, invokeOptions?: ActionInvokeOptions) => Promise<Output>;
	let current: ActionSnapshot<Output> = IDLE;
	let settings = options;
	// The id of the latest call; a call that is not the latest writes nothing.
	let latest = 0;
	let pending: Promise<Output> | undefined;
	let disposed = false;
	const listeners = new Set<() => void>();

	const write = (snapshot: ActionSnapshot<Output>) => {
		current = snapshot;
		notify(listeners);
	};

	const start = (input: unknown, invokeOptions: ActionInvokeOptions | undefined): Promise<Output> => {
		if (pending !== undefined && settings !== undefined && settings.exclusive === true) {
			return pending;
		}
		latest += 1;
		const id = latest;
		write(PENDING);
		const optimistic = settings !== undefined ? settings.optimistic : undefined;
		// A stub that throws instead of rejecting is still a rejection here.
		const [called, result] = pcall(() =>
			optimistic !== undefined
				? invokeOptimistic(stub, input as Input, (update) => optimistic(input as Input, update), invokeOptions)
				: call(input, invokeOptions),
		);
		const promise = called ? result : (Promise.reject(result) as Promise<Output>);
		pending = promise;
		promise.then(
			(data) => {
				if (pending === promise) {
					pending = undefined;
				}
				if (disposed) {
					return;
				}
				if (id === latest) {
					write({ status: "success", data, error: undefined });
				}
				const onSuccess = settings !== undefined ? settings.onSuccess : undefined;
				if (onSuccess !== undefined) {
					onSuccess(data, input as Input);
				}
			},
			(reason) => {
				if (pending === promise) {
					pending = undefined;
				}
				if (disposed) {
					return;
				}
				if (id === latest) {
					write({ status: "error", data: undefined, error: reason });
				}
				const onError = settings !== undefined ? settings.onError : undefined;
				if (onError !== undefined) {
					onError(reason, input as Input);
				}
			},
		);
		return promise;
	};

	const invoke = (input?: unknown, invokeOptions?: ActionInvokeOptions): void => {
		if (disposed) {
			return;
		}
		start(input, invokeOptions);
	};

	const invokeAsync = (input?: unknown, invokeOptions?: ActionInvokeOptions): Promise<Output> => {
		if (disposed) {
			return Promise.reject("Aruna action state is disposed.") as Promise<Output>;
		}
		return start(input, invokeOptions);
	};

	return {
		current: () => current,
		onChange: (listener) => {
			if (disposed) {
				return () => {};
			}
			const entry = () => listener();
			listeners.add(entry);
			return () => {
				listeners.delete(entry);
			};
		},
		invoke: invoke as ActionCall<TStub, void>,
		invokeAsync: invokeAsync as ActionCall<TStub, Promise<Output>>,
		reset: () => {
			latest += 1;
			pending = undefined;
			if (!disposed) {
				write(IDLE);
			}
		},
		setOptions: (replacement) => {
			settings = replacement;
		},
		dispose: () => {
			disposed = true;
			listeners.clear();
		},
	};
}
