// Aruna roblox-ts native runtime — server app wiring.

import { actionError } from "./action-error";
import {
	createActionRegistry,
	type ActionErrorHandler,
	type ActionMap,
	type ActionMiddleware,
	type ActionRegistry,
	type ActionRegistryOptions,
} from "./server-runtime";
import type { ActionRateLimitOptions } from "./server";
import type { RequestAbuseHandler, RequestBudgetOptions } from "./request-guard";
import type { AnyPlayerStore, PlayerStoreStatus, StoreDocument } from "./player-store";
import type { StoreError } from "./store";
import type { SignalMap, SignalPublisher } from "./signal-runtime";
import {
	createResourceHost,
	type ResourceErrorHandler,
	type ResourceHost,
	type ResourceMap,
} from "./resource";

export interface ServerAppBinding {
	readonly disconnect: () => void;
}

// A server transport binds the dispatch-ready registry to a concrete remote and
// returns a disposable binding. Pass one to `createServerApp({ transport })` so
// the app owns the wiring. `resources` is the app's resource host when it has
// one: the transport attaches it to its server channel and hands it the
// subscription items that arrive on the remote.
export type ServerTransport<TPlayer> = (
	registry: ActionRegistry<TPlayer>,
	resources?: ResourceHost<TPlayer>,
) => ServerAppBinding;

// Builds a server-side signal publisher from a signal registry, ensuring the
// remote exists at call time. `createSignalPublisher` from `aruna/roblox`
// is the canonical implementation.
export type ServerSignalPublisherFactory<TPlayer, TSignals extends SignalMap> = (
	signals: TSignals,
) => SignalPublisher<TSignals, TPlayer>;

// Several player stores the app owns, by the name actions read them under
// (`ctx.stores.<name>`).
export type PlayerStoreMap<TPlayer> = { readonly [name: string]: AnyPlayerStore<TPlayer> };

// Every owned store's outcome for one player, once each load has settled.
export interface PlayerStoresReport {
	// True when every store opened a document.
	readonly ok: boolean;
	// The stores whose load gave up, by name.
	readonly failed: readonly string[];
	readonly statuses: { readonly [name: string]: PlayerStoreStatus };
	readonly errors: { readonly [name: string]: StoreError };
}

// `app.stores`: readiness across every player store the app owns.
export interface PlayerStoreSet<TPlayer> {
	readonly status: (player: TPlayer) => { readonly [name: string]: PlayerStoreStatus };
	// Whether the named stores (all of them by default) have an open document.
	readonly isReady: (player: TPlayer, names?: readonly string[]) => boolean;
	// Resolves once every store's load for the player has settled.
	readonly ready: (player: TPlayer) => Promise<PlayerStoresReport>;
	readonly get: (name: string) => AnyPlayerStore<TPlayer> | undefined;
}

// The error an action refused by `requireStores` fails with. Public: the client
// sees the name and can try again once the data has loaded.
export const STORE_NOT_READY_ERROR_NAME = "StoreNotReadyError";

// Middleware that refuses an action until the calling player's documents are
// open, so nothing mutates data that has not loaded (or failed to). Name the
// `playerStores` the action needs; "store" (and no names at all) is the single
// `playerStore`. Names, not "everything in `ctx.stores`": a store that has not
// loaded is a nil field, which a Luau table does not hold, so it cannot be
// found by looking. Refused with StoreNotReadyError before `run`.
export function requireStores<TPlayer = unknown>(...names: string[]): ActionMiddleware<TPlayer> {
	const required = names.size() > 0 ? names : ["store"];
	return (info, nextLayer) => {
		const missing = new Array<string>();
		const stores = info.ctx.stores;
		for (const name of required) {
			const named = stores !== undefined ? stores[name] : undefined;
			const document = named === undefined && name === "store" ? info.ctx.store : named;
			if (document === undefined) {
				missing.push(name);
			}
		}
		if (missing.size() > 0) {
			missing.sort();
			return Promise.reject(
				actionError(
					STORE_NOT_READY_ERROR_NAME,
					`Aruna action ${info.actionId} needs player data that is not loaded: ${missing.join(", ")}.`,
				),
			);
		}
		return nextLayer();
	};
}

export interface AppDispatchOptions {
	readonly idempotencyKey?: string;
}

export interface ServerApp<TPlayer, TSignals extends SignalMap = SignalMap> {
	// The action map the app was created with, for enumeration/tooling.
	readonly actions: ActionMap<TPlayer>;
	// In-process dispatch through the same validated, rate-limited,
	// middleware-wrapped path the wire uses — no RemoteEvent required. Resolves
	// with the action's output and rejects with the error string on failure.
	// This is the supported way to exercise actions from tests (e.g. under Lune).
	// `options.idempotencyKey` de-duplicates the call the way a retried wire call
	// is: the same key for the same player and action runs it once. Trusted
	// server code, so not held to the in-flight cap (`requestBudget.maxInFlight`)
	// a client's envelopes are.
	readonly dispatch: (
		actionId: string,
		ctx: { readonly player: TPlayer },
		input: unknown,
		options?: AppDispatchOptions,
	) => Promise<unknown>;
	// Present when a `transport` was supplied to `createServerApp`.
	readonly binding?: ServerAppBinding;
	// Present when both `signals` and `createPublisher` were supplied. Built
	// eagerly so the remote exists at boot.
	readonly publisher?: SignalPublisher<TSignals, TPlayer>;
	// Present when `resources` was supplied: invalidation, and subscriber counts.
	readonly resources?: ResourceHost<TPlayer>;
	// Present when a `playerStore` was supplied. The app drives its lifecycle
	// (load on join, flush and release on leave and at shutdown); this handle is
	// for everything else — reading a document outside an action, or an extra
	// `saveAll()` around a risky operation.
	readonly playerStore?: AnyPlayerStore<TPlayer>;
	// Present when `playerStore` or `playerStores` was supplied: per-player
	// readiness across every owned store. The single `playerStore` is named
	// "store".
	readonly stores?: PlayerStoreSet<TPlayer>;
	// Disposes the owned transport binding (no-op when no `transport` was given).
	readonly dispose: () => void;
}

// A Players-service-shaped source for the player lifecycle hooks, for callers
// that drive joins and leaves themselves — `createTestServerApp` passes an
// in-memory one so a spec can join a fake player without a running game.
// `PlayerAdded` and `GetPlayers` are optional: without `PlayerAdded` the app
// never fires `onPlayerAdded`, and without `GetPlayers` it skips boot backfill.
export interface PlayersSource<TPlayer> {
	readonly PlayerAdded?: {
		readonly Connect: (callback: (player: TPlayer) => void) => {
			readonly Disconnect: () => void;
		};
	};
	readonly PlayerRemoving: {
		readonly Connect: (callback: (player: TPlayer) => void) => {
			readonly Disconnect: () => void;
		};
	};
	readonly GetPlayers?: () => readonly TPlayer[];
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
	// `createPublisher`, the app builds the publisher at boot so the remote
	// is replicated before any client subscribes.
	readonly signals?: TSignals;
	// Builds the publisher from `signals`. Pass `createSignalPublisher` from
	// `aruna/roblox`. Owned by the app: runs once at creation.
	readonly createPublisher?: ServerSignalPublisherFactory<TPlayer, TSignals>;
	// The generated resource registry (`$aruna/resources/server`). The app owns
	// the host (`app.resources`), injects invalidation into every action ctx as
	// `ctx.resources`, hands the host to the transport, and drops a player's
	// subscriptions when they leave.
	readonly resources?: ResourceMap;
	// Told about a resource load that failed (or returned a value the server
	// would not send), with the id the client's error item carries.
	readonly onResourceError?: ResourceErrorHandler<TPlayer>;
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
	// Sends a thrown error's own name and message to the client instead of
	// `ActionInternalError`. Off by default: a Luau runtime error names the
	// server script and line it came from. Errors made with `actionError`, and
	// the framework's own failures, are public either way.
	readonly exposeInternalErrors?: boolean;
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
	// Several session-locked player stores, by name: each loads on join, flushes
	// and releases on leave, and is flushed at shutdown, independently — one
	// store's failure never skips another's release. Actions see the open
	// documents as `ctx.stores.<name>`, each undefined until it lands and after a
	// failed load (a default would overwrite the real record at the next save).
	readonly playerStores?: PlayerStoreMap<TPlayer>;
	// Called once per join when every owned store's load has settled, with what
	// each one did. The place to decide about a partial failure: kick, retry, or
	// run the player without the data that failed. A player who left before the
	// loads settled is reported too.
	readonly onStoresReady?: (player: TPlayer, report: PlayerStoresReport) => void;
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
	// The clock the rate limiter reads, in milliseconds. Left unset in a game;
	// set by `createTestServerApp`, which freezes it so a spec steps past a
	// window with `advance(ms)` rather than waiting one out.
	readonly nowMs?: () => number;
	// Per-player limits in front of dispatch, for every envelope a client sends:
	// a token bucket (`burst` envelopes, refilled at `perSecond`) charged before
	// the transport reads the payload, and a cap on dispatches running at once
	// (`maxInFlight`). An envelope over budget is dropped without a response; a
	// call over the cap is refused with ActionRateLimitError. Defaults 60 / 30 / 32.
	readonly requestBudget?: RequestBudgetOptions;
	// Told, with a running count per player and reason, when a player's envelope
	// is dropped (malformed, over budget, an unknown action) or a call of theirs
	// is refused (too many in flight, invalid input, rate limited). For logging,
	// or a kick. Never told about in-process dispatch.
	readonly onAbuse?: RequestAbuseHandler<TPlayer>;
	// Replaces the Players service as the source of joins and leaves. Left unset
	// in a game — the app connects to `Players` itself; set by the test harness,
	// which fires the handlers on demand.
	readonly players?: PlayersSource<TPlayer>;
}

export function createServerApp<
	TPlayer = unknown,
	TSignals extends SignalMap = SignalMap,
	TSession = unknown,
>(options: CreateServerAppOptions<TPlayer, TSignals, TSession>): ServerApp<TPlayer, TSignals> {
	// Build the publisher first so it can be injected into every action ctx via
	// the registry (and so the remote exists at boot).
	const publisher =
		options.signals !== undefined && options.createPublisher !== undefined
			? options.createPublisher(options.signals)
			: undefined;

	// Per-player session store, keyed by the Player instance. Populated on join
	// (and boot backfill) and drained on leave; read by dispatch via `getSession`.
	const sessions = new Map<TPlayer, TSession>();
	const createSession = options.createSession;
	const playerStore = options.playerStore;

	// Every owned store, by name. The single `playerStore` is "store"; a store
	// given both ways is owned once.
	const ownedStores = new Array<{ readonly name: string; readonly store: AnyPlayerStore<TPlayer> }>();
	if (playerStore !== undefined) {
		ownedStores.push({ name: "store", store: playerStore });
	}
	if (options.playerStores !== undefined) {
		for (const [name, store] of pairs(options.playerStores as { [name: string]: AnyPlayerStore<TPlayer> })) {
			if (store !== playerStore) {
				ownedStores.push({ name: name as string, store });
			}
		}
	}
	const namedStores = options.playerStores;
	const getStores =
		namedStores !== undefined
			? (player: TPlayer) => {
					const documents: { [name: string]: StoreDocument<unknown> | undefined } = {};
					for (const [name, store] of pairs(namedStores as { [name: string]: AnyPlayerStore<TPlayer> })) {
						documents[name as string] = store.get(player) as StoreDocument<unknown> | undefined;
					}
					return documents;
				}
			: undefined;

	const reportFor = (player: TPlayer): PlayerStoresReport => {
		const statuses: { [name: string]: PlayerStoreStatus } = {};
		const errors: { [name: string]: StoreError } = {};
		const failed = new Array<string>();
		for (const owned of ownedStores) {
			const status = owned.store.status(player);
			statuses[owned.name] = status;
			if (status.state !== "ready") {
				failed.push(owned.name);
				if (status.error !== undefined) {
					errors[owned.name] = status.error;
				}
			}
		}
		return { ok: failed.size() === 0, failed, statuses, errors };
	};

	const storeSet: PlayerStoreSet<TPlayer> | undefined =
		ownedStores.size() > 0
			? {
					status: (player) => reportFor(player).statuses,
					isReady: (player, names) => {
						for (const owned of ownedStores) {
							if (names !== undefined && !names.includes(owned.name)) {
								continue;
							}
							if (owned.store.status(player).state !== "ready") {
								return false;
							}
						}
						return true;
					},
					ready: (player) => {
						const settled = new Array<Promise<unknown>>();
						for (const owned of ownedStores) {
							settled.push(owned.store.waitFor(player));
						}
						return Promise.all(settled).then(() => reportFor(player));
					},
					get: (name) => {
						for (const owned of ownedStores) {
							if (owned.name === name) {
								return owned.store;
							}
						}
						return undefined;
					},
				}
			: undefined;

	const resources =
		options.resources !== undefined
			? createResourceHost<TPlayer>(options.resources, {
					...(createSession !== undefined ? { getSession: (player: TPlayer) => sessions.get(player) } : {}),
					...(playerStore !== undefined
						? {
								getStore: (player: TPlayer): StoreDocument<unknown> | undefined =>
									playerStore.get(player) as StoreDocument<unknown> | undefined,
							}
						: {}),
					...(getStores !== undefined ? { getStores } : {}),
					...(options.onResourceError !== undefined ? { onResourceError: options.onResourceError } : {}),
				})
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
		...(getStores !== undefined ? { getStores } : {}),
		...(resources !== undefined ? { resources } : {}),
		...(options.middleware !== undefined ? { middleware: options.middleware } : {}),
		...(options.onError !== undefined ? { onError: options.onError } : {}),
		...(options.exposeInternalErrors !== undefined
			? { exposeInternalErrors: options.exposeInternalErrors }
			: {}),
		...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
		...(options.requestBudget !== undefined ? { requestBudget: options.requestBudget } : {}),
		...(options.onAbuse !== undefined ? { onAbuse: options.onAbuse } : {}),
	};
	const registry = createActionRegistry<TPlayer>(options.actions, registryOptions);

	const binding = options.transport !== undefined ? options.transport(registry, resources) : undefined;

	const onPlayerAdded = options.onPlayerAdded;
	const onPlayerRemoving = options.onPlayerRemoving;
	// Both handlers run whenever there is a players source: on leave the
	// player's idempotency keys have to be dropped, and on join a departed mark
	// cleared. Boot backfill runs only when a session must be created or
	// `onPlayerAdded` wants to observe the join. Session creation precedes the
	// hook.
	const needsAddedHandling =
		createSession !== undefined || onPlayerAdded !== undefined || ownedStores.size() > 0;

	// A hook that throws is reported and does not stop the lifecycle around it:
	// a thrown `onPlayerRemoving` must not leave a store lock held or a player's
	// state behind.
	const runHook = (name: string, hook: () => void): void => {
		const [ran, failure] = pcall(hook);
		if (!ran) {
			warn(`Aruna server app: ${name} threw: ${tostring(failure)}`);
		}
	};

	const handlePlayerAdded = (player: TPlayer): void => {
		// A player who left and came back (the same object, as a test harness
		// reuses one) is no longer departed.
		registry.readmitPlayer(player);
		// Started first, and not waited on: the join handler must not block on a
		// locked DataStore read, and a session factory that throws must not cost
		// the player their data. The stores report their own failures through
		// `onLoadFailed`, and each document stays undefined until it lands.
		const loads = new Array<Promise<unknown>>();
		for (const owned of ownedStores) {
			const [started, load] = pcall(() => owned.store.load(player));
			if (started) {
				loads.push(load);
			} else {
				warn(`Aruna server app: store ${owned.name} load threw: ${tostring(load)}`);
			}
		}
		const onStoresReady = options.onStoresReady;
		if (onStoresReady !== undefined && ownedStores.size() > 0) {
			Promise.all(loads).then(() => runHook("onStoresReady", () => onStoresReady(player, reportFor(player))));
		}
		let session: TSession | undefined;
		if (createSession !== undefined) {
			session = createSession(player);
			sessions.set(player, session);
		}
		if (onPlayerAdded !== undefined) {
			runHook("onPlayerAdded", () => onPlayerAdded(player, session as TSession));
		}
	};

	const handlePlayerRemoving = (player: TPlayer): void => {
		if (onPlayerRemoving !== undefined) {
			runHook("onPlayerRemoving", () => onPlayerRemoving(player, sessions.get(player)));
		}
		// After the user hook, so a last write from `onPlayerRemoving` is included
		// in the final flush rather than racing the release. Each store on its own:
		// one that throws does not skip the rest.
		for (const owned of ownedStores) {
			runHook(`store ${owned.name} release`, () => {
				owned.store.release(player);
			});
		}
		sessions.delete(player);
		registry.forgetPlayer(player);
		if (resources !== undefined) {
			resources.forgetPlayer(player);
		}
	};

	// Lifecycle teardown is collected as closures rather than as a shared
	// connection variable: a real RBXScriptConnection is disconnected with a
	// method call and an injected source's with a plain field call, and each
	// closure is typed at the site that created it so roblox-ts emits the right
	// one for each.
	const lifecycleCleanups = new Array<() => void>();

	const source = options.players;
	if (source !== undefined) {
		// Injected source (tests, and anything that drives joins itself). Never
		// touches the Players service, so it works outside a running game.
		const addedSignal = source.PlayerAdded;
		// Always, where the source has it: a rejoin clears the departed mark.
		if (addedSignal !== undefined) {
			const connection = addedSignal.Connect((player) => {
				handlePlayerAdded(player);
			});
			lifecycleCleanups.push(() => connection.Disconnect());
		}
		// Always: at the least, the player's idempotency keys have to be dropped.
		const removingConnection = source.PlayerRemoving.Connect((player) => {
			handlePlayerRemoving(player);
		});
		lifecycleCleanups.push(() => removingConnection.Disconnect());
		const getPlayers = source.GetPlayers;
		if (needsAddedHandling && getPlayers !== undefined) {
			for (const player of getPlayers()) {
				handlePlayerAdded(player);
			}
		}
	} else {
		const players = game.GetService("Players");
		// Always: a rejoin clears the departed mark.
		const addedConnection = players.PlayerAdded.Connect((player) => {
			handlePlayerAdded(player as unknown as TPlayer);
		});
		lifecycleCleanups.push(() => addedConnection.Disconnect());
		const removingConnection = players.PlayerRemoving.Connect((player) => {
			handlePlayerRemoving(player as unknown as TPlayer);
		});
		lifecycleCleanups.push(() => removingConnection.Disconnect());

		// Boot backfill: fire the join handler for players already in the server
		// when the app is created, so a mid-session boot does not miss anyone.
		if (needsAddedHandling) {
			for (const player of players.GetPlayers()) {
				handlePlayerAdded(player as unknown as TPlayer);
			}
		}
	}

	// Shutdown flush. Roblox gives BindToClose about 30 seconds and expects the
	// callback to yield until it is done, so this waits on a plain flag rather
	// than the promise — the release chain resolves on its own threads. Documents
	// that do not finish in time keep their lock, and the next server takes it
	// over once the TTL lapses; that is the safe end of the trade.
	if (ownedStores.size() > 0) {
		const timeoutSeconds =
			options.shutdownTimeoutSeconds !== undefined ? options.shutdownTimeoutSeconds : 20;
		game.BindToClose(() => {
			let finished = false;
			const releases = new Array<Promise<unknown>>();
			for (const owned of ownedStores) {
				releases.push(owned.store.releaseAll());
			}
			Promise.all(releases).then(() => {
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
		dispatch: (actionId, ctx, input, dispatchOptions) =>
			registry
				.dispatchInProcess(
					ctx.player,
					actionId,
					input,
					dispatchOptions !== undefined ? dispatchOptions.idempotencyKey : undefined,
				)
				.then((result) => {
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
						...(result.errorId !== undefined ? { errorId: result.errorId } : {}),
						...(result.errorData !== undefined ? { data: result.errorData } : {}),
					};
				}),
		...(binding !== undefined ? { binding } : {}),
		...(publisher !== undefined ? { publisher } : {}),
		...(resources !== undefined ? { resources } : {}),
		...(playerStore !== undefined ? { playerStore } : {}),
		...(storeSet !== undefined ? { stores: storeSet } : {}),
		dispose: () => {
			if (binding !== undefined) {
				binding.disconnect();
			}
			if (resources !== undefined) {
				resources.dispose();
			}
			for (const cleanup of lifecycleCleanups) {
				cleanup();
			}
			lifecycleCleanups.clear();
			sessions.clear();
		},
	};
}
