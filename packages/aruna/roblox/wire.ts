// Aruna roblox-ts native runtime — wire protocol v1 (docs/wire-protocol.md).
//
// Every remote fire carries one frame: an array whose first element is the
// protocol version and whose remaining elements are items — action calls
// (client → server), action responses (server → client), or signals (server →
// client), depending on the remote and the direction. A side queues the items
// it produces during a frame and fires them together once per frame, at
// RunService.Heartbeat; `batching: false` fires each item in its own frame as
// it is produced instead. Either way the receiver sees the same frames.
//
//   [1, { i, a, d?, k? }, ...]   calls      (action remote, client → server)
//   [1, { i, r }, ...]           responses  (action remote, server → client)
//   [1, { s, d? }, ...]          signals    (signal remotes, server → client)
//
// Unreliable signals are never batched: each goes out in its own frame as soon
// as it is published, so the 900-byte limit applies to one signal, which the
// compiler can check (aruna::510/511/513) and the publisher can measure.

import type { ActionDispatchResult } from "./server-runtime";

// The protocol version a frame carries as its first element. A frame with any
// other version is dropped: reported through `onAbuse` on the server, a dev
// warning on the client.
export const WIRE_PROTOCOL_VERSION = 1;
// The most items one frame may carry, in either direction. A side never sends
// more (a larger batch is split across frames); a server drops a larger frame
// from a client whole, before reading any item.
export const WIRE_MAX_FRAME_ITEMS = 64;

// An action call: request id, action id, input, idempotency key.
export interface WireCall {
	readonly i: string;
	readonly a: string;
	readonly d?: unknown;
	readonly k?: string;
}

// An action response: the request id it answers and the dispatch result.
export interface WireResponse {
	readonly i: string;
	readonly r: ActionDispatchResult;
}

// A signal: its id and its payload (an `encodeBinary` buffer for a binary signal).
export interface WireSignal {
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
