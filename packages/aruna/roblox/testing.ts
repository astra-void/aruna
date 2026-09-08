// Aruna roblox-ts native runtime — the in-process test harness.
//
// The mirror of src/testing/harness.ts, and the one a game project actually
// compiles: a real `ServerApp` wired to fakes a spec can drive, so a test
// exercises the same validated, rate-limited, middleware-wrapped dispatch path
// the wire uses — with no RemoteEvent, no Players service, and no DataStore.
//
// Everything is assembled from the shipping runtime rather than re-implemented:
// the publisher is the real `createRemoteSignalPublisher` over a recording
// remote, so a payload that would fail validation in production fails here too.

import { createServerApp, type CreateServerAppOptions, type ServerApp } from "./server-app";
import { createClientApp, type ClientApp } from "./client";
import type { ActionMap } from "./server-runtime";
import {
	createRemoteSignalPublisher,
	createRemoteSignalSubscriber,
	type RemoteSignalMessage,
	type SignalMap,
} from "./signal-runtime";

// The shape of the player double: only the two fields the runtime reads. `UserId`
// is what the default rate-limit key buckets on, `Name` is what test output
// identifies a player by.
export interface TestPlayer {
	readonly Name: string;
	readonly UserId: number;
}

export interface CreateTestPlayerOptions {
	readonly name?: string;
	readonly userId?: number;
}

let nextUserId = 1;

// Returned as `Player` so the double drops straight into a project's
// `Player`-typed actions without a cast at every call site. Reaching for any
// other member of `Player` on it is a nil error, deliberately: a spec that needs
// a real Player needs a real game.
export function createTestPlayer(options?: CreateTestPlayerOptions): Player {
	const userId =
		options !== undefined && options.userId !== undefined ? options.userId : nextUserId++;
	const name = options !== undefined && options.name !== undefined ? options.name : `Player${userId}`;
	const player: TestPlayer = { Name: name, UserId: userId };
	return player as unknown as Player;
}

// One signal emit the app made. A broadcast (`toAll`) carries no player; `to`,
// `toMany`, and `toBatched` record one entry per recipient, which is what the
// wire actually carries.
export interface TestSignalRecord<TPlayer extends defined = Player> {
	readonly signalId: string;
	readonly payload: unknown;
	readonly player?: TPlayer;
}

export interface TestServerApp<TPlayer extends defined = Player, TSignals extends SignalMap = SignalMap> {
	// The real app. Reach for it when the harness does not wrap what you need
	// (`app.playerStore`, `app.publisher`, `app.dispatch` with a hand-built ctx).
	readonly app: ServerApp<TPlayer, TSignals>;
	// Dispatches as `player`, through validation, rate limiting, and middleware.
	readonly invoke: (player: TPlayer, actionId: string, input?: unknown) => Promise<unknown>;
	// Drives the player lifecycle the app subscribed to: sessions are created and
	// dropped, `onPlayerAdded` / `onPlayerRemoving` fire, and an owned player store
	// loads and releases the document.
	readonly join: (player: TPlayer) => void;
	readonly leave: (player: TPlayer) => void;
	readonly players: () => ReadonlyArray<TPlayer>;
	// Every signal emit since the last `takePublished()`, in order.
	readonly published: () => ReadonlyArray<TestSignalRecord<TPlayer>>;
	// Returns the recorded emits and clears the log — the usual shape for
	// "assert what this call published, then move on".
	readonly takePublished: () => ReadonlyArray<TestSignalRecord<TPlayer>>;
	// Steps the harness clock forward, which is how a spec crosses a rate-limit
	// window: the clock is frozen at creation, so windows elapse only when the
	// spec says they do. Errors when the caller supplied its own `nowMs` — the
	// harness is not the one holding the clock then.
	readonly advance: (milliseconds: number) => void;
	// A client app whose transport dispatches into this server as `player`, and
	// whose subscriber receives the signals published to that player. Installs the
	// module-global action invoker, so generated `$aruna/actions/client` stubs
	// work — which means only the most recently created client serves the global.
	readonly client: (player: TPlayer) => ClientApp<TSignals>;
	readonly dispose: () => void;
}

// The harness owns the transport, the publisher, and the players source; the rest
// of `createServerApp` is yours.
export type CreateTestServerAppOptions<
	TPlayer extends defined = Player,
	TSignals extends SignalMap = SignalMap,
	TSession = unknown,
> = Omit<
	CreateServerAppOptions<TPlayer, TSignals, TSession>,
	"transport" | "createPublisher" | "players"
>;

interface SignalSink<TPlayer extends defined> {
	readonly player: TPlayer;
	readonly deliver: (message: RemoteSignalMessage) => void;
}

export function createTestServerApp<
	TPlayer extends defined = Player,
	TSignals extends SignalMap = SignalMap,
	TSession = unknown,
>(
	options: CreateTestServerAppOptions<TPlayer, TSignals, TSession>,
): TestServerApp<TPlayer, TSignals> {
	const published = new Array<TestSignalRecord<TPlayer>>();
	// Client-side sinks, so a signal published to a player reaches the subscriber
	// of the client app the harness built for that player.
	const sinks = new Array<SignalSink<TPlayer>>();

	const recordingRemote = {
		FireClient: (player: TPlayer, message: RemoteSignalMessage) => {
			published.push({ signalId: message.signalId, payload: message.payload, player });
			for (const sink of sinks) {
				if (sink.player === player) {
					sink.deliver(message);
				}
			}
		},
		FireAllClients: (message: RemoteSignalMessage) => {
			published.push({ signalId: message.signalId, payload: message.payload });
			for (const sink of sinks) {
				sink.deliver(message);
			}
		},
	};

	// Frozen at zero and stepped by `advance`, so a rate-limit window elapses
	// when the spec decides rather than in real time. A caller that supplies its
	// own `nowMs` keeps it.
	let clockMs = 0;
	const ownsClock = options.nowMs === undefined;

	const present = new Array<TPlayer>();
	const addedHandlers = new Array<(player: TPlayer) => void>();
	const removingHandlers = new Array<(player: TPlayer) => void>();

	const removeHandler = (
		handlers: Array<(player: TPlayer) => void>,
		handler: (player: TPlayer) => void,
	): void => {
		const at = handlers.indexOf(handler);
		if (at !== -1) {
			handlers.remove(at);
		}
	};

	const signals = options.signals;
	const app = createServerApp<TPlayer, TSignals, TSession>({
		...options,
		...(ownsClock ? { nowMs: () => clockMs } : {}),
		...(signals !== undefined
			? {
					createPublisher: (registry: TSignals) =>
						createRemoteSignalPublisher<TSignals, TPlayer>(recordingRemote, registry),
				}
			: {}),
		players: {
			PlayerAdded: {
				Connect: (callback: (player: TPlayer) => void) => {
					addedHandlers.push(callback);
					return {
						Disconnect: () => {
							removeHandler(addedHandlers, callback);
						},
					};
				},
			},
			PlayerRemoving: {
				Connect: (callback: (player: TPlayer) => void) => {
					removingHandlers.push(callback);
					return {
						Disconnect: () => {
							removeHandler(removingHandlers, callback);
						},
					};
				},
			},
			GetPlayers: () => present,
		},
	});

	const clients = new Array<ClientApp<TSignals>>();
	let disposed = false;

	return {
		app,
		invoke: (player, actionId, input) => app.dispatch(actionId, { player }, input),
		join: (player) => {
			if (present.includes(player)) {
				return;
			}
			present.push(player);
			// Iterated over a copy: a handler that disconnects mid-join must not
			// shift the list out from under the loop.
			for (const handler of [...addedHandlers]) {
				handler(player);
			}
		},
		leave: (player) => {
			const at = present.indexOf(player);
			if (at === -1) {
				return;
			}
			present.remove(at);
			for (const handler of [...removingHandlers]) {
				handler(player);
			}
		},
		players: () => present,
		published: () => published,
		advance: (milliseconds) => {
			if (!ownsClock) {
				error(
					"Aruna test harness: advance() is unavailable because createTestServerApp was given its own nowMs.",
				);
			}
			clockMs += milliseconds;
		},
		takePublished: () => {
			const taken = [...published];
			published.clear();
			return taken;
		},
		client: (player) => {
			const clientApp = createClientApp<TSignals>({
				transport: (actionId, input) => app.dispatch(actionId, { player }, input),
				...(signals !== undefined
					? {
							signals,
							createSubscriber: (registry: TSignals) =>
								createRemoteSignalSubscriber<TSignals>(
									{
										OnClientEvent: {
											Connect: (callback: (message: RemoteSignalMessage) => void) => {
												const sink: SignalSink<TPlayer> = { player, deliver: callback };
												sinks.push(sink);
												return {
													Disconnect: () => {
														const at = sinks.indexOf(sink);
														if (at !== -1) {
															sinks.remove(at);
														}
													},
												};
											},
										},
									},
									registry,
								),
						}
					: {}),
			});
			clients.push(clientApp);
			return clientApp;
		},
		dispose: () => {
			if (disposed) {
				return;
			}
			disposed = true;
			for (const clientApp of clients) {
				clientApp.dispose();
			}
			clients.clear();
			sinks.clear();
			app.dispose();
		},
	};
}

// Re-exported so `aruna/testing` is the single entry a spec imports from.
export * from "./testing-framework";
