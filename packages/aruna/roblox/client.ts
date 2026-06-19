// Aruna roblox-ts native runtime — client app wiring.

import type { ActionInvoker } from "./client-runtime";
import { clearActionInvoker, setActionInvoker } from "./client-runtime";

export interface ClientApp {
	readonly dispose: () => void;
}

export interface CreateClientAppOptions {
	readonly invoker: ActionInvoker;
}

export function createClientApp(options: CreateClientAppOptions): ClientApp {
	setActionInvoker(options.invoker);

	let disposed = false;

	return {
		dispose: () => {
			if (disposed) {
				return;
			}
			disposed = true;
			clearActionInvoker();
		},
	};
}
