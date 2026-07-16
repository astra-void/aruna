// Aruna roblox-ts native runtime — signal registry, publisher, and subscriber.
//
// One RemoteEvent multiplexes every signal by id. The server validates payloads
// against the serialization boundary and the declared schema before firing; the
// client drops payloads that fail schema validation before invoking handlers.

import { firstSchemaIssue, type Schema } from "./schema";
import type { InferSignalPayload, SignalDefinition } from "./signal";
import { isWireSafe } from "./serialization";

export interface RemoteSignalMessage {
	readonly signalId: string;
	readonly payload: unknown;
}

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

export interface SignalServerLike<TPlayer> {
	readonly FireClient: (player: TPlayer, message: RemoteSignalMessage) => void;
	readonly FireAllClients: (message: RemoteSignalMessage) => void;
}

export interface SignalConnectionLike {
	readonly Disconnect: () => void;
}

export interface SignalClientLike {
	readonly OnClientEvent: {
		readonly Connect: (callback: (message: RemoteSignalMessage) => void) => SignalConnectionLike;
	};
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
	// validation), matching the Node reference runtime's signature.
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
	if (!isWireSafe(payload)) {
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

export function createRemoteSignalPublisher<TSignals extends SignalMap, TPlayer>(
	remote: SignalServerLike<TPlayer>,
	signals: TSignals,
): SignalPublisher<TSignals, TPlayer> {
	const index = buildSignalIndex(signals);

	// Implemented against loose signatures and re-typed on the way out, mirroring
	// the Node reference runtime: inferring the heavy generic publisher surface
	// inside the implementation trips the TS excessive-depth checker.
	const publisher = {
		to: (player: TPlayer, signalId: string, payload: unknown) => {
			const signal = resolveSignal(index, signalId);
			assertPublishable(signal, payload);
			remote.FireClient(player, { signalId, payload });
		},
		toMany: (players: ReadonlyArray<TPlayer>, signalId: string, payload: unknown) => {
			const signal = resolveSignal(index, signalId);
			assertPublishable(signal, payload);
			const message: RemoteSignalMessage = { signalId, payload };
			for (const player of players) {
				remote.FireClient(player, message);
			}
		},
		toAll: (signalId: string, payload: unknown) => {
			const signal = resolveSignal(index, signalId);
			assertPublishable(signal, payload);
			remote.FireAllClients({ signalId, payload });
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
							const payload = payloads[itemIndex];
							assertPublishable(signal, payload);
							remote.FireClient(player, { signalId, payload });

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
	remote: SignalClientLike,
	signals: TSignals,
): SignalSubscriber<TSignals> {
	const index = buildSignalIndex(signals);
	const handlersBySignal = new Map<string, Set<SignalHandler>>();
	let disposed = false;

	const connection = remote.OnClientEvent.Connect((message) => {
		if (!typeIs(message, "table")) {
			return;
		}
		const signalId = message.signalId;
		if (!typeIs(signalId, "string")) {
			return;
		}
		const handlers = handlersBySignal.get(signalId);
		if (handlers === undefined || handlers.size() === 0) {
			return;
		}
		const signal = index.get(signalId);
		const payloadSchema = signal !== undefined ? signal.payload : undefined;
		if (payloadSchema !== undefined && !payloadSchema.validate(message.payload)) {
			return;
		}
		const snapshot: Array<SignalHandler> = [];
		for (const handler of handlers) {
			snapshot.push(handler);
		}
		for (const handler of snapshot) {
			handler(message.payload);
		}
	});

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
			connection.Disconnect();
			handlersBySignal.clear();
		},
	};

	return subscriber as unknown as SignalSubscriber<TSignals>;
}
