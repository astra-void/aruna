// Aruna roblox-ts native runtime — signal registry, publisher, and subscriber.
//
// One RemoteEvent multiplexes every signal by id. The server validates payloads
// against the serialization boundary and the declared schema before firing; the
// client drops payloads that fail schema validation before invoking handlers.

import type { Schema } from "./schema";
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
		throw `invalid signal payload: ${signal.id}`;
	}
}

export function createSignalPublisher<TSignals extends SignalMap, TPlayer>(
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
	};

	return publisher as unknown as SignalPublisher<TSignals, TPlayer>;
}

export function createSignalSubscriber<TSignals extends SignalMap>(
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
