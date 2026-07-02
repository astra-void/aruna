// Aruna roblox-ts native runtime — server app wiring.

import {
	createActionRegistry,
	type ActionMap,
	type ActionRegistry,
	type ActionRegistryOptions,
} from "./server-runtime";
import type { ActionRateLimitOptions } from "./server";
import type { SignalMap, SignalPublisher } from "./signal-runtime";

export interface ServerAppBinding {
	readonly disconnect: () => void;
}

// A server transport binds the dispatch-ready registry to a concrete remote and
// returns a disposable binding. Pass one to `createServerApp({ transport })` so
// the app owns the wiring. Mirrors the Node reference runtime's ServerTransport.
export type ServerTransport<TPlayer> = (registry: ActionRegistry<TPlayer>) => ServerAppBinding;

// Builds a server-side signal publisher from a signal registry, ensuring the
// signal remote exists at call time. `createSignalPublisher` from `aruna/roblox`
// is the canonical implementation. Mirrors the Node reference runtime's
// ServerSignalPublisherFactory.
export type ServerSignalPublisherFactory<TPlayer, TSignals extends SignalMap> = (
	signals: TSignals,
) => SignalPublisher<TSignals, TPlayer>;

export interface ServerApp<TPlayer, TSignals extends SignalMap = SignalMap> {
	// Present when a `transport` was supplied to `createServerApp`.
	readonly binding?: ServerAppBinding;
	// Present when both `signals` and `createPublisher` were supplied. Built
	// eagerly so the signal remote exists at boot.
	readonly publisher?: SignalPublisher<TSignals, TPlayer>;
	// Disposes the owned transport binding (no-op when no `transport` was given).
	readonly dispose: () => void;
}

export interface CreateServerAppOptions<TPlayer, TSignals extends SignalMap = SignalMap> {
	readonly actions: ActionMap<TPlayer>;
	// Binds the registry to a concrete remote and is owned by the app. When given,
	// the app binds the transport eagerly at creation.
	readonly transport?: ServerTransport<TPlayer>;
	// The generated signal registry (`$aruna/signals`). When paired with
	// `createPublisher`, the app builds the publisher at boot so the signal remote
	// is replicated before any client subscribes.
	readonly signals?: TSignals;
	// Builds the publisher from `signals`. Pass `createSignalPublisher` from
	// `aruna/roblox`. Owned by the app: runs once at creation.
	readonly createPublisher?: ServerSignalPublisherFactory<TPlayer, TSignals>;
	// Fallback rate limit for actions that do not declare their own `rateLimit`.
	// Aruna emits the configured `actions.defaultRateLimit` into the generated
	// server module; pass it here to enforce it at runtime.
	readonly defaultRateLimit?: ActionRateLimitOptions;
}

export function createServerApp<TPlayer = unknown, TSignals extends SignalMap = SignalMap>(
	options: CreateServerAppOptions<TPlayer, TSignals>,
): ServerApp<TPlayer, TSignals> {
	// Build the publisher first so it can be injected into every action ctx via
	// the registry (and so the signal remote exists at boot).
	const publisher =
		options.signals !== undefined && options.createPublisher !== undefined
			? options.createPublisher(options.signals)
			: undefined;

	const registryOptions: ActionRegistryOptions<TPlayer> = {
		...(options.defaultRateLimit !== undefined
			? { defaultRateLimit: options.defaultRateLimit }
			: {}),
		// Carried registry-erased; the precise typing lives on the action ctx via
		// `createActionDefiner`. Dispatch only forwards it to `ctx.publisher`.
		...(publisher !== undefined
			? { publisher: publisher as unknown as SignalPublisher<SignalMap, unknown> }
			: {}),
	};
	const registry = createActionRegistry<TPlayer>(options.actions, registryOptions);

	const binding = options.transport !== undefined ? options.transport(registry) : undefined;

	return {
		...(binding !== undefined ? { binding } : {}),
		...(publisher !== undefined ? { publisher } : {}),
		dispose: () => {
			if (binding !== undefined) {
				binding.disconnect();
			}
		},
	};
}
