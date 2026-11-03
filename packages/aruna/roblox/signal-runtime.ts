// Aruna roblox-ts native runtime — signal registry, publisher, and subscriber.
//
// Signals travel as wire items (docs/wire-protocol.md). A reliable signal joins
// the server channel's outbox — the same one action responses use, so a player
// reads both in the order they were produced; an unreliable one goes out at once,
// alone in its frame, on the UnreliableRemoteEvent. The server validates payloads
// against the serialization boundary and the declared schema before queueing
// them; the client drops payloads that fail schema validation before invoking
// handlers.

import type { Schema } from "./schema";
import { firstSchemaIssue } from "./schema-check";
import type { InferSignalPayload, SignalDefinition } from "./signal";
import { isWireSafe } from "./serialization";
import { decodeBinary, encodeBinary } from "./binary";
import {
	createClientChannel,
	createWireFrame,
	WIRE_ITEM_SIGNAL,
	type ClientChannel,
	type ServerChannel,
	type WireClientRemote,
	type WireProtocolErrorHandler,
	type WireServerRemote,
	type WireSignal,
} from "./wire";

export type SignalMap = { readonly [signalId: string]: SignalDefinition<Schema | undefined> };

type SignalId<TSignals extends SignalMap> = keyof TSignals & string;

// Payload type for a given signal id, derived from the registry's declared
// schema. A signal with no payload schema resolves to `unknown`. Generated
// registries (`export const signals = { ... } as const`) carry the precise
// definitions, so callers get fully typed payloads without `unknown` casts.
type SignalPayloadOf<TSignals extends SignalMap, TId extends SignalId<TSignals>> =
	TSignals[TId] extends SignalDefinition<infer TPayload>
		? InferSignalPayload<TPayload>
		: unknown;

// The unreliable remote the publisher fires frames on: an UnreliableRemoteEvent
// behind an adapter, or a test double.
export type SignalServerLike<TPlayer> = WireServerRemote<TPlayer>;

// The unreliable remote the subscriber reads frames from.
export type SignalClientLike = WireClientRemote;

export interface SignalSubscriberOptions {
	// Called for a frame this client drops (docs/wire-protocol.md), on either
	// remote. Without it, the channel's default: a warning in Studio.
	readonly onProtocolError?: WireProtocolErrorHandler;
}

export interface RemoteSignalConnection {
	readonly disconnect: () => void;
}

export type SignalHandler<TPayload = unknown> = (payload: TPayload) => void;

// Options for `toBatched`. `chunkSize` caps how many payloads go out before a
// yield; `yield` swaps the wait strategy (defaults to `task.wait()`).
export interface SignalBatchOptions {
	readonly chunkSize?: number;
	readonly yield?: () => void;
}

const DEFAULT_BATCH_CHUNK_SIZE = 50;

function defaultBatchYield(): void {
	task.wait();
}

export interface SignalPublisher<TSignals extends SignalMap, TPlayer> {
	readonly to: <TId extends SignalId<TSignals>>(
		player: TPlayer,
		signalId: TId,
		payload: SignalPayloadOf<TSignals, TId>,
	) => void;
	readonly toMany: <TId extends SignalId<TSignals>>(
		players: ReadonlyArray<TPlayer>,
		signalId: TId,
		payload: SignalPayloadOf<TSignals, TId>,
	) => void;
	readonly toAll: <TId extends SignalId<TSignals>>(
		signalId: TId,
		payload: SignalPayloadOf<TSignals, TId>,
	) => void;
	// Sends a large payload batch to a single player in fixed-size chunks,
	// yielding (`task.wait()` by default) between chunks instead of firing
	// every payload in one tick. Meant for bulk one-time sends (e.g. late-join
	// replay of a stored broadcast log) where firing hundreds/thousands of
	// messages synchronously would spike outbound bandwidth for that frame.
	// Resolves after the last chunk is sent (rejects if a payload fails
	// validation).
	readonly toBatched: <TId extends SignalId<TSignals>>(
		player: TPlayer,
		signalId: TId,
		payloads: ReadonlyArray<SignalPayloadOf<TSignals, TId>>,
		options?: SignalBatchOptions,
	) => Promise<void>;
}

export interface SignalSubscriber<TSignals extends SignalMap> {
	readonly on: <TId extends SignalId<TSignals>>(
		signalId: TId,
		handler: SignalHandler<SignalPayloadOf<TSignals, TId>>,
	) => RemoteSignalConnection;
	readonly dispose: () => void;
}

function buildSignalIndex(signals: SignalMap): Map<string, SignalDefinition<Schema | undefined>> {
	const index = new Map<string, SignalDefinition<Schema | undefined>>();
	for (const [signalId, definition] of pairs(
		signals as { [key: string]: SignalDefinition<Schema | undefined> },
	)) {
		index.set(signalId as string, definition);
	}
	return index;
}

function resolveSignal(
	index: Map<string, SignalDefinition<Schema | undefined>>,
	signalId: string,
): SignalDefinition<Schema | undefined> {
	const signal = index.get(signalId);
	if (signal === undefined) {
		throw `Aruna signal not found: ${signalId}`;
	}
	return signal;
}

function assertPublishable(signal: SignalDefinition<Schema | undefined>, payload: unknown): void {
	// Server-authored, so not held to the node budget that bounds a client's input.
	if (!isWireSafe(payload, math.huge, signal.payload)) {
		throw `non-serializable signal payload: ${signal.id}`;
	}
	const payloadSchema = signal.payload;
	if (payloadSchema !== undefined && !payloadSchema.validate(payload)) {
		const issue = firstSchemaIssue(payloadSchema, payload);
		throw issue !== undefined
			? `invalid signal payload: ${signal.id} (${issue})`
			: `invalid signal payload: ${signal.id}`;
	}
}

// Roblox drops an unreliable message over this size without an error.
export const UNRELIABLE_PAYLOAD_LIMIT_BYTES = 900;
// What an unreliable signal's frame, `[1, { t = 3, s, d }]`, costs on top of the
// payload and the signal id's own bytes: 8 bytes for each of its nine values
// (the frame, the version, the item, three keys, the kind, the id, the payload)
// plus the three one-byte keys. docs/wire-protocol.md has the accounting; the
// compiler's WIRE_SIGNAL_FRAME_OVERHEAD_BYTES
// (crates/aruna_compiler/src/payload_size.rs) is the same number.
export const SIGNAL_FRAME_OVERHEAD_BYTES = 75;

// The payload as it goes on the wire: an `encodeBinary` buffer for a binary
// signal, the value itself otherwise. Validated first, so the encoder only ever
// sees a conforming value. A binary frame's size is exact, so an unreliable one
// that would be dropped for size is refused here, with the message aruna::511
// uses at compile time; a frame can only get there when the schema leaves the
// payload unbounded (aruna::510).
function wirePayload(
	signal: SignalDefinition<Schema | undefined>,
	signalId: string,
	payload: unknown,
): unknown {
	const payloadSchema = signal.payload;
	if (signal.wire !== "binary" || payloadSchema === undefined) {
		return payload;
	}
	const frame = encodeBinary(payloadSchema, payload);
	if (signal.unreliable === true) {
		const size = buffer.len(frame) + signalId.size() + SIGNAL_FRAME_OVERHEAD_BYTES;
		if (size > UNRELIABLE_PAYLOAD_LIMIT_BYTES) {
			throw `Unreliable signal ${signalId} carries ${size} bytes, over Roblox's ${UNRELIABLE_PAYLOAD_LIMIT_BYTES}-byte unreliable limit; larger payloads are dropped without an error.`;
		}
	}
	return frame;
}

// A binary signal's payload as its handlers receive it: decoded, or `ok` false
// when the bytes are not a frame of this schema (another schema version's
// fingerprint, a truncated buffer, not a buffer at all) — dropped the way a
// schema mismatch is.
function readWirePayload(
	signal: SignalDefinition<Schema | undefined>,
	payload: unknown,
): { readonly ok: boolean; readonly value?: unknown } {
	const payloadSchema = signal.payload;
	if (signal.wire !== "binary" || payloadSchema === undefined) {
		return { ok: true, value: payload };
	}
	if (!typeIs(payload, "buffer")) {
		return { ok: false };
	}
	const [decoded, value] = pcall(() => decodeBinary(payloadSchema, payload));
	return decoded ? { ok: true, value } : { ok: false };
}

export function createRemoteSignalPublisher<TSignals extends SignalMap, TPlayer>(
	// The server end of the reliable channel. Reliable signals join its outbox,
	// behind whatever the player was already sent this frame (an action
	// response, another signal); its batching options decide when they leave.
	channel: ServerChannel<TPlayer>,
	signals: TSignals,
	// The unreliable remote (an UnreliableRemoteEvent in the default wiring).
	// Signals declared `unreliable: true` go out on it, never batched; without
	// it they travel the reliable channel like any other signal.
	unreliableRemote?: SignalServerLike<TPlayer>,
): SignalPublisher<TSignals, TPlayer> {
	const index = buildSignalIndex(signals);

	const deliver = (
		signal: SignalDefinition<Schema | undefined>,
		players: ReadonlyArray<TPlayer> | undefined,
		item: WireSignal,
	): void => {
		// An unreliable signal goes out at once, alone in its frame: its size is
		// then one signal's, which is what the 900-byte checks measure.
		const wire = signal.unreliable === true ? unreliableRemote : undefined;
		if (wire !== undefined) {
			const frame = createWireFrame([item]);
			if (players === undefined) {
				wire.FireAllClients(frame);
			} else {
				for (const player of players) {
					wire.FireClient(player, frame);
				}
			}
			return;
		}
		if (players === undefined) {
			channel.pushAll(item);
		} else {
			for (const player of players) {
				channel.push(player, item);
			}
		}
	};

	const itemFor = (signal: SignalDefinition<Schema | undefined>, signalId: string, payload: unknown): WireSignal => {
		assertPublishable(signal, payload);
		return { t: WIRE_ITEM_SIGNAL, s: signalId, d: wirePayload(signal, signalId, payload) };
	};

	// Implemented against loose signatures and re-typed on the way out:
	// inferring the heavy generic publisher surface
	// inside the implementation trips the TS excessive-depth checker.
	const publisher = {
		to: (player: TPlayer, signalId: string, payload: unknown) => {
			const signal = resolveSignal(index, signalId);
			deliver(signal, [player], itemFor(signal, signalId, payload));
		},
		toMany: (players: ReadonlyArray<TPlayer>, signalId: string, payload: unknown) => {
			const signal = resolveSignal(index, signalId);
			deliver(signal, players, itemFor(signal, signalId, payload));
		},
		toAll: (signalId: string, payload: unknown) => {
			const signal = resolveSignal(index, signalId);
			deliver(signal, undefined, itemFor(signal, signalId, payload));
		},
		toBatched: (
			player: TPlayer,
			signalId: string,
			payloads: ReadonlyArray<unknown>,
			options?: SignalBatchOptions,
		) => {
			const signal = resolveSignal(index, signalId);
			const chunkSize = options?.chunkSize ?? DEFAULT_BATCH_CHUNK_SIZE;
			const yieldBetweenChunks = options?.yield ?? defaultBatchYield;

			// The chunk loop yields between chunks, so it runs on its own thread;
			// the returned promise settles when the last chunk went out (or a
			// payload failed validation). Promise.new executors must not yield,
			// hence the task.spawn indirection.
			return new Promise<void>((resolve, reject) => {
				task.spawn(() => {
					const [sent, failure] = pcall(() => {
						for (let itemIndex = 0; itemIndex < payloads.size(); itemIndex += 1) {
							deliver(signal, [player], itemFor(signal, signalId, payloads[itemIndex]));

							const isChunkBoundary = (itemIndex + 1) % chunkSize === 0;
							if (isChunkBoundary && itemIndex + 1 < payloads.size()) {
								yieldBetweenChunks();
							}
						}
					});
					if (sent) {
						resolve();
					} else {
						reject(failure);
					}
				});
			});
		},
	};

	return publisher as unknown as SignalPublisher<TSignals, TPlayer>;
}

export function createRemoteSignalSubscriber<TSignals extends SignalMap>(
	// The client end of the reliable channel, shared with the action invoker so
	// signals and responses are handled in the order they were sent.
	channel: ClientChannel,
	signals: TSignals,
	// The unreliable remote; unreliable signals arrive here in the default
	// wiring. The same handler fan-out serves both.
	unreliableRemote?: SignalClientLike,
	options?: SignalSubscriberOptions,
): SignalSubscriber<TSignals> {
	const index = buildSignalIndex(signals);
	const handlersBySignal = new Map<string, Set<SignalHandler>>();
	let disposed = false;

	const onSignal = (item: object): void => {
		const message = item as Partial<WireSignal>;
		const signalId = message.s;
		if (!typeIs(signalId, "string")) {
			return;
		}
		const handlers = handlersBySignal.get(signalId);
		if (handlers === undefined || handlers.size() === 0) {
			return;
		}
		const signal = index.get(signalId);
		const read = signal !== undefined ? readWirePayload(signal, message.d) : { ok: true, value: message.d };
		if (!read.ok) {
			return;
		}
		const payload = read.value;
		const payloadSchema = signal !== undefined ? signal.payload : undefined;
		if (payloadSchema !== undefined && !payloadSchema.validate(payload)) {
			return;
		}
		const snapshot: Array<SignalHandler> = [];
		for (const handler of handlers) {
			snapshot.push(handler);
		}
		for (const handler of snapshot) {
			handler(payload);
		}
	};

	// The unreliable remote carries nothing but signals; it is read through a
	// channel of its own, owned (and disposed) by this subscriber.
	const unreliableChannel =
		unreliableRemote !== undefined ? createClientChannel(unreliableRemote, "unreliable signals") : undefined;
	const cleanups = new Array<() => void>();
	cleanups.push(channel.on(WIRE_ITEM_SIGNAL, onSignal));
	if (unreliableChannel !== undefined) {
		cleanups.push(unreliableChannel.on(WIRE_ITEM_SIGNAL, onSignal));
	}
	if (options !== undefined && options.onProtocolError !== undefined) {
		cleanups.push(channel.onProtocolError(options.onProtocolError));
		if (unreliableChannel !== undefined) {
			cleanups.push(unreliableChannel.onProtocolError(options.onProtocolError));
		}
	}

	const subscriber = {
		on: (signalId: string, handler: SignalHandler) => {
			if (disposed) {
				throw "Aruna signal subscriber is disposed.";
			}
			let handlers = handlersBySignal.get(signalId);
			if (handlers === undefined) {
				handlers = new Set<SignalHandler>();
				handlersBySignal.set(signalId, handlers);
			}
			handlers.add(handler);
			let connected = true;
			return {
				disconnect: () => {
					if (!connected) {
						return;
					}
					connected = false;
					handlers.delete(handler);
				},
			};
		},
		dispose: () => {
			if (disposed) {
				return;
			}
			disposed = true;
			for (const cleanup of cleanups) {
				cleanup();
			}
			cleanups.clear();
			if (unreliableChannel !== undefined) {
				unreliableChannel.dispose();
			}
			handlersBySignal.clear();
		},
	};

	return subscriber as unknown as SignalSubscriber<TSignals>;
}
