// Aruna roblox-ts native runtime — server app wiring.

import {
	createActionRegistry,
	type ActionErrorHandler,
	type ActionMap,
	type ActionMiddleware,
	type ActionRegistry,
	type ActionRegistryOptions,
} from "./server-runtime";
import type { ActionRateLimitOptions } from "./server";
import type { AnyPlayerStore, StoreDocument } from "./player-store";
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
	// The action map the app was created with, for enumeration/tooling.
	readonly actions: ActionMap<TPlayer>;
	// In-process dispatch through the same validated, rate-limited,
	// middleware-wrapped path the wire uses — no RemoteEvent required. Resolves
	// with the action's output and rejects with the error string on failure.
	// Mirrors the Node reference runtime's `app.dispatch(actionId, ctx, input)`;
	// this is the supported way to exercise actions from tests (e.g. under Lune).
	readonly dispatch: (
		actionId: string,
		ctx: { readonly player: TPlayer },
		input: unknown,
	) => Promise<unknown>;
	// Present when a `transport` was supplied to `createServerApp`.
	readonly binding?: ServerAppBinding;
	// Present when both `signals` and `createPublisher` were supplied. Built
	// eagerly so the signal remote exists at boot.
	readonly publisher?: SignalPublisher<TSignals, TPlayer>;
	// Present when a `playerStore` was supplied. The app drives its lifecycle
	// (load on join, flush and release on leave and at shutdown); this handle is
	// for everything else — reading a document outside an action, or an extra
	// `saveAll()` around a risky operation.
	readonly playerStore?: AnyPlayerStore<TPlayer>;
	// Disposes the owned transport binding (no-op when no `transport` was given).
	readonly dispose: () => void;
}

export interface CreateServerAppOptions<
	TPlayer,
	TSignals extends SignalMap = SignalMap,
	TSession = unknown,
> {
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
	// Around-run middleware, applied outermost-first to every action on every
	// dispatch path: auth checks, logging, timing. Runs inside rate limiting and
	// input validation.
	readonly middleware?: readonly ActionMiddleware<TPlayer>[];
	// Observability hook for errors raised from the action execution chain,
	// called before dispatch converts the error into the wire result.
	readonly onError?: ActionErrorHandler<TPlayer>;
	// Builds the per-player session injected into every action ctx as
	// `ctx.session`. Runs once per player on join (and, at boot, for players
	// already present) before `onPlayerAdded`, and the session is dropped after
	// `onPlayerRemoving`. Pair with `createActionDefiner<TSignals, TPlayer,
	// TSession>` for a typed, non-optional `ctx.session`.
	readonly createSession?: (player: TPlayer) => TSession;
	// A session-locked player store (`createPlayerStore`) the app owns. On join it
	// acquires the lock and opens the player's document; on leave it flushes and
	// releases; at shutdown `BindToClose` flushes everything still held. Every
	// action then sees the open document as `ctx.store`.
	//
	// The load is asynchronous — it is a locked DataStore read — so `ctx.store` is
	// undefined for actions that arrive before it lands, and stays undefined when
	// the load failed. That is deliberate: the alternative is handing out a
	// default value that the next save would write over a real record.
	readonly playerStore?: AnyPlayerStore<TPlayer>;
	// Seconds to spend flushing held documents during BindToClose. Roblox allows
	// 30; the default leaves headroom for the rest of your shutdown work.
	readonly shutdownTimeoutSeconds?: number;
	// Called when a player joins (Players.PlayerAdded), and once at boot for every
	// player already present. Receives the freshly-created session (undefined when
	// no `createSession` is configured). The app owns the connection (disconnected
	// on dispose).
	readonly onPlayerAdded?: (player: TPlayer, session: TSession) => void;
	// Called when a player leaves the server (Players.PlayerRemoving), before the
	// session is dropped. The app owns the connection (disconnected on dispose) —
	// the home for per-player cleanup: persisting session state, caches, anything
	// keyed by the player. Receives the player's session (undefined when none).
	readonly onPlayerRemoving?: (player: TPlayer, session: TSession | undefined) => void;
}

export function createServerApp<
	TPlayer = unknown,
	TSignals extends SignalMap = SignalMap,
	TSession = unknown,
>(options: CreateServerAppOptions<TPlayer, TSignals, TSession>): ServerApp<TPlayer, TSignals> {
	// Build the publisher first so it can be injected into every action ctx via
	// the registry (and so the signal remote exists at boot).
	const publisher =
		options.signals !== undefined && options.createPublisher !== undefined
			? options.createPublisher(options.signals)
			: undefined;

	// Per-player session store, keyed by the Player instance. Populated on join
	// (and boot backfill) and drained on leave; read by dispatch via `getSession`.
	const sessions = new Map<TPlayer, TSession>();
	const createSession = options.createSession;
	const playerStore = options.playerStore;

	const registryOptions: ActionRegistryOptions<TPlayer> = {
		...(options.defaultRateLimit !== undefined
			? { defaultRateLimit: options.defaultRateLimit }
			: {}),
		// Carried registry-erased; the precise typing lives on the action ctx via
		// `createActionDefiner`. Dispatch only forwards it to `ctx.publisher`.
		...(publisher !== undefined
			? { publisher: publisher as unknown as SignalPublisher<SignalMap, unknown> }
			: {}),
		...(createSession !== undefined ? { getSession: (player: TPlayer) => sessions.get(player) } : {}),
		...(playerStore !== undefined
			? {
					// Both sides are the same erasure of an invariant type, so
					// neither is assignable to the other even though the object is
					// identical. The action ctx spells it `StoreDocument<unknown>`;
					// the cast is where the two spellings meet, and dispatch only
					// forwards the document.
					getStore: (player: TPlayer): StoreDocument<unknown> | undefined =>
						playerStore.get(player) as StoreDocument<unknown> | undefined,
				}
			: {}),
		...(options.middleware !== undefined ? { middleware: options.middleware } : {}),
		...(options.onError !== undefined ? { onError: options.onError } : {}),
	};
	const registry = createActionRegistry<TPlayer>(options.actions, registryOptions);

	const binding = options.transport !== undefined ? options.transport(registry) : undefined;

	const onPlayerAdded = options.onPlayerAdded;
	const onPlayerRemoving = options.onPlayerRemoving;
	// The join handler runs when either a session must be created or `onPlayerAdded`
	// wants to observe the join. Session creation precedes the hook.
	const needsAddedHandling =
		createSession !== undefined || onPlayerAdded !== undefined || playerStore !== undefined;
	// The leave handler runs when either the hook wants it or a session must be
	// dropped to avoid leaking a store entry for a departed player.
	const needsRemovingHandling =
		onPlayerRemoving !== undefined || createSession !== undefined || playerStore !== undefined;

	const handlePlayerAdded = (player: TPlayer): void => {
		let session: TSession | undefined;
		if (createSession !== undefined) {
			session = createSession(player);
			sessions.set(player, session);
		}
		// Started, not waited on: the join handler must not block on a locked
		// DataStore read. The store reports its own failures through `onLoadFailed`,
		// and `ctx.store` stays undefined until the document lands.
		if (playerStore !== undefined) {
			playerStore.load(player);
		}
		if (onPlayerAdded !== undefined) {
			onPlayerAdded(player, session as TSession);
		}
	};

	const handlePlayerRemoving = (player: TPlayer): void => {
		if (onPlayerRemoving !== undefined) {
			onPlayerRemoving(player, sessions.get(player));
		}
		// After the user hook, so a last write from `onPlayerRemoving` is included
		// in the final flush rather than racing the release.
		if (playerStore !== undefined) {
			playerStore.release(player);
		}
		sessions.delete(player);
	};

	const players = game.GetService("Players");
	const playerAddedConnection = needsAddedHandling
		? players.PlayerAdded.Connect((player) => {
				handlePlayerAdded(player as unknown as TPlayer);
			})
		: undefined;
	const playerRemovingConnection = needsRemovingHandling
		? players.PlayerRemoving.Connect((player) => {
				handlePlayerRemoving(player as unknown as TPlayer);
			})
		: undefined;

	// Boot backfill: fire the join handler for players already in the server when
	// the app is created, so a mid-session boot does not miss anyone.
	if (needsAddedHandling) {
		for (const player of players.GetPlayers()) {
			handlePlayerAdded(player as unknown as TPlayer);
		}
	}

	// Shutdown flush. Roblox gives BindToClose about 30 seconds and expects the
	// callback to yield until it is done, so this waits on a plain flag rather
	// than the promise — the release chain resolves on its own threads. Documents
	// that do not finish in time keep their lock, and the next server takes it
	// over once the TTL lapses; that is the safe end of the trade.
	if (playerStore !== undefined) {
		const timeoutSeconds =
			options.shutdownTimeoutSeconds !== undefined ? options.shutdownTimeoutSeconds : 20;
		game.BindToClose(() => {
			let finished = false;
			playerStore.releaseAll().then(() => {
				finished = true;
			});
			const deadline = os.clock() + timeoutSeconds;
			while (!finished && os.clock() < deadline) {
				task.wait(0.1);
			}
		});
	}

	return {
		actions: options.actions,
		dispatch: (actionId, ctx, input) =>
			registry.dispatch(ctx.player, actionId, input).then((result) => {
				if (result.ok) {
					return result.output;
				}
				// Same structured rejection shape the client invoker produces, so
				// in-process callers and wire callers handle failures identically.
				throw {
					message: result.error !== undefined ? result.error : "action failed",
					...(result.errorName !== undefined ? { name: result.errorName } : {}),
					...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
					...(result.resetAtMs !== undefined ? { resetAtMs: result.resetAtMs } : {}),
				};
			}),
		...(binding !== undefined ? { binding } : {}),
		...(publisher !== undefined ? { publisher } : {}),
		...(playerStore !== undefined ? { playerStore } : {}),
		dispose: () => {
			if (binding !== undefined) {
				binding.disconnect();
			}
			if (playerAddedConnection !== undefined) {
				playerAddedConnection.Disconnect();
			}
			if (playerRemovingConnection !== undefined) {
				playerRemovingConnection.Disconnect();
			}
			sessions.clear();
		},
	};
}
