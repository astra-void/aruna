// Aruna roblox-ts native runtime — a deterministic multiplayer network for specs.
//
// `createTestNetwork` runs one real server app and any number of real client
// apps, joined by simulated links instead of RemoteEvents. Everything between
// them is the shipping code: the wire frames, the action binding (admission,
// request budget, validation, rate limits, middleware, idempotency, error
// masking), the signal publisher and subscriber, and the resource host and
// client. Only the remotes and the clock are fakes, so a spec can put time,
// latency, loss, and disconnects exactly where it wants them.
//
// Time is virtual. Nothing waits on a real clock: `advance(ms)` steps frames
// (each one a Heartbeat, where both sides flush what they queued), delivers
// the frames whose latency has elapsed, and fires the client request timeouts
// that came due. The rate limiter and every other duration read the same clock.
//
// The links keep Roblox's guarantees apart (docs/testing.md#multiplayer-networks):
//
//   * Client → server (`up`) is a RemoteEvent: ordered while connected. A real
//     client can still send anything, so the faults here — drop, duplicate,
//     reorder, a raw frame — model a hostile or broken client, which is what
//     the server must survive.
//   * Server → client reliable (`reliable`) is a RemoteEvent: ordered, never
//     lost while connected. Latency and `hold()` keep that order. `duplicateNext`
//     and `reorderNext` break it on purpose, to test a client's defenses against
//     a transport that misbehaves; Roblox's own does not.
//   * Server → client unreliable (`unreliable`) is an UnreliableRemoteEvent:
//     Roblox may drop or reorder it, so loss and reordering are normal there.
//   * A disconnect drops whatever is in flight both ways, then the player leaves.

import { createClientApp, type ClientApp } from "./client";
import type { ActionInvokeOptions, ClientMiddleware } from "./client-runtime";
import { bindRemoteActions, createRemoteActionInvoker } from "./roblox";
import { createServerApp, type CreateServerAppOptions, type ServerApp } from "./server-app";
import type { ActionRegistry } from "./server-runtime";
import {
	createRemoteSignalPublisher,
	createRemoteSignalSubscriber,
	type SignalMap,
} from "./signal-runtime";
import { createResourceClient, type ResourceClient, type ResourceHost } from "./resource";
import {
	createClientChannel,
	createServerChannel,
	readWireFrame,
	WIRE_ITEM_SIGNAL,
	type WireFrame,
	type WireFrameScheduler,
	type WireSignal,
} from "./wire";

// How long one simulated frame (one Heartbeat) lasts.
export const TEST_NETWORK_FRAME_MS = 16;

export interface TestNetworkPlayerSpec {
	readonly userId: number;
	readonly name?: string;
}

export interface TestNetworkLatency {
	// Client → server, in milliseconds.
	readonly up?: number;
	// Server → client, both the reliable and the unreliable remote.
	readonly down?: number;
}

export type CreateTestNetworkOptions<TSignals extends SignalMap = SignalMap, TSession = unknown> = Omit<
	CreateServerAppOptions<Player, TSignals, TSession>,
	"transport" | "createPublisher" | "players" | "nowMs"
> & {
	// Players who join (and get a client) when the network is created.
	readonly players?: ReadonlyArray<number | TestNetworkPlayerSpec>;
	// A latency for every link, one way: a number for both directions.
	readonly latencyMs?: number | TestNetworkLatency;
	// A client's request timeout, in virtual milliseconds (default 10000; 0 waits
	// forever).
	readonly requestTimeoutMs?: number;
	// The seed for loss rates. The same seed and the same calls give the same
	// drops.
	readonly seed?: number;
	// Middleware every client app runs (a metrics collector's
	// `clientMiddleware()`, for one).
	readonly clientMiddleware?: readonly ClientMiddleware[];
};

// One direction of one player's link.
export interface TestLinkDirection {
	// Drops the next `count` frames on this direction.
	readonly dropNext: (count?: number) => void;
	// Delivers each of the next `count` frames twice.
	readonly duplicateNext: (count?: number) => void;
	// Delivers the next two frames in the opposite order.
	readonly reorderNext: () => void;
	// Drops each frame with this probability (0 to 1), from the network's seed.
	readonly setLoss: (rate: number) => void;
	readonly setLatency: (milliseconds: number) => void;
	readonly stats: () => TestLinkStats;
}

export interface TestReliableDirection extends TestLinkDirection {
	// Stops delivering (frames queue up, in order) until `release()`.
	readonly hold: () => void;
	readonly release: () => void;
}

export interface TestLinkStats {
	readonly sent: number;
	readonly delivered: number;
	readonly dropped: number;
	readonly duplicated: number;
}

export interface TestLink {
	// Client → server.
	readonly up: TestLinkDirection & {
		// Sends a frame as this player's client would, whatever it holds: a
		// hostile client's frame.
		readonly inject: (frame: unknown) => void;
	};
	// Server → client over the reliable remote.
	readonly reliable: TestReliableDirection;
	// Server → client over the unreliable remote.
	readonly unreliable: TestLinkDirection;
}

export interface TestNetworkClient<TSignals extends SignalMap = SignalMap> {
	readonly player: Player;
	readonly userId: number;
	// The real client app: `invoke`, `subscriber`, `resources`.
	readonly app: ClientApp<TSignals>;
	readonly invoke: (actionId: string, input?: unknown, options?: ActionInvokeOptions) => Promise<unknown>;
	readonly resources: ResourceClient;
	// False after a disconnect: nothing reaches or leaves this client any more.
	readonly connected: () => boolean;
}

export interface TestNetworkSignalRecord {
	readonly signalId: string;
	readonly payload: unknown;
	// Absent for a broadcast.
	readonly userId?: number;
	readonly unreliable: boolean;
}

export interface TestNetwork<TSignals extends SignalMap = SignalMap> {
	readonly app: ServerApp<Player, TSignals>;
	// The connected client of a player.
	readonly client: (userId: number) => TestNetworkClient<TSignals>;
	readonly player: (userId: number) => Player;
	readonly link: (userId: number) => TestLink;
	// A new player joins with a fresh client.
	readonly join: (player: number | TestNetworkPlayerSpec) => TestNetworkClient<TSignals>;
	// A clean leave: the client goes away, the server sees the player leave.
	readonly leave: (userId: number) => void;
	// The connection drops: in-flight frames both ways are lost, the client can
	// no longer reach the server (its pending calls time out), and the server
	// sees the player leave.
	readonly disconnect: (userId: number) => void;
	// The same player comes back: a new join with a new client.
	readonly reconnect: (userId: number) => TestNetworkClient<TSignals>;
	// Moves the virtual clock forward one frame at a time, delivering frames
	// and firing timeouts as they come due.
	readonly advance: (milliseconds: number) => void;
	// Steps frames until nothing is in flight or queued (at most `maxFrames`,
	// default 600), and returns how many it stepped.
	readonly flush: (maxFrames?: number) => number;
	readonly now: () => number;
	// Every signal the server put on a link, in order (`takePublished` clears).
	readonly published: () => ReadonlyArray<TestNetworkSignalRecord>;
	readonly takePublished: () => ReadonlyArray<TestNetworkSignalRecord>;
	readonly dispose: () => void;
}

interface ManualFrames extends WireFrameScheduler {
	readonly step: () => void;
}

function manualFrames(): ManualFrames {
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

interface InFlight {
	at: number;
	// Breaks ties between frames due at the same time: the order they were sent.
	seq: number;
	// Set by `reorderNext`: swaps with the next frame sent on its direction
	// (not with its own duplicate: copies share a `send`).
	reorder: boolean;
	readonly send: number;
	readonly direction: DirectionState;
	readonly deliver: () => void;
}

interface DirectionState {
	readonly ordered: boolean;
	latencyMs: number;
	loss: number;
	dropNext: number;
	duplicateNext: number;
	reorderNext: boolean;
	held: boolean;
	// The latest delivery time queued, so an ordered direction never delivers a
	// frame ahead of one sent before it.
	lastAt: number;
	sent: number;
	delivered: number;
	dropped: number;
	duplicated: number;
	readonly inFlight: Array<InFlight>;
}

interface PlayerLink {
	readonly player: Player;
	readonly up: DirectionState;
	readonly reliable: DirectionState;
	readonly unreliable: DirectionState;
	connected: boolean;
	// The client's remotes: where down frames are handed to it.
	readonly reliableSinks: Array<(frame: unknown) => void>;
	readonly unreliableSinks: Array<(frame: unknown) => void>;
	readonly frames: ManualFrames;
	client: TestNetworkClient<SignalMap> | undefined;
	readonly cleanups: Array<() => void>;
}

function direction(ordered: boolean, latencyMs: number): DirectionState {
	return {
		ordered,
		latencyMs,
		loss: 0,
		dropNext: 0,
		duplicateNext: 0,
		reorderNext: false,
		held: false,
		lastAt: 0,
		sent: 0,
		delivered: 0,
		dropped: 0,
		duplicated: 0,
		inFlight: new Array<InFlight>(),
	};
}

function spec(player: number | TestNetworkPlayerSpec): TestNetworkPlayerSpec {
	return typeIs(player, "number") ? { userId: player } : player;
}

export function createTestNetwork<TSignals extends SignalMap = SignalMap, TSession = unknown>(
	options: CreateTestNetworkOptions<TSignals, TSession>,
): TestNetwork<TSignals> {
	let clock = 0;
	let seq = 0;
	let disposed = false;
	// A small LCG: deterministic across runs and platforms.
	let seed = options.seed !== undefined ? options.seed : 1;
	const random = (): number => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648;
	};
	const latency = options.latencyMs;
	const upLatency = latency === undefined ? 0 : typeIs(latency, "number") ? latency : (latency.up ?? 0);
	const downLatency = latency === undefined ? 0 : typeIs(latency, "number") ? latency : (latency.down ?? 0);
	const requestTimeoutMs = options.requestTimeoutMs !== undefined ? options.requestTimeoutMs : 10_000;

	const links = new Map<number, PlayerLink>();
	const published = new Array<TestNetworkSignalRecord>();
	const timers = new Array<{ readonly at: number; readonly seq: number; cancelled: boolean; readonly run: () => void }>();
	const serverFrames = manualFrames();
	// Sends made during the current step, for `flush` to tell when it is settled.
	let sendsThisStep = 0;

	const virtualDelay = (delayMs: number, callback: () => void): (() => void) => {
		seq += 1;
		const timer = { at: clock + delayMs, seq, cancelled: false, run: callback };
		timers.push(timer);
		return () => {
			timer.cancelled = true;
		};
	};

	// Queues `deliver` on a direction, applying its faults. Nothing is delivered
	// on a link that is down.
	const send = (link: PlayerLink, state: DirectionState, deliver: () => void): void => {
		if (disposed || !link.connected) {
			return;
		}
		sendsThisStep += 1;
		state.sent += 1;
		if (state.dropNext > 0) {
			state.dropNext -= 1;
			state.dropped += 1;
			return;
		}
		if (state.loss > 0 && random() < state.loss) {
			state.dropped += 1;
			return;
		}
		const copies = state.duplicateNext > 0 ? 2 : 1;
		seq += 1;
		const sendId = seq;
		if (state.duplicateNext > 0) {
			state.duplicateNext -= 1;
			state.duplicated += 1;
		}
		for (let copy = 0; copy < copies; copy += 1) {
			let at = clock + state.latencyMs;
			if (state.ordered) {
				at = math.max(at, state.lastAt);
				state.lastAt = at;
			}
			seq += 1;
			const reorder = state.reorderNext && copy === 0;
			if (reorder) {
				state.reorderNext = false;
			}
			state.inFlight.push({ at, seq, reorder, send: sendId, direction: state, deliver });
		}
	};

	const allInFlight = (): Array<InFlight> => {
		const entries = new Array<InFlight>();
		for (const [, link] of links) {
			for (const state of [link.up, link.reliable, link.unreliable]) {
				for (const entry of state.inFlight) {
					entries.push(entry);
				}
			}
		}
		return entries;
	};

	// Applies a pending reorder: the marked frame swaps delivery with the frame
	// sent after it, once there is one.
	const applyReorders = (state: DirectionState): void => {
		for (let index = 0; index < state.inFlight.size(); index += 1) {
			const entry = state.inFlight[index]!;
			if (!entry.reorder) {
				continue;
			}
			let partner = -1;
			for (let later = index + 1; later < state.inFlight.size(); later += 1) {
				if (state.inFlight[later]!.send !== entry.send) {
					partner = later;
					break;
				}
			}
			if (partner === -1) {
				continue;
			}
			const following = state.inFlight[partner]!;
			entry.reorder = false;
			const at = entry.at;
			const order = entry.seq;
			entry.at = following.at;
			entry.seq = following.seq;
			following.at = at;
			following.seq = order;
			state.inFlight[index] = following;
			state.inFlight[partner] = entry;
		}
	};

	const deliverDue = (): void => {
		for (;;) {
			let earliest: InFlight | undefined;
			for (const entry of allInFlight()) {
				if (entry.direction.held || entry.at > clock) {
					continue;
				}
				if (earliest === undefined || entry.at < earliest.at || (entry.at === earliest.at && entry.seq < earliest.seq)) {
					earliest = entry;
				}
			}
			if (earliest === undefined) {
				return;
			}
			const list = earliest.direction.inFlight;
			const at = list.indexOf(earliest);
			if (at !== -1) {
				list.remove(at);
			}
			earliest.direction.delivered += 1;
			earliest.deliver();
		}
	};

	const runTimers = (): void => {
		for (;;) {
			let earliest: (typeof timers)[number] | undefined;
			for (const timer of timers) {
				if (timer.at > clock) {
					continue;
				}
				if (earliest === undefined || timer.at < earliest.at || (timer.at === earliest.at && timer.seq < earliest.seq)) {
					earliest = timer;
				}
			}
			if (earliest === undefined) {
				return;
			}
			timers.remove(timers.indexOf(earliest));
			if (!earliest.cancelled) {
				earliest.run();
			}
		}
	};

	const linkOf = (userId: number): PlayerLink => {
		const link = links.get(userId);
		if (link === undefined) {
			error(`Aruna test network: no player with UserId ${userId}`);
		}
		return link;
	};

	const recordSignals = (frame: WireFrame, userId: number | undefined, unreliable: boolean): void => {
		const read = readWireFrame(frame);
		if (!read.ok) {
			return;
		}
		for (const item of read.items) {
			if ((item as { readonly t?: unknown }).t === WIRE_ITEM_SIGNAL) {
				const signal = item as WireSignal;
				published.push({
					signalId: signal.s,
					payload: signal.d,
					...(userId !== undefined ? { userId } : {}),
					unreliable,
				});
			}
		}
	};

	const deliverTo = (sinks: Array<(frame: unknown) => void>, frame: unknown): void => {
		for (const sink of [...sinks]) {
			sink(frame);
		}
	};

	// The server's remotes: frames for a player go onto that player's link.
	const reliableRemote = {
		FireClient: (player: Player, frame: WireFrame) => {
			const link = links.get(player.UserId);
			if (link === undefined) {
				return;
			}
			recordSignals(frame, player.UserId, false);
			send(link, link.reliable, () => deliverTo(link.reliableSinks, frame));
		},
		FireAllClients: (frame: WireFrame) => {
			recordSignals(frame, undefined, false);
			for (const [, link] of links) {
				send(link, link.reliable, () => deliverTo(link.reliableSinks, frame));
			}
		},
	};
	const unreliableRemote = {
		FireClient: (player: Player, frame: WireFrame) => {
			const link = links.get(player.UserId);
			if (link === undefined) {
				return;
			}
			recordSignals(frame, player.UserId, true);
			send(link, link.unreliable, () => deliverTo(link.unreliableSinks, frame));
		},
		FireAllClients: (frame: WireFrame) => {
			recordSignals(frame, undefined, true);
			for (const [, link] of links) {
				send(link, link.unreliable, () => deliverTo(link.unreliableSinks, frame));
			}
		},
	};

	const channel = createServerChannel<Player>(reliableRemote, { frameScheduler: serverFrames });
	const callHandlers = new Array<(player: Player, frame: unknown) => void>();
	const addedHandlers = new Array<(player: Player) => void>();
	const removingHandlers = new Array<(player: Player) => void>();
	const present = new Array<Player>();
	const removeFrom = <T extends defined>(list: Array<T>, value: T): void => {
		const at = list.indexOf(value);
		if (at !== -1) {
			list.remove(at);
		}
	};

	const signals = options.signals;
	const app = createServerApp<Player, TSignals, TSession>({
		...options,
		exposeInternalErrors: options.exposeInternalErrors ?? true,
		nowMs: () => clock,
		...(signals !== undefined
			? {
					createPublisher: (registry: TSignals) =>
						createRemoteSignalPublisher<TSignals, Player>(channel, registry, unreliableRemote),
				}
			: {}),
		transport: (registry: ActionRegistry<Player>, resources?: ResourceHost<Player>) =>
			bindRemoteActions<Player>(
				registry,
				{
					OnServerEvent: {
						Connect: (callback: (player: Player, frame: unknown) => void) => {
							callHandlers.push(callback);
							return { Disconnect: () => removeFrom(callHandlers, callback) };
						},
					},
				},
				channel,
				resources,
			),
		players: {
			PlayerAdded: {
				Connect: (callback: (player: Player) => void) => {
					addedHandlers.push(callback);
					return { Disconnect: () => removeFrom(addedHandlers, callback) };
				},
			},
			PlayerRemoving: {
				Connect: (callback: (player: Player) => void) => {
					removingHandlers.push(callback);
					return { Disconnect: () => removeFrom(removingHandlers, callback) };
				},
			},
			GetPlayers: () => present,
		},
	});

	const toServer = (link: PlayerLink, frame: unknown): void => {
		send(link, link.up, () => {
			for (const handler of [...callHandlers]) {
				handler(link.player, frame);
			}
		});
	};

	const createClient = (link: PlayerLink): TestNetworkClient<TSignals> => {
		const remoteOf = (sinks: Array<(frame: unknown) => void>) => ({
			OnClientEvent: {
				Connect: (callback: (frame: unknown) => void) => {
					sinks.push(callback);
					return { Disconnect: () => removeFrom(sinks, callback) };
				},
			},
		});
		const clientChannel = createClientChannel(remoteOf(link.reliableSinks), `test client ${link.player.UserId}`);
		const sender = { FireServer: (frame: WireFrame) => toServer(link, frame) };
		const resources = createResourceClient(clientChannel, sender, { frameScheduler: link.frames });
		const clientApp = createClientApp<TSignals>({
			transport: createRemoteActionInvoker(sender, clientChannel, {
				frameScheduler: link.frames,
				requestTimeoutMs,
				delay: virtualDelay,
			}),
			resources,
			...(options.clientMiddleware !== undefined ? { middleware: options.clientMiddleware } : {}),
			...(signals !== undefined
				? {
						signals,
						createSubscriber: (registry: TSignals) =>
							createRemoteSignalSubscriber<TSignals>(clientChannel, registry, remoteOf(link.unreliableSinks)),
					}
				: {}),
		});
		link.cleanups.push(() => {
			clientApp.dispose();
			clientChannel.dispose();
		});
		const client: TestNetworkClient<TSignals> = {
			player: link.player,
			userId: link.player.UserId,
			app: clientApp,
			invoke: (actionId, input, invokeOptions) => clientApp.invoke(actionId, input, invokeOptions),
			resources,
			connected: () => link.connected,
		};
		return client;
	};

	const join = (who: number | TestNetworkPlayerSpec): TestNetworkClient<TSignals> => {
		const { userId, name } = spec(who);
		const existing = links.get(userId);
		if (existing !== undefined && existing.connected) {
			error(`Aruna test network: player ${userId} is already connected`);
		}
		// The same Player object across a reconnect, as a test harness reuses one;
		// the server treats the rejoin as a new join either way.
		const player =
			existing !== undefined
				? existing.player
				: ({ Name: name !== undefined ? name : `Player${userId}`, UserId: userId } as unknown as Player);
		const link: PlayerLink = {
			player,
			up: direction(true, upLatency),
			reliable: direction(true, downLatency),
			unreliable: direction(false, downLatency),
			connected: true,
			reliableSinks: new Array(),
			unreliableSinks: new Array(),
			frames: manualFrames(),
			client: undefined,
			cleanups: new Array(),
		};
		links.set(userId, link);
		present.push(player);
		for (const handler of [...addedHandlers]) {
			handler(player);
		}
		const client = createClient(link);
		link.client = client as unknown as TestNetworkClient<SignalMap>;
		return client;
	};

	const drop = (link: PlayerLink): void => {
		for (const state of [link.up, link.reliable, link.unreliable]) {
			state.dropped += state.inFlight.size();
			state.inFlight.clear();
		}
	};

	const departs = (userId: number, clean: boolean): void => {
		const link = linkOf(userId);
		if (!link.connected) {
			return;
		}
		if (clean) {
			// What the client already sent still arrives before the leave.
			deliverDue();
		}
		link.connected = false;
		drop(link);
		removeFrom(present, link.player);
		for (const handler of [...removingHandlers]) {
			handler(link.player);
		}
		if (clean) {
			for (const cleanup of link.cleanups) {
				cleanup();
			}
			link.cleanups.clear();
		}
	};

	const directionApi = (state: DirectionState): TestLinkDirection => ({
		dropNext: (count) => {
			state.dropNext += count !== undefined ? count : 1;
		},
		duplicateNext: (count) => {
			state.duplicateNext += count !== undefined ? count : 1;
		},
		reorderNext: () => {
			state.reorderNext = true;
		},
		setLoss: (rate) => {
			state.loss = math.clamp(rate, 0, 1);
		},
		setLatency: (milliseconds) => {
			state.latencyMs = math.max(0, milliseconds);
		},
		stats: () => ({
			sent: state.sent,
			delivered: state.delivered,
			dropped: state.dropped,
			duplicated: state.duplicated,
		}),
	});

	// One frame at the current time: what is due arrives, clients flush their
	// calls (which arrive at once without latency), the server flushes what it
	// produced, and timeouts that came due fire.
	const step = (): void => {
		for (const [, link] of links) {
			applyReorders(link.up);
			applyReorders(link.reliable);
			applyReorders(link.unreliable);
		}
		deliverDue();
		for (const [, link] of links) {
			if (link.connected) {
				link.frames.step();
			}
		}
		deliverDue();
		serverFrames.step();
		deliverDue();
		runTimers();
	};

	const advance = (milliseconds: number): void => {
		const target = clock + milliseconds;
		while (clock < target) {
			clock = math.min(clock + TEST_NETWORK_FRAME_MS, target);
			step();
		}
	};

	for (const player of options.players !== undefined ? options.players : []) {
		join(player);
	}

	return {
		app,
		client: (userId) => {
			const link = linkOf(userId);
			if (link.client === undefined) {
				error(`Aruna test network: player ${userId} has no client`);
			}
			return link.client as unknown as TestNetworkClient<TSignals>;
		},
		player: (userId) => linkOf(userId).player,
		link: (userId) => {
			const link = linkOf(userId);
			const up = directionApi(link.up);
			const reliable = directionApi(link.reliable);
			return {
				up: {
					...up,
					inject: (frame) => {
						toServer(link, frame);
					},
				},
				reliable: {
					...reliable,
					hold: () => {
						link.reliable.held = true;
					},
					release: () => {
						link.reliable.held = false;
						for (const entry of link.reliable.inFlight) {
							entry.at = math.max(entry.at, clock);
						}
					},
				},
				unreliable: directionApi(link.unreliable),
			};
		},
		join,
		leave: (userId) => departs(userId, true),
		disconnect: (userId) => departs(userId, false),
		reconnect: (userId) => {
			const link = linkOf(userId);
			if (link.connected) {
				departs(userId, false);
			}
			// The old client is gone for good: its process ended with the connection.
			for (const cleanup of link.cleanups) {
				cleanup();
			}
			link.cleanups.clear();
			return join({ userId, name: link.player.Name });
		},
		advance,
		flush: (maxFrames) => {
			const limit = maxFrames !== undefined ? maxFrames : 600;
			for (let frame = 1; frame <= limit; frame += 1) {
				sendsThisStep = 0;
				advance(TEST_NETWORK_FRAME_MS);
				let waiting = sendsThisStep > 0;
				for (const entry of allInFlight()) {
					if (!entry.direction.held) {
						waiting = true;
					}
				}
				if (!waiting) {
					return frame;
				}
			}
			return limit;
		},
		now: () => clock,
		published: () => published,
		takePublished: () => {
			const taken = [...published];
			published.clear();
			return taken;
		},
		dispose: () => {
			if (disposed) {
				return;
			}
			for (const [, link] of links) {
				for (const cleanup of link.cleanups) {
					cleanup();
				}
				link.cleanups.clear();
			}
			app.dispose();
			channel.dispose();
			disposed = true;
			links.clear();
			timers.clear();
		},
	};
}
