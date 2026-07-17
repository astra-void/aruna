import {
  dispatchAction,
  type ActionErrorHandler,
  type ActionMiddleware,
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
  TSession = unknown,
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
  // Around-run middleware, applied outermost-first to every action on every
  // dispatch path (in-process and over the owned transport): auth checks,
  // logging, timing. Runs inside rate limiting and input validation.
  readonly middleware?: readonly ActionMiddleware<TPlayer>[];
  // Observability hook for errors thrown from the action execution chain,
  // called before the error propagates to the transport.
  readonly onError?: ActionErrorHandler<TPlayer>;
  // Builds the per-player session injected into every action ctx as
  // `ctx.session`. Runs once per player on join (and, at boot, for players
  // already present via `players.GetPlayers`) before `onPlayerAdded`, and the
  // session is dropped after `onPlayerRemoving`. Pair with
  // `createActionDefiner<TSignals, TPlayer, TSession>` for a typed `ctx.session`.
  readonly createSession?: (player: TPlayer) => TSession;
  // Called when a player joins (`players.PlayerAdded`), and once at boot for
  // every player already present. Receives the freshly-created session (undefined
  // when no `createSession` is configured). The app owns the connection.
  readonly onPlayerAdded?: (player: TPlayer, session: TSession) => void;
  // Called when a player leaves the server, before the session is dropped. The
  // app owns the connection (disconnected on dispose) — the home for per-player
  // cleanup: persisting session state, caches, anything keyed by the player.
  // Receives the player's session (undefined when none). On the native runtime
  // the source is the real Players service; here the reference runtime takes an
  // injectable `players` source (tests provide a fake).
  readonly onPlayerRemoving?: (player: TPlayer, session: TSession | undefined) => void;
  readonly players?: PlayersSource<TPlayer>;
  readonly nowMs?: () => number;
};

// A Players-service-shaped source for the player lifecycle hooks. `PlayerAdded`
// and `GetPlayers` are optional: without `PlayerAdded` the app never fires
// `onPlayerAdded`, and without `GetPlayers` it skips boot backfill. `GetPlayers`
// mirrors `Players:GetPlayers()`.
export type PlayersSource<TPlayer = unknown> = {
  readonly PlayerAdded?: {
    readonly Connect: (
      callback: (player: TPlayer) => void,
    ) => { readonly Disconnect: () => void };
  };
  readonly PlayerRemoving: {
    readonly Connect: (
      callback: (player: TPlayer) => void,
    ) => { readonly Disconnect: () => void };
  };
  readonly GetPlayers?: () => readonly TPlayer[];
};

export function createServerApp<
  TPlayer = unknown,
  TActions extends ActionRegistry<TPlayer> = ActionRegistry<TPlayer>,
  TSignals extends SignalRegistry = SignalRegistry,
  TSession = unknown,
>(
  options: CreateServerAppOptions<TPlayer, TActions, TSignals, TSession>,
): ServerApp<TPlayer, TActions, TSignals> {
  const rateLimiter = options.rateLimiter ?? createActionRateLimiter();

  // Per-player session store, keyed by the player reference. Populated on join
  // (and boot backfill) and drained on leave; read by dispatch via `getSession`.
  const sessions = new Map<TPlayer, TSession>();
  const createSession = options.createSession;

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
    ...(createSession !== undefined
      ? { getSession: (player: TPlayer) => sessions.get(player) }
      : {}),
    ...(options.middleware !== undefined ? { middleware: options.middleware } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  } satisfies DispatchActionOptions<TPlayer>;

  let transportBinding: ServerBinding | undefined;
  if (options.transport !== undefined) {
    transportBinding = normalizeServerBinding(
      options.transport({ registry: options.actions, dispatch: dispatchOptions }),
    );
  }

  const onPlayerAdded = options.onPlayerAdded;
  const onPlayerRemoving = options.onPlayerRemoving;
  // The join handler runs when either a session must be created or `onPlayerAdded`
  // wants to observe the join; session creation precedes the hook. The leave
  // handler runs when the hook wants it or a session must be dropped to avoid
  // leaking a store entry for a departed player.
  const needsAddedHandling = createSession !== undefined || onPlayerAdded !== undefined;
  const needsRemovingHandling = onPlayerRemoving !== undefined || createSession !== undefined;

  const handlePlayerAdded = (player: TPlayer): void => {
    let session: TSession | undefined;
    if (createSession !== undefined) {
      session = createSession(player);
      sessions.set(player, session);
    }
    if (onPlayerAdded !== undefined) {
      onPlayerAdded(player, session as TSession);
    }
  };

  const handlePlayerRemoving = (player: TPlayer): void => {
    if (onPlayerRemoving !== undefined) {
      onPlayerRemoving(player, sessions.get(player));
    }
    sessions.delete(player);
  };

  const playerAddedConnection =
    needsAddedHandling && options.players?.PlayerAdded !== undefined
      ? options.players.PlayerAdded.Connect(handlePlayerAdded)
      : undefined;
  const playerRemovingConnection =
    needsRemovingHandling && options.players !== undefined
      ? options.players.PlayerRemoving.Connect(handlePlayerRemoving)
      : undefined;

  // Boot backfill: fire the join handler for players already present when the app
  // is created, so a mid-session boot does not miss anyone. Gated on GetPlayers.
  if (needsAddedHandling && options.players?.GetPlayers !== undefined) {
    for (const player of options.players.GetPlayers()) {
      handlePlayerAdded(player);
    }
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
      playerAddedConnection?.Disconnect();
      playerRemovingConnection?.Disconnect();
      sessions.clear();
    },
  };
}
