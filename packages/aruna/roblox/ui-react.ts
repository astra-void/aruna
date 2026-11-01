// Aruna roblox-ts native runtime — React bindings for `aruna/ui`.
//
// The renderer is handed in, never imported:
//
//   import React from "@rbxts/react";
//   export const { useResource, useAction } = createReactBindings(React);
//
// The runtime is vendored and compiled whole, so an `@rbxts/react` import here
// would fail to resolve in every project without React.

import type { ActionCall, ActionStubOutput, AnyActionStub } from "./client-runtime";
import type { ResourceBinding } from "./resource";
import {
	observeAction,
	observeResource,
	peekResource,
	type ActionStateOptions,
	type ActionStatus,
	type ObserveResourceOptions,
	type ResourceView,
} from "./ui-core";

// The hooks the bindings call, typed structurally: `@rbxts/react` satisfies it.
export interface ReactHooks {
	readonly useState: <S>(initialState: S | (() => S)) => LuaTuple<[S, (value: S) => void]>;
	readonly useEffect: (effect: () => (() => void) | void, deps?: ReadonlyArray<unknown>) => void;
	readonly useMemo: <T>(factory: () => T, deps: ReadonlyArray<unknown> | undefined) => T;
}

export interface ReactBindingsOptions {
	// How long a resource's shared subscription outlives its last reader, in
	// milliseconds. Without it, until the current resumption cycle ends.
	readonly keepAliveMs?: number;
}

// A call's state as one component sees it.
export interface ActionState<TStub extends AnyActionStub> {
	readonly status: ActionStatus;
	readonly data: ActionStubOutput<TStub> | undefined;
	readonly error: unknown;
	readonly invoke: ActionCall<TStub, void>;
	readonly invokeAsync: ActionCall<TStub, Promise<ActionStubOutput<TStub>>>;
	readonly reset: () => void;
}

export interface ReactBindings {
	// The resource's current view; re-renders when it is replaced.
	readonly useResource: <TValue>(binding: ResourceBinding<TValue>) => ResourceView<TValue>;
	readonly useAction: <TStub extends AnyActionStub>(
		stub: TStub,
		options?: ActionStateOptions<TStub>,
	) => ActionState<TStub>;
}

export function createReactBindings(react: ReactHooks, options?: ReactBindingsOptions): ReactBindings {
	const observeOptions: ObserveResourceOptions | undefined =
		options !== undefined && options.keepAliveMs !== undefined ? { keepAliveMs: options.keepAliveMs } : undefined;

	const useResource = <TValue>(binding: ResourceBinding<TValue>): ResourceView<TValue> => {
		// Rendering holds nothing: the subscription is taken in the effect.
		const [view, setView] = react.useState<ResourceView<TValue>>(() => peekResource(binding));
		react.useEffect(() => {
			const observation = observeResource(binding, observeOptions);
			const sync = () => setView(observation.current());
			const disconnect = observation.onChange(sync);
			// The view may have changed between the render and this effect. Views
			// are immutable, so an unchanged one renders nothing.
			sync();
			return () => {
				disconnect();
				observation.release();
			};
		}, [binding]);
		return view;
	};

	const useAction = <TStub extends AnyActionStub>(
		stub: TStub,
		actionOptions?: ActionStateOptions<TStub>,
	): ActionState<TStub> => {
		const observation = react.useMemo(() => observeAction(stub, actionOptions), [stub]);
		// Every render's callbacks, so `onSuccess` sees the current props.
		observation.setOptions(actionOptions);
		const [snapshot, setSnapshot] = react.useState(() => observation.current());
		react.useEffect(() => {
			const sync = () => setSnapshot(observation.current());
			const disconnect = observation.onChange(sync);
			sync();
			return () => {
				disconnect();
				observation.dispose();
			};
		}, [observation]);
		return {
			status: snapshot.status,
			data: snapshot.data,
			error: snapshot.error,
			invoke: observation.invoke,
			invokeAsync: observation.invokeAsync,
			reset: observation.reset,
		};
	};

	return { useResource, useAction };
}
