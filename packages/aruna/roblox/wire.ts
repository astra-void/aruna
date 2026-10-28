// Aruna roblox-ts native runtime — wire protocol v1 (docs/wire-protocol.md).
//
// Every remote fire carries one frame: an array whose first element is the
// protocol version and whose remaining elements are items. Every item names its
// kind in `t`, so one remote carries several kinds in one ordered stream:
//
//   [1, { t = 1, i, a, d?, k? }, ...]          calls      (client → server)
//   [1, { t = 2, i, r }, { t = 3, s, d? }, ...] responses and signals, interleaved
//                                                         in production order (server → client)
//
// The server end of the reliable remote is one `ServerChannel`: action
// responses and reliable signals for a player share its outbox, so the client
// reads them in the order the server produced them — a signal published inside
// an action's run() always arrives before that action's response. The client
// end is one `ClientChannel`: a single connection that hands each item to the
// handler for its kind, in frame order.
//
// A side queues the items it produces during a frame and fires them together
// once per frame, at RunService.Heartbeat; `batching: false` fires each item in
// its own frame as it is produced instead. Either way the receiver sees the same
// items in the same order. Unreliable signals are never batched: each goes out
// in its own frame on the UnreliableRemoteEvent as soon as it is published, so
// the 900-byte limit applies to one signal, which the compiler can check
// (aruna::510/511/513) and the publisher can measure.

import type { ActionDispatchResult } from "./server-runtime";

// The protocol version a frame carries as its first element. A frame with any
// other version is dropped: reported through `onAbuse` on the server, a dev
// warning on the client.
export const WIRE_PROTOCOL_VERSION = 1;
// The most items one frame may carry, in either direction. A side never sends
// more (a larger batch is split across frames); a server drops a larger frame
// from a client whole, before reading any item.
export const WIRE_MAX_FRAME_ITEMS = 64;

// Every item's kind, in its `t` field. One numbering for both directions, so a
// value never means two things; a value is never reused for another kind.
export const WIRE_ITEM_CALL = 1;
export const WIRE_ITEM_RESPONSE = 2;
export const WIRE_ITEM_SIGNAL = 3;
// Reserved for resource patches (server → client). Nothing sends it yet; a
// client with no handler for a kind skips its items.
export const WIRE_ITEM_RESOURCE_PATCH = 4;

// An action call: request id, action id, input, idempotency key.
export interface WireCall {
	readonly t: typeof WIRE_ITEM_CALL;
	readonly i: string;
	readonly a: string;
	readonly d?: unknown;
	readonly k?: string;
}

// An action response: the request id it answers and the dispatch result.
export interface WireResponse {
	readonly t: typeof WIRE_ITEM_RESPONSE;
	readonly i: string;
	readonly r: ActionDispatchResult;
}

// A signal: its id and its payload (an `encodeBinary` buffer for a binary signal).
export interface WireSignal {
	readonly t: typeof WIRE_ITEM_SIGNAL;
	readonly s: string;
	readonly d?: unknown;
}

// `[WIRE_PROTOCOL_VERSION, ...items]`. Every item is a table, so a frame never
// has a hole.
export type WireFrame = Array<defined>;

export function createWireFrame(items: ReadonlyArray<defined>): WireFrame {
	const frame: WireFrame = [WIRE_PROTOCOL_VERSION];
	for (const item of items) {
		frame.push(item);
	}
	return frame;
}

// Why a frame was dropped whole.
export type WireFrameRejection = "malformed-frame" | "unknown-protocol-version" | "oversize-batch";

export type WireFrameRead =
	| { readonly ok: true; readonly items: ReadonlyArray<defined> }
	| { readonly ok: false; readonly reason: WireFrameRejection };

// Checks a received frame in the order that keeps an untrusted one cheap: its
// shape, its version, then its length — and only then reads its items. An item
// is not validated here; each channel checks its own.
export function readWireFrame(frame: unknown): WireFrameRead {
	if (!typeIs(frame, "table")) {
		return { ok: false, reason: "malformed-frame" };
	}
	const list = frame as ReadonlyArray<defined>;
	const version = list[0];
	if (version === undefined) {
		return { ok: false, reason: "malformed-frame" };
	}
	if (version !== WIRE_PROTOCOL_VERSION) {
		return { ok: false, reason: "unknown-protocol-version" };
	}
	const count = list.size() - 1;
	if (count < 1) {
		return { ok: false, reason: "malformed-frame" };
	}
	if (count > WIRE_MAX_FRAME_ITEMS) {
		return { ok: false, reason: "oversize-batch" };
	}
	// A hole is no item at all; the channel's own check would refuse it anyway.
	const items = new Array<defined>();
	for (let index = 1; index <= count; index += 1) {
		const item = list[index];
		if (item !== undefined) {
			items.push(item);
		}
	}
	return { ok: true, items };
}

// Where a batching side flushes. The default is RunService.Heartbeat: it runs
// after the frame's input handlers, render-step and simulation callbacks, and
// before the engine sends that frame's network traffic, so a frame's items leave
// together at no extra latency. Injectable for tests.
export interface WireFrameScheduler {
	readonly connect: (onFrame: () => void) => { readonly Disconnect: () => void };
}

export const heartbeatFrameScheduler: WireFrameScheduler = {
	connect: (onFrame) => {
		const connection = game.GetService("RunService").Heartbeat.Connect(() => {
			onFrame();
		});
		return {
			Disconnect: () => {
				connection.Disconnect();
			},
		};
	},
};

export interface WireBatchOptions {
	// Queue items and fire them once per frame (default true). False fires each
	// item in its own frame as soon as it is produced.
	readonly batching?: boolean;
	readonly frameScheduler?: WireFrameScheduler;
}

// Everyone, for a broadcast item.
const ALL = {};

interface QueuedItem<TTarget> {
	readonly target: TTarget | typeof ALL;
	readonly item: defined;
}

// A side's outgoing items, queued per recipient and flushed once per frame.
export interface WireOutbox<TTarget> {
	readonly push: (target: TTarget, item: defined) => void;
	// To every recipient at once (FireAllClients).
	readonly pushAll: (item: defined) => void;
	readonly flush: () => void;
	// Flushes what is queued and stops flushing on frames.
	readonly dispose: () => void;
}

export function createWireOutbox<TTarget>(
	send: (target: TTarget, frame: WireFrame) => void,
	sendAll: ((frame: WireFrame) => void) | undefined,
	options?: WireBatchOptions,
): WireOutbox<TTarget> {
	const batching = options === undefined || options.batching !== false;
	let queue = new Array<QueuedItem<TTarget>>();

	// Unbatched, a fire happens inside the call that produced the item, so a
	// failure reaches that caller. Flushed, it happens on a frame no caller is
	// waiting on, and a failed fire (a player who left mid-dispatch, say) must
	// not take the rest of the frame down with it: it is warned about instead.
	const fire = (target: TTarget | typeof ALL, items: ReadonlyArray<defined>, guarded: boolean): void => {
		for (let start = 0; start < items.size(); start += WIRE_MAX_FRAME_ITEMS) {
			const chunk = new Array<defined>();
			for (let index = start; index < math.min(items.size(), start + WIRE_MAX_FRAME_ITEMS); index += 1) {
				chunk.push(items[index]!);
			}
			const frame = createWireFrame(chunk);
			const deliver = (): void => {
				if (target === ALL) {
					if (sendAll !== undefined) {
						sendAll(frame);
					}
				} else {
					send(target as TTarget, frame);
				}
			};
			if (!guarded) {
				deliver();
				continue;
			}
			const [sent, failure] = pcall(deliver);
			if (!sent) {
				warn(`Aruna wire: a frame could not be sent: ${tostring(failure)}`);
			}
		}
	};

	// Groups the queue into as few fires as keep every recipient's order: items
	// for one player are merged across the frame, and a broadcast closes the
	// targeted run before it (and the other way round), since a player receives
	// both.
	const flush = (): void => {
		if (queue.size() === 0) {
			return;
		}
		const taken = queue;
		queue = new Array<QueuedItem<TTarget>>();

		// Targets are boxed: a player double may be anything, and an array holds
		// only defined values.
		let order = new Array<{ readonly target: TTarget }>();
		let byTarget = new Map<TTarget, Array<defined>>();
		let broadcast = new Array<defined>();
		const emitTargeted = (): void => {
			for (const entry of order) {
				fire(entry.target, byTarget.get(entry.target) as Array<defined>, true);
			}
			order = new Array<{ readonly target: TTarget }>();
			byTarget = new Map<TTarget, Array<defined>>();
		};
		const emitBroadcast = (): void => {
			if (broadcast.size() > 0) {
				fire(ALL, broadcast, true);
				broadcast = new Array<defined>();
			}
		};

		for (const queued of taken) {
			if (queued.target === ALL) {
				emitTargeted();
				broadcast.push(queued.item);
			} else {
				emitBroadcast();
				const target = queued.target as TTarget;
				let items = byTarget.get(target);
				if (items === undefined) {
					items = new Array<defined>();
					byTarget.set(target, items);
					order.push({ target });
				}
				items.push(queued.item);
			}
		}
		emitTargeted();
		emitBroadcast();
	};

	const connection = batching
		? (options !== undefined && options.frameScheduler !== undefined
				? options.frameScheduler
				: heartbeatFrameScheduler
			).connect(flush)
		: undefined;

	return {
		push: (target, item) => {
			if (batching) {
				queue.push({ target, item });
			} else {
				fire(target, [item], false);
			}
		},
		pushAll: (item) => {
			if (batching) {
				queue.push({ target: ALL, item });
			} else {
				fire(ALL, [item], false);
			}
		},
		flush,
		dispose: () => {
			flush();
			if (connection !== undefined) {
				connection.Disconnect();
			}
		},
	};
}

// A client's report of a frame it dropped. The default is a warning in Studio,
// once per channel and reason: a mismatched frame cannot come from the game's
// own server (a client always runs its server's build), so it is a development
// problem, not a player-facing one.
export type WireProtocolErrorHandler = (channel: string, reason: WireFrameRejection) => void;

const warned = new Set<string>();

export function defaultWireProtocolErrorHandler(channel: string, reason: WireFrameRejection): void {
	const key = `${channel}:${reason}`;
	if (warned.has(key) || !game.GetService("RunService").IsStudio()) {
		return;
	}
	warned.add(key);
	warn(
		`Aruna wire: dropped a frame on ${channel} (${reason}); this client speaks protocol ${WIRE_PROTOCOL_VERSION}.`,
	);
}

// The server end of a reliable remote: anything with FireClient/FireAllClients
// taking a frame (a RemoteEvent behind an adapter, or a test double).
export interface WireServerRemote<TPlayer> {
	readonly FireClient: (player: TPlayer, frame: WireFrame) => void;
	readonly FireAllClients: (frame: WireFrame) => void;
}

// The server end of the one ordered reliable channel: every server → client
// item for a player — action responses, reliable signals, and later resource
// patches — goes through its outbox, so the player reads them in the order they
// were produced. Use one per remote: two channels on one remote each keep their
// own order, but not each other's.
export type ServerChannel<TPlayer> = WireOutbox<TPlayer>;

export function createServerChannel<TPlayer>(
	remote: WireServerRemote<TPlayer>,
	options?: WireBatchOptions,
): ServerChannel<TPlayer> {
	return createWireOutbox<TPlayer>(
		(player, frame) => {
			remote.FireClient(player, frame);
		},
		(frame) => {
			remote.FireAllClients(frame);
		},
		options,
	);
}

// The client's sending end of a remote: anything with FireServer taking a frame.
export interface WireCallSender {
	readonly FireServer: (frame: WireFrame) => void;
}

// The server's receiving end of a remote: anything whose OnServerEvent hands over
// the sender and each frame. Disconnected with a plain field call, like
// WireClientRemote.
export interface WireCallReceiver<TPlayer> {
	readonly OnServerEvent: {
		readonly Connect: (callback: (player: TPlayer, frame: unknown) => void) => {
			readonly Disconnect: () => void;
		};
	};
}

// The client end of a remote: anything whose OnClientEvent hands over each
// frame. The connection is disconnected with a plain field call, so a real
// RBXScriptConnection goes behind an adapter.
export interface WireClientRemote {
	readonly OnClientEvent: {
		readonly Connect: (callback: (frame: unknown) => void) => { readonly Disconnect: () => void };
	};
}

// What the client reads a remote through: one connection that checks each frame
// and hands every item to the handlers for its kind, in frame order. Handlers
// run synchronously while the frame is read, so a handler for an earlier item
// has returned before a later item — of any kind — is looked at.
export interface ClientChannel {
	// Hands each item of `kind` (a WIRE_ITEM_* value) to `handler`. Returns a
	// function that removes the handler. An item whose kind has no handler is
	// skipped.
	readonly on: (kind: number, handler: (item: object) => void) => () => void;
	// Adds a handler for the frames this channel drops. While there is none, a
	// dropped frame goes to `defaultWireProtocolErrorHandler`. Returns a function
	// that removes the handler.
	readonly onProtocolError: (handler: WireProtocolErrorHandler) => () => void;
	readonly dispose: () => void;
}

function removeFrom<T extends defined>(list: Array<T>, value: T): void {
	const at = list.indexOf(value);
	if (at !== -1) {
		list.remove(at);
	}
}

// `name` is what a protocol error reports the channel as.
export function createClientChannel(remote: WireClientRemote, name: string): ClientChannel {
	const handlersByKind = new Map<number, Array<(item: object) => void>>();
	const errorHandlers = new Array<WireProtocolErrorHandler>();

	const connection = remote.OnClientEvent.Connect((frame) => {
		const read = readWireFrame(frame);
		if (!read.ok) {
			if (errorHandlers.size() === 0) {
				defaultWireProtocolErrorHandler(name, read.reason);
			}
			for (const handler of [...errorHandlers]) {
				handler(name, read.reason);
			}
			return;
		}
		for (const item of read.items) {
			if (!typeIs(item, "table")) {
				continue;
			}
			const kind = (item as { readonly t?: unknown }).t;
			if (!typeIs(kind, "number")) {
				continue;
			}
			const handlers = handlersByKind.get(kind);
			if (handlers === undefined) {
				continue;
			}
			// A copy: a handler may remove itself (or another) mid-item.
			for (const handler of [...handlers]) {
				handler(item);
			}
		}
	});

	return {
		on: (kind, handler) => {
			let handlers = handlersByKind.get(kind);
			if (handlers === undefined) {
				handlers = new Array<(item: object) => void>();
				handlersByKind.set(kind, handlers);
			}
			handlers.push(handler);
			const list = handlers;
			return () => {
				removeFrom(list, handler);
			};
		},
		onProtocolError: (handler) => {
			errorHandlers.push(handler);
			return () => {
				removeFrom(errorHandlers, handler);
			};
		},
		dispose: () => {
			connection.Disconnect();
			handlersByKind.clear();
			errorHandlers.clear();
		},
	};
}
