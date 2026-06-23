// Aruna roblox-ts native runtime — server app wiring.

import { createActionRegistry, type ActionMap, type ActionRegistry } from "./server-runtime";
import type { ActionRateLimitOptions } from "./server";

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
	// Fallback rate limit for actions that do not declare their own `rateLimit`.
	// Aruna emits the configured `actions.defaultRateLimit` into the generated
	// server module; pass it here to enforce it at runtime.
	readonly defaultRateLimit?: ActionRateLimitOptions;
}

export function createServerApp<TPlayer = unknown>(
	options: CreateServerAppOptions<TPlayer>,
): ServerApp<TPlayer> {
	const registry = createActionRegistry<TPlayer>(
		options.actions,
		options.defaultRateLimit !== undefined
			? { defaultRateLimit: options.defaultRateLimit }
			: undefined,
	);

	return {
		bind: (binder) => binder(registry),
	};
}
