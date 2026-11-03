// Aruna roblox-ts native runtime — the in-process test harness.
//
// What a game project's specs compile against: a real `ServerApp` wired to fakes a spec can drive, so a test
// exercises the same validated, rate-limited, middleware-wrapped dispatch path
// the wire uses — with no RemoteEvent, no Players service, and no DataStore.
//
// Everything is assembled from the shipping runtime rather than re-implemented:
// the publisher is the real `createRemoteSignalPublisher` over a server channel
// on a recording remote, so a payload that would fail validation in production
// fails here too. By default the channel sends unbatched (each item in its own
// wire frame, as it is produced), so `published()` and a client's handlers see a
// signal without waiting a frame. With `batching: true` the harness runs the
// wire as a game does — calls and the server channel both queue until `step()`,
// and a client's calls travel the real action binding — so a spec can assert the
// order a client reads responses and signals in.

import {
	createServerApp,
	type AppDispatchOptions,
	type CreateServerAppOptions,
	type ServerApp,
} from "./server-app";
import { createClientApp, type ClientApp, type ClientTransport } from "./client";
import { bindRemoteActions, createRemoteActionInvoker } from "./roblox";
import {
	admitResourceItem,
	answerOptimisticCall,
	createResourceClient,
	type ResourceClient,
	type ResourceHost,
} from "./resource";
import type { ActionMap, ActionRegistry } from "./server-runtime";
import {
	createRemoteSignalPublisher,
	createRemoteSignalSubscriber,
	type SignalMap,
} from "./signal-runtime";
import {
	createClientChannel,
	createServerChannel,
	readWireFrame,
	WIRE_ITEM_SIGNAL,
	type ClientChannel,
	type WireFrame,
	type WireFrameScheduler,
	type WireSignal,
} from "./wire";

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
	// `options.idempotencyKey` de-duplicates the call the way a retried wire call
	// is.
	readonly invoke: (
		player: TPlayer,
		actionId: string,
		input?: unknown,
		options?: AppDispatchOptions,
	) => Promise<unknown>;
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
	// Batched, its calls travel the wire binding and its responses come back
	// through the same server channel as signals, so the client reads both in
	// the order the server produced them.
	readonly client: (player: TPlayer) => ClientApp<TSignals>;
	// One frame, with `batching: true`: every client sends the calls it queued
	// (the server dispatches them), then the server channel sends what it queued
	// — the responses to calls that settled, and the signals published since the
	// last step. A call to an action that settles at once is answered in the step
	// that sends it. A no-op unbatched, where nothing waits for a frame.
	readonly step: () => void;
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
> & {
	// Queue wire items until `step()`, as a game queues them until Heartbeat
	// (default false: everything goes out as it is produced).
	readonly batching?: boolean;
};

interface FrameSink<TPlayer extends defined> {
	readonly player: TPlayer;
	readonly deliver: (frame: WireFrame) => void;
}

// The signals a frame carries, as the harness records them. A batched frame also
// carries responses, which are not emits.
function signalsIn(frame: WireFrame): Array<WireSignal> {
	const read = readWireFrame(frame);
	const signals = new Array<WireSignal>();
	if (read.ok) {
		for (const item of read.items) {
			if ((item as { readonly t?: unknown }).t === WIRE_ITEM_SIGNAL) {
				signals.push(item as WireSignal);
			}
		}
	}
	return signals;
}

// A frame scheduler stepped by the harness.
function manualFrames(): WireFrameScheduler & { readonly step: () => void } {
	const listeners = new Array<() => void>();
	return {
		connect: (onFrame) => {
			listeners.push(onFrame);
			return {
				Disconnect: () => {
					const at = listeners.indexOf(onFrame);
					if (at !== -1) {
						listeners.remove(at);
					}
				},
			};
		},
		step: () => {
			for (const listener of [...listeners]) {
				listener();
			}
		},
	};
}

export function createTestServerApp<
	TPlayer extends defined = Player,
	TSignals extends SignalMap = SignalMap,
	TSession = unknown,
>(
	options: CreateTestServerAppOptions<TPlayer, TSignals, TSession>,
): TestServerApp<TPlayer, TSignals> {
	const published = new Array<TestSignalRecord<TPlayer>>();
	// Client-side sinks, so a frame sent to a player reaches the client app the
	// harness built for that player.
	const sinks = new Array<FrameSink<TPlayer>>();
	const batching = options.batching === true;
	// Clients send before the server does, as a call reaches the server within
	// the frame that its response leaves in.
	const clientFrames = manualFrames();
	const serverFrames = manualFrames();

	const recordingRemote = {
		FireClient: (player: TPlayer, frame: WireFrame) => {
			for (const signal of signalsIn(frame)) {
				published.push({ signalId: signal.s, payload: signal.d, player });
			}
			for (const sink of sinks) {
				if (sink.player === player) {
					sink.deliver(frame);
				}
			}
		},
		FireAllClients: (frame: WireFrame) => {
			for (const signal of signalsIn(frame)) {
				published.push({ signalId: signal.s, payload: signal.d });
			}
			for (const sink of sinks) {
				sink.deliver(frame);
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

	const channel = createServerChannel<TPlayer>(
		recordingRemote,
		batching ? { frameScheduler: serverFrames } : { batching: false },
	);
	// Batched, a client's calls arrive here, as frames on the action binding.
	const callHandlers = new Array<(player: TPlayer, frame: unknown) => void>();

	const signals = options.signals;
	// The registry and resource host the app built, captured by the transport:
	// an unbatched client's subscription items go straight through the same
	// admission the wire binding runs.
	let boundRegistry: ActionRegistry<TPlayer> | undefined;
	let boundResources: ResourceHost<TPlayer> | undefined;
	// `batching` rides along in the spread; createServerApp has no such option.
	const app = createServerApp<TPlayer, TSignals, TSession>({
		...options,
		// A spec wants the real failure, not the masked one a client would get.
		exposeInternalErrors: options.exposeInternalErrors ?? true,
		...(ownsClock ? { nowMs: () => clockMs } : {}),
		...(signals !== undefined
			? {
					createPublisher: (registry: TSignals) =>
						createRemoteSignalPublisher<TSignals, TPlayer>(channel, registry),
				}
			: {}),
		...(batching
			? {
					transport: (registry: ActionRegistry<TPlayer>, resources?: ResourceHost<TPlayer>) =>
						bindRemoteActions<TPlayer>(
							registry,
							{
								OnServerEvent: {
									Connect: (callback: (player: TPlayer, frame: unknown) => void) => {
										callHandlers.push(callback);
										return {
											Disconnect: () => {
												const at = callHandlers.indexOf(callback);
												if (at !== -1) {
													callHandlers.remove(at);
												}
											},
										};
									},
								},
							},
							channel,
							resources,
						),
				}
			: options.resources !== undefined
				? {
						transport: (registry: ActionRegistry<TPlayer>, resources?: ResourceHost<TPlayer>) => {
							boundRegistry = registry;
							boundResources = resources;
							if (resources !== undefined) {
								resources.attach(channel);
							}
							return { disconnect: () => {} };
						},
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
	const clientChannels = new Array<ClientChannel>();
	let disposed = false;

	return {
		app,
		invoke: (player, actionId, input, dispatchOptions) =>
			app.dispatch(actionId, { player }, input, dispatchOptions),
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
			// The player's end of the reliable channel: what the server sends this
			// player, read in order by the invoker and the subscriber alike.
			const clientChannel = createClientChannel(
				{
					OnClientEvent: {
						Connect: (callback: (frame: unknown) => void) => {
							const sink: FrameSink<TPlayer> = { player, deliver: callback };
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
				"test client",
			);
			clientChannels.push(clientChannel);
			const transport: ClientTransport = batching
				? createRemoteActionInvoker(
						{
							FireServer: (frame) => {
								for (const handler of [...callHandlers]) {
									handler(player, frame);
								}
							},
						},
						clientChannel,
						{ frameScheduler: clientFrames },
					)
				: // The key `withRetry` minted travels on, as it would over the wire,
					// and an optimistic call is answered with what is still pending
					// before the caller resumes, as its response would be.
					(actionId, input, invokeOptions) => {
						const key = invokeOptions !== undefined ? invokeOptions.idempotencyKey : undefined;
						const optimistic = invokeOptions !== undefined && invokeOptions.optimistic === true;
						const dispatched = app.dispatch(
							actionId,
							{ player },
							input,
							key !== undefined ? { idempotencyKey: key, ...(optimistic ? { optimistic: true } : {}) } : undefined,
						);
						if (!optimistic || key === undefined) {
							return dispatched;
						}
						return dispatched.finally(() => {
							const resources = boundResources;
							answerOptimisticCall(key, resources !== undefined ? resources.pendingTags(player, key) : []);
						});
					};
			// The player's resource client: subscriptions travel the action binding
			// when batched, or straight into the same admission when not; state
			// items come back on the player's channel with everything else.
			let resourceClient: ResourceClient | undefined;
			if (options.resources !== undefined) {
				resourceClient = createResourceClient(
					clientChannel,
					{
						FireServer: (frame) => {
							if (batching) {
								for (const handler of [...callHandlers]) {
									handler(player, frame);
								}
								return;
							}
							const read = readWireFrame(frame);
							const registry = boundRegistry;
							const resources = boundResources;
							if (!read.ok || registry === undefined || resources === undefined) {
								return;
							}
							for (const item of read.items) {
								admitResourceItem(registry, resources, player, item as object);
							}
						},
					},
					batching ? { frameScheduler: clientFrames } : { batching: false },
				);
			}
			const clientApp = createClientApp<TSignals>({
				transport,
				...(resourceClient !== undefined ? { resources: resourceClient } : {}),
				...(signals !== undefined
					? {
							signals,
							createSubscriber: (registry: TSignals) =>
								createRemoteSignalSubscriber<TSignals>(clientChannel, registry),
						}
					: {}),
			});
			clients.push(clientApp);
			return clientApp;
		},
		step: () => {
			clientFrames.step();
			serverFrames.step();
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
			for (const clientChannel of clientChannels) {
				clientChannel.dispose();
			}
			clientChannels.clear();
			sinks.clear();
			app.dispose();
			channel.dispose();
		},
	};
}

// Re-exported so `aruna/testing` is the single entry a spec imports from.
export {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	itSkip,
} from "./testing-framework";
export type {
	Expectation,
	NegatableExpectation,
	RejectsExpectation,
	RunTestsOptions,
	TestBody,
	TestHook,
	TestOutcome,
	TestReport,
} from "./testing-framework";
export {
	createTestNetwork,
	TEST_NETWORK_FRAME_MS,
} from "./testing-network";
export type {
	CreateTestNetworkOptions,
	TestLink,
	TestLinkDirection,
	TestLinkStats,
	TestNetwork,
	TestNetworkClient,
	TestNetworkLatency,
	TestNetworkPlayerSpec,
	TestNetworkSignalRecord,
	TestReliableDirection,
} from "./testing-network";
export {
	createTestStoreBackend,
} from "./testing-store";
export type {
	TestStoreBackend,
	TestStoreRecord,
	TestStoreRecordOptions,
} from "./testing-store";
