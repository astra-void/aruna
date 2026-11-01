// Aruna roblox-ts native runtime — client app wiring.

import type {
	ActionInvokeOptions,
	ActionInvoker,
	ClientMiddleware,
	ClientRetryPolicy,
	ContractHandshakeOptions,
} from "./client-runtime";
import {
	clearActionInvoker,
	setActionInvoker,
	withClientMiddleware,
	withRetry,
} from "./client-runtime";
import { createActionInvoker, createResourceClient, type CreateActionInvokerOptions } from "./roblox";
import { clearResourceClient, setResourceClient, type ResourceClient } from "./resource";
import type { SignalMap, SignalSubscriber } from "./signal-runtime";

// The subscriber surface, so a client module can type one it is handed without
// reaching into the runtime's internals.
export type {
	RemoteSignalConnection,
	SignalHandler,
	SignalMap,
	SignalSubscriber,
	SignalSubscriberOptions,
} from "./signal-runtime";
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
		input?: unknown,
		options?: ActionInvokeOptions,
	) => Promise<unknown>;
	// Present when both `signals` and `createSubscriber` were supplied. Built
	// eagerly so handlers can be registered at boot.
	readonly subscriber?: SignalSubscriber<TSignals>;
	// Present when `resources` was supplied. Also installed process-wide, so the
	// generated `$aruna/resources/client` bindings subscribe through it.
	readonly resources?: ResourceClient;
	readonly dispose: () => void;
}

export interface CreateClientAppOptions<TSignals extends SignalMap = SignalMap>
	extends ContractHandshakeOptions {
	// The wire connection used to invoke actions — the client counterpart of
	// `createServerApp({ transport })`. When omitted, the app builds the default
	// Roblox invoker (`createActionInvoker()`), which waits for the remote
	// the server transport creates. Contract-handshake options apply only to this
	// owned default invoker, not a caller-supplied `transport`.
	readonly transport?: ClientTransport;
	// The generated signal registry (`$aruna/signals`). When paired with
	// `createSubscriber`, the app builds the subscriber at boot.
	readonly signals?: TSignals;
	// Builds the subscriber from `signals`. Pass `createSignalSubscriber` from
	// `aruna/roblox`. Owned by the app: built once at creation, disposed with it.
	readonly createSubscriber?: ClientSignalSubscriberFactory<TSignals>;
	// Request timeout for the app-owned default invoker (milliseconds). Defaults
	// to DEFAULT_ACTION_REQUEST_TIMEOUT_MS (10s); pass 0 to wait forever. Ignored
	// when a caller-supplied `transport` is given.
	readonly requestTimeoutMs?: number;
	// Around-invoke middleware applied outermost-first to every action, on both
	// the module-global `invokeAction` path and this app's `invoke`. Wraps whatever
	// transport is used (owned default or caller-supplied). Runs per attempt when
	// a retry policy is also configured.
	readonly middleware?: readonly ClientMiddleware[];
	// Opt-in automatic retry with backoff, applied outermost (so it re-runs
	// middleware on each attempt). Disabled by default; a policy with maxRetries 0
	// is a no-op. See ClientRetryPolicy.
	readonly retry?: ClientRetryPolicy;
	// The client end of the server's resources: `true` builds the default one over
	// the Aruna RemoteEvent (`createResourceClient()`), or pass one you built. The
	// app installs it for the generated bindings and disposes it with the app.
	readonly resources?: boolean | ResourceClient;
}

export function createClientApp<TSignals extends SignalMap = SignalMap>(
	options?: CreateClientAppOptions<TSignals>,
): ClientApp<TSignals> {
	let transport: ClientTransport;
	if (options !== undefined && options.transport !== undefined) {
		transport = options.transport;
	} else {
		// Forward request-timeout and contract-handshake options to the owned
		// default invoker.
		const invokerOptions: CreateActionInvokerOptions = {
			...(options !== undefined && options.requestTimeoutMs !== undefined
				? { requestTimeoutMs: options.requestTimeoutMs }
				: {}),
			...(options !== undefined && options.expectedContractHash !== undefined
				? { expectedContractHash: options.expectedContractHash }
				: {}),
			...(options !== undefined && options.onVersionMismatch !== undefined
				? { onVersionMismatch: options.onVersionMismatch }
				: {}),
			...(options !== undefined && options.rejectOnMismatch !== undefined
				? { rejectOnMismatch: options.rejectOnMismatch }
				: {}),
		};
		transport = createActionInvoker(invokerOptions);
	}

	// Wrap the resolved transport with client middleware before it is installed,
	// so both the module-global `invokeAction` path and this app's `invoke`
	// inherit it.
	if (options !== undefined && options.middleware !== undefined) {
		transport = withClientMiddleware(transport, options.middleware);
	}

	// Retry wraps the middleware-wrapped transport, so it is outermost and re-runs
	// middleware (and re-mints the underlying request) on every attempt.
	if (options !== undefined && options.retry !== undefined) {
		transport = withRetry(transport, options.retry);
	}

	setActionInvoker(transport);

	let subscriber: SignalSubscriber<TSignals> | undefined;
	if (
		options !== undefined &&
		options.signals !== undefined &&
		options.createSubscriber !== undefined
	) {
		subscriber = options.createSubscriber(options.signals);
	}

	let resources: ResourceClient | undefined;
	if (options !== undefined && options.resources !== undefined && options.resources !== false) {
		resources = options.resources === true ? createResourceClient() : options.resources;
		setResourceClient(resources);
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
		...(resources !== undefined ? { resources } : {}),
		dispose: () => {
			if (disposed) {
				return;
			}
			disposed = true;
			clearActionInvoker();
			if (subscriber !== undefined) {
				subscriber.dispose();
			}
			if (resources !== undefined) {
				clearResourceClient(resources);
				resources.dispose();
			}
		},
	};
}

// The resource client surface, and the binding the generated
// `$aruna/resources/client` module is made of.
export { resourceBinding } from "./resource";
export type {
	ResourceBinding,
	ResourceClient,
	ResourceListener,
	ResourceStatus,
	ResourceSubscribeOptions,
	ResourceSubscription,
	ResourceUpdateInfo,
} from "./resource";

// Opt-in traffic metrics (docs/observability.md): a client collects its own
// round trips with `metrics.clientMiddleware()`. The same collector as on
// `aruna/server`, so a client need not load the server runtime for it.
export { createNetworkMetrics, estimateWireBytes, formatNetworkReport } from "./network-metrics";
export type {
	ActionMetrics,
	LatencySummary,
	NetworkMetrics,
	NetworkMetricsOptions,
	NetworkMetricsReport,
	ResourceMetrics,
	SignalMetrics,
	WireMetrics,
} from "./network-metrics";

// Re-exported so `aruna/client` is the single client entry.
export * from "./client-runtime";
