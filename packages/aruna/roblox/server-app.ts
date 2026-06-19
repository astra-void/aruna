// Aruna roblox-ts native runtime — server app wiring.

import { createActionRegistry, type ActionMap, type ActionRegistry } from "./server-runtime";

export interface ServerAppBinding {
	readonly disconnect: () => void;
}

export interface ServerApp<TPlayer> {
	readonly bind: (
		binder: (registry: ActionRegistry<TPlayer>) => ServerAppBinding,
	) => ServerAppBinding;
}

export interface CreateServerAppOptions<TPlayer> {
	readonly actions: ActionMap<TPlayer>;
}

export function createServerApp<TPlayer = unknown>(
	options: CreateServerAppOptions<TPlayer>,
): ServerApp<TPlayer> {
	const registry = createActionRegistry<TPlayer>(options.actions);

	return {
		bind: (binder) => binder(registry),
	};
}
