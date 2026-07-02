// Aruna roblox-ts native runtime — client app wiring.

import type { ActionInvokeOptions, ActionInvoker } from "./client-runtime";
import { clearActionInvoker, setActionInvoker } from "./client-runtime";
import { createActionInvoker } from "./roblox";
import type { SignalMap, SignalSubscriber } from "./signal-runtime";

// The client counterpart of a server transport: the wire connection actions are
// invoked through.
export type ClientTransport = ActionInvoker;

// Builds a client-side signal subscriber from a signal registry. Pass
// `createSignalSubscriber` from `aruna/roblox`; the app owns the result — the
// client mirror of `createServerApp({ signals, createPublisher })`.
export type ClientSignalSubscriberFactory<TSignals extends SignalMap = SignalMap> = (
	signals: TSignals,
) => SignalSubscriber<TSignals>;

export interface ClientApp<TSignals extends SignalMap = SignalMap> {
	// Invokes an action through this app's transport directly, without going
	// through the module-global `invokeAction`. Prefer this (or pass the app
	// handle to controllers) when call ordering is hard to guarantee.
	readonly invoke: (
		actionId: string,
		input: unknown,
		options?: ActionInvokeOptions,
	) => Promise<unknown>;
	// Present when both `signals` and `createSubscriber` were supplied. Built
	// eagerly so handlers can be registered at boot.
	readonly subscriber?: SignalSubscriber<TSignals>;
	readonly dispose: () => void;
}

export interface CreateClientAppOptions<TSignals extends SignalMap = SignalMap> {
	// The wire connection used to invoke actions — the client counterpart of
	// `createServerApp({ transport })`. When omitted, the app builds the default
	// Roblox invoker (`createActionInvoker()`), which waits for the action remote
	// the server transport creates.
	readonly transport?: ClientTransport;
	// The generated signal registry (`$aruna/signals`). When paired with
	// `createSubscriber`, the app builds the subscriber at boot.
	readonly signals?: TSignals;
	// Builds the subscriber from `signals`. Pass `createSignalSubscriber` from
	// `aruna/roblox`. Owned by the app: built once at creation, disposed with it.
	readonly createSubscriber?: ClientSignalSubscriberFactory<TSignals>;
}

export function createClientApp<TSignals extends SignalMap = SignalMap>(
	options?: CreateClientAppOptions<TSignals>,
): ClientApp<TSignals> {
	const transport =
		options !== undefined && options.transport !== undefined
			? options.transport
			: createActionInvoker();

	setActionInvoker(transport);

	let subscriber: SignalSubscriber<TSignals> | undefined;
	if (
		options !== undefined &&
		options.signals !== undefined &&
		options.createSubscriber !== undefined
	) {
		subscriber = options.createSubscriber(options.signals);
	}

	let disposed = false;

	return {
		invoke: (actionId, input, invokeOptions) => {
			if (disposed) {
				return Promise.reject(`Aruna client app is disposed; cannot invoke "${actionId}".`);
			}

			return transport(actionId, input, invokeOptions);
		},
		...(subscriber !== undefined ? { subscriber } : {}),
		dispose: () => {
			if (disposed) {
				return;
			}
			disposed = true;
			clearActionInvoker();
			if (subscriber !== undefined) {
				subscriber.dispose();
			}
		},
	};
}

// Re-exported so `aruna/client` is the single client entry.
export * from "./client-runtime";
