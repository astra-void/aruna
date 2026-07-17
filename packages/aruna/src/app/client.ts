import type {
  ActionInvokeOptions,
  ActionInvoker,
  ClientMiddleware,
  ClientRetryPolicy,
  ContractHandshakeOptions,
} from "../runtime/client.js";
import type { ActionInvokerOptions } from "../runtime/remote-event.js";
import {
  clearActionInvoker,
  setActionInvoker,
  withClientMiddleware,
  withRetry,
} from "../runtime/client.js";
import { createActionInvoker } from "../runtime/roblox-action-remote.js";
import type { RemoteSignalSubscriber } from "../runtime/remote-signal.js";
import type { SignalRegistry } from "../runtime/signal.js";

// The client counterpart of a server transport: the wire connection actions are
// invoked through. Any `(actionId, input, options) => Promise` works — the
// default Roblox RemoteEvent invoker, a RemoteFunction invoker, or an in-memory
// invoker in tests.
export type ClientTransport = ActionInvoker;

// Builds a client-side signal subscriber from a signal registry, ensuring the
// underlying remote connection at call time. `createSignalSubscriber` from
// `aruna/roblox` is the canonical implementation. Passed to `createClientApp`
// so the app owns the subscriber — the client mirror of
// `createServerApp({ signals, createPublisher })`.
export type ClientSignalSubscriberFactory<
  TSignals extends SignalRegistry = SignalRegistry,
> = (signals: TSignals) => RemoteSignalSubscriber<TSignals>;

export type ClientApp<TSignals extends SignalRegistry = SignalRegistry> = {
  // Invokes an action through this app's transport directly, without going
  // through the module-global `invokeAction`. Prefer this (or pass the app
  // handle to controllers) when call ordering is hard to guarantee: it removes
  // the "controller fired before createClientApp installed the global" footgun.
  readonly invoke: (
    actionId: string,
    input: unknown,
    options?: ActionInvokeOptions,
  ) => Promise<unknown>;
  // Present when both `signals` and `createSubscriber` were supplied. Built
  // eagerly so handlers can be registered at boot — call
  // `subscriber.on(id, handler)` directly, no plumbing module required.
  readonly subscriber?: RemoteSignalSubscriber<TSignals>;
  readonly dispose: () => void;
};

export type CreateClientAppOptions<TSignals extends SignalRegistry = SignalRegistry> =
  ContractHandshakeOptions & {
  // The wire connection used to invoke actions — the client counterpart of
  // `createServerApp({ transport })`. When omitted, the app builds the default
  // Roblox invoker (`createActionInvoker()`), which waits for the action remote
  // the server transport creates. A caller-supplied transport stays
  // caller-owned; only the default one is disposed with the app. Contract-handshake
  // options apply only to this owned default invoker.
  readonly transport?: ClientTransport;
  // The generated signal registry (`$aruna/signals`). When paired with
  // `createSubscriber`, the app builds the subscriber at boot — the client
  // mirror of the server app owning the publisher.
  readonly signals?: TSignals;
  // Builds the subscriber from `signals`. Pass `createSignalSubscriber` from
  // `aruna/roblox`. Owned by the app: it runs once at creation and is disposed
  // with the app.
  readonly createSubscriber?: ClientSignalSubscriberFactory<TSignals>;
  // Request timeout for the app-owned default invoker (milliseconds). Defaults
  // to DEFAULT_ACTION_REQUEST_TIMEOUT_MS (10s); pass 0 to wait forever. Ignored
  // when a caller-supplied `transport` is given — configure that invoker
  // directly instead.
  readonly requestTimeoutMs?: number;
  // Around-invoke middleware applied outermost-first to every action, on both
  // the module-global `invokeAction` path and this app's `invoke`. Wraps whatever
  // transport is used (owned default or caller-supplied). Runs per attempt when a
  // retry policy is also configured.
  readonly middleware?: readonly ClientMiddleware[];
  // Opt-in automatic retry with backoff, applied outermost (so it re-runs
  // middleware on each attempt). Disabled by default; a policy with maxRetries 0
  // is a no-op. See ClientRetryPolicy.
  readonly retry?: ClientRetryPolicy;
};

export function createClientApp<TSignals extends SignalRegistry = SignalRegistry>(
  options?: CreateClientAppOptions<TSignals>,
): ClientApp<TSignals> {
  let ownedTransport: ReturnType<typeof createActionInvoker> | undefined;
  let transport = options?.transport;
  if (transport === undefined) {
    // Forward request-timeout and contract-handshake options to the owned
    // default invoker.
    const invokerOptions: ActionInvokerOptions = {
      ...(options?.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
      ...(options?.expectedContractHash !== undefined
        ? { expectedContractHash: options.expectedContractHash }
        : {}),
      ...(options?.onVersionMismatch !== undefined
        ? { onVersionMismatch: options.onVersionMismatch }
        : {}),
      ...(options?.rejectOnMismatch !== undefined
        ? { rejectOnMismatch: options.rejectOnMismatch }
        : {}),
    };
    ownedTransport = createActionInvoker(invokerOptions);
    transport = ownedTransport;
  }

  // Wrap the resolved transport (owned default or caller-supplied) with client
  // middleware before it is installed, so both the module-global `invokeAction`
  // path and this app's `invoke` inherit it. Disposal still targets the
  // underlying `ownedTransport`, not this wrapper.
  if (options?.middleware !== undefined) {
    transport = withClientMiddleware(transport, options.middleware);
  }

  // Retry wraps the middleware-wrapped transport, so it is outermost and re-runs
  // middleware (and re-mints the underlying request) on every attempt.
  if (options?.retry !== undefined) {
    transport = withRetry(transport, options.retry);
  }

  // Still installs the global so generated `$aruna/actions/client` stubs (which
  // call `invokeAction`) work. The returned `invoke` is the injection-friendly
  // alternative for code that holds the app handle.
  setActionInvoker(transport);

  // Built eagerly so signal handlers can be registered during boot, mirroring
  // the server app ensuring the signal remote exists before clients subscribe.
  let subscriber: RemoteSignalSubscriber<TSignals> | undefined;
  if (options?.signals !== undefined && options.createSubscriber !== undefined) {
    subscriber = options.createSubscriber(options.signals);
  }

  let disposed = false;
  const resolvedTransport = transport;

  return {
    invoke(actionId, input, invokeOptions) {
      if (disposed) {
        return Promise.reject(
          new Error(`Aruna client app is disposed; cannot invoke "${actionId}".`),
        );
      }

      return Promise.resolve(resolvedTransport(actionId, input, invokeOptions));
    },
    ...(subscriber !== undefined ? { subscriber } : {}),
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      clearActionInvoker();
      ownedTransport?.dispose();
      subscriber?.dispose();
    },
  };
}
