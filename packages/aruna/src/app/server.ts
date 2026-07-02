import {
  dispatchAction,
  type ActionRegistry,
  type ActionRateLimiter,
  type ActionRateLimitOptions,
  type ActionRunContext,
  type DispatchActionOptions,
  type RateLimitKeyResolver,
} from "../runtime/server.js";
import { createActionRateLimiter } from "../runtime/rate-limit.js";
import { normalizeServerBinding, type ServerBinding } from "../runtime/binding.js";
import type { RemoteSignalPublisher } from "../runtime/remote-signal.js";
import type { SignalRegistry } from "../runtime/signal.js";

export type { ServerBinding } from "../runtime/binding.js";

// Builds a server-side signal publisher from a signal registry, ensuring the
// underlying remote exists at call time. `createSignalPublisher` from
// `aruna/roblox` is the canonical implementation. Passed to `createServerApp`
// so the app owns the publisher and the signal remote is created at boot —
// removing the hand-written lazy-singleton plumbing module.
export type ServerSignalPublisherFactory<
  TPlayer = unknown,
  TSignals extends SignalRegistry = SignalRegistry,
> = (signals: TSignals) => RemoteSignalPublisher<TSignals, TPlayer>;

// Context handed to a transport when `createServerApp` owns the binding. The
// transport receives the registry plus the app's fully-resolved dispatch
// options (rate limiter, key resolver, and — crucially — `defaultRateLimit`) so
// every wire dispatch flows through the same throttling path as `app.dispatch`.
export type ServerTransportContext<
  TPlayer = unknown,
  TActions extends ActionRegistry<TPlayer> = ActionRegistry<TPlayer>,
> = {
  readonly registry: TActions;
  readonly dispatch: DispatchActionOptions<TPlayer>;
};

// A server transport binds the action registry to a concrete remote (RemoteEvent
// / RemoteFunction / in-memory) and returns a disposable binding. Pass one to
// `createServerApp({ transport })` so the app owns the wiring and no dispatch
// option can be silently dropped on the way to the wire. See `robloxRemoteEvent`
// in `aruna/roblox`.
export type ServerTransport<
  TPlayer = unknown,
  TActions extends ActionRegistry<TPlayer> = ActionRegistry<TPlayer>,
> = (
  context: ServerTransportContext<TPlayer, TActions>,
) => void | ServerBinding | (() => void);

export type ServerApp<
  TPlayer = unknown,
  TActions extends ActionRegistry<TPlayer> = ActionRegistry<TPlayer>,
  TSignals extends SignalRegistry = SignalRegistry,
> = {
  readonly actions: TActions;
  readonly dispatch: (
    actionId: string,
    ctx: ActionRunContext<TPlayer>,
    input: unknown,
  ) => Promise<unknown>;
  // Present when a `transport` was supplied to `createServerApp`. The app binds
  // the transport eagerly; this is the resulting disposable handle.
  readonly binding?: ServerBinding;
  // Present when both `signals` and `createPublisher` were supplied. Built
  // eagerly so the signal remote exists at boot — call `publisher.toAll(...)`
  // etc. directly, no plumbing module required.
  readonly publisher?: RemoteSignalPublisher<TSignals, TPlayer>;
  // Disposes the owned transport binding (no-op when no `transport` was given).
  readonly dispose: () => void;
};

export type CreateServerAppOptions<
  TPlayer = unknown,
  TActions extends ActionRegistry<TPlayer> = ActionRegistry<TPlayer>,
  TSignals extends SignalRegistry = SignalRegistry,
> = {
  readonly actions: TActions;
  // Binds the registry to a concrete remote and is owned by the app. When given,
  // the app applies every dispatch option (including `defaultRateLimit`) on the
  // way to the transport. This is the recommended wiring.
  readonly transport?: ServerTransport<TPlayer, TActions>;
  // The generated signal registry (`$aruna/signals`). When paired with
  // `createPublisher`, the app builds the publisher at boot so the signal remote
  // is replicated before any client subscribes — no boot-order plumbing needed.
  readonly signals?: TSignals;
  // Builds the publisher from `signals`. Pass `createSignalPublisher` from
  // `aruna/roblox`. Owned by the app: it runs once at creation, ensuring the
  // signal remote exists.
  readonly createPublisher?: ServerSignalPublisherFactory<TPlayer, TSignals>;
  readonly rateLimiter?: ActionRateLimiter;
  readonly rateLimitKey?: RateLimitKeyResolver<TPlayer>;
  // Fallback rate limit for actions that do not declare their own `rateLimit`.
  readonly defaultRateLimit?: ActionRateLimitOptions;
  readonly nowMs?: () => number;
};

export function createServerApp<
  TPlayer = unknown,
  TActions extends ActionRegistry<TPlayer> = ActionRegistry<TPlayer>,
  TSignals extends SignalRegistry = SignalRegistry,
>(
  options: CreateServerAppOptions<TPlayer, TActions, TSignals>,
): ServerApp<TPlayer, TActions, TSignals> {
  const rateLimiter = options.rateLimiter ?? createActionRateLimiter();

  // Build the publisher eagerly so the signal remote is created at boot. This
  // closes the boot-order gap where a client could `WaitForChild` the signal
  // remote before the server lazily created it. Built before the dispatch options
  // so it can be threaded into every action ctx (in-process and over the wire).
  let publisher: RemoteSignalPublisher<TSignals, TPlayer> | undefined;
  if (options.signals !== undefined && options.createPublisher !== undefined) {
    publisher = options.createPublisher(options.signals);
  }

  // Resolved once and shared by `dispatch` and the owned `transport`, so both
  // throttle identically and both expose the same `ctx.publisher`. The publisher
  // is carried registry-erased here (the precise typing lives on the action ctx);
  // dispatch only forwards the object to `ctx.publisher`, never invokes it.
  const dispatchOptions = {
    rateLimiter,
    ...(options.rateLimitKey !== undefined ? { rateLimitKey: options.rateLimitKey } : {}),
    ...(options.defaultRateLimit !== undefined
      ? { defaultRateLimit: options.defaultRateLimit }
      : {}),
    ...(publisher !== undefined
      ? { publisher: publisher as unknown as RemoteSignalPublisher<SignalRegistry, unknown> }
      : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  } satisfies DispatchActionOptions<TPlayer>;

  let transportBinding: ServerBinding | undefined;
  if (options.transport !== undefined) {
    transportBinding = normalizeServerBinding(
      options.transport({ registry: options.actions, dispatch: dispatchOptions }),
    );
  }

  return {
    actions: options.actions,
    dispatch(actionId, ctx, input) {
      return dispatchAction(options.actions, actionId, ctx, input, dispatchOptions);
    },
    ...(transportBinding !== undefined ? { binding: transportBinding } : {}),
    ...(publisher !== undefined ? { publisher } : {}),
    dispose() {
      transportBinding?.dispose();
    },
  };
}
