// Aruna roblox-ts native runtime — client app wiring.

import type { ActionInvokeOptions, ActionInvoker } from "./client-runtime";
import { clearActionInvoker, setActionInvoker } from "./client-runtime";
import { createActionInvoker } from "./roblox";

// The client counterpart of a server transport: the wire connection actions are
// invoked through.
export type ClientTransport = ActionInvoker;

export interface ClientApp {
	// Invokes an action through this app's transport directly, without going
	// through the module-global `invokeAction`. Prefer this (or pass the app
	// handle to controllers) when call ordering is hard to guarantee.
	readonly invoke: (
		actionId: string,
		input: unknown,
		options?: ActionInvokeOptions,
	) => Promise<unknown>;
	readonly dispose: () => void;
}

export interface CreateClientAppOptions {
	// The wire connection used to invoke actions — the client counterpart of
	// `createServerApp({ transport })`. When omitted, the app builds the default
	// Roblox invoker (`createActionInvoker()`), which waits for the action remote
	// the server transport creates.
	readonly transport?: ClientTransport;
}

export function createClientApp(options?: CreateClientAppOptions): ClientApp {
	const transport =
		options !== undefined && options.transport !== undefined
			? options.transport
			: createActionInvoker();

	setActionInvoker(transport);

	let disposed = false;

	return {
		invoke: (actionId, input, invokeOptions) => {
			if (disposed) {
				return Promise.reject(`Aruna client app is disposed; cannot invoke "${actionId}".`);
			}

			return transport(actionId, input, invokeOptions);
		},
		dispose: () => {
			if (disposed) {
				return;
			}
			disposed = true;
			clearActionInvoker();
		},
	};
}

// Re-exported so `aruna/client` is the single client entry.
export * from "./client-runtime";
