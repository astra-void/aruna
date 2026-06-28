// Aruna roblox-ts native runtime — default RemoteEvent action transport.

import type { ActionInvoker } from "./client-runtime";
import type { ActionDefinition } from "./server";
import type { ActionRegistry } from "./server-runtime";
import type { ServerAppBinding } from "./server-app";
import type { Schema } from "./schema";
import {
	createRemoteSignalPublisher,
	createRemoteSignalSubscriber,
	type SignalMap,
	type SignalPublisher,
	type SignalSubscriber,
} from "./signal-runtime";

// Roblox-flavored definition helpers. `defineSignal` is unchanged from
// `aruna/server`; `defineAction` defaults `TPlayer` to `Player` so `ctx.player`
// is typed without a per-action annotation. Both are identity functions — the
// `ActionDefinition` import is type-only, so the Luau require graph stays
// acyclic.
export { defineSignal } from "./signal";

export function defineAction<
	TInput extends Schema | undefined = undefined,
	TOutput extends Schema | undefined = undefined,
	TPlayer = Player,
>(
	definition: ActionDefinition<TInput, TOutput, TPlayer>,
): ActionDefinition<TInput, TOutput, TPlayer> {
	return definition;
}

const ACTION_REMOTE_NAME = "ArunaActionRemoteEvent";
const SIGNAL_REMOTE_NAME = "ArunaSignalRemoteEvent";

interface ActionResponsePayload {
	readonly ok: boolean;
	readonly output?: unknown;
	readonly error?: string;
}

function getReplicatedStorage(): ReplicatedStorage {
	return game.GetService("ReplicatedStorage");
}

function ensureServerActionRemote(): RemoteEvent {
	const storage = getReplicatedStorage();
	const existing = storage.FindFirstChild(ACTION_REMOTE_NAME);
	if (existing !== undefined && existing.IsA("RemoteEvent")) {
		return existing;
	}

	const remote = new Instance("RemoteEvent");
	remote.Name = ACTION_REMOTE_NAME;
	remote.Parent = storage;
	return remote;
}

function waitForClientActionRemote(): RemoteEvent {
	const storage = getReplicatedStorage();
	return storage.WaitForChild(ACTION_REMOTE_NAME) as RemoteEvent;
}

let requestCounter = 0;
function defaultRequestId(): string {
	requestCounter += 1;
	return `aruna-${requestCounter}`;
}

export interface CreateActionInvokerOptions {
	readonly createRequestId?: () => string;
	// Milliseconds to wait for a server response before rejecting with a timeout
	// error. 0 or undefined (the default) disables the timeout. Mirrors the Node
	// reference runtime's RemoteEventActionInvokerOptions.requestTimeoutMs.
	readonly requestTimeoutMs?: number;
}

interface PendingActionRequest {
	readonly resolve: (payload: ActionResponsePayload) => void;
	timeoutThread?: thread;
}

export function createActionInvoker(
	options?: CreateActionInvokerOptions,
): ActionInvoker {
	const remote = waitForClientActionRemote();
	const createRequestId =
		options !== undefined && options.createRequestId !== undefined
			? options.createRequestId
			: defaultRequestId;
	const requestTimeoutMs =
		options !== undefined && options.requestTimeoutMs !== undefined ? options.requestTimeoutMs : 0;
	const pending = new Map<string, PendingActionRequest>();

	remote.OnClientEvent.Connect((requestId: string, payload: ActionResponsePayload) => {
		const entry = pending.get(requestId);
		if (entry !== undefined) {
			pending.delete(requestId);
			if (entry.timeoutThread !== undefined) {
				task.cancel(entry.timeoutThread);
			}
			entry.resolve(payload);
		}
	});

	return (actionId, input, options) => {
		// Fire-and-forget: fire the request and resolve immediately. No pending
		// entry is registered (the server's ignored ack, if any, is dropped) and
		// no timeout is armed. Matches the server binder skipping its response.
		if (options !== undefined && options.fireAndForget === true) {
			const requestId = createRequestId();
			remote.FireServer(requestId, actionId, input);
			return Promise.resolve(undefined);
		}

		return new Promise<unknown>((resolve, reject) => {
			const requestId = createRequestId();
			const entry: PendingActionRequest = {
				resolve: (payload) => {
					if (payload.ok) {
						resolve(payload.output);
					} else {
						reject(payload.error !== undefined ? payload.error : "action failed");
					}
				},
			};
			pending.set(requestId, entry);
			remote.FireServer(requestId, actionId, input);

			// Arm a timeout only when enabled and still pending (the response may
			// have arrived synchronously above). task.delay uses seconds.
			if (requestTimeoutMs > 0 && pending.get(requestId) === entry) {
				entry.timeoutThread = task.delay(requestTimeoutMs / 1000, () => {
					if (pending.get(requestId) !== entry) {
						return;
					}
					pending.delete(requestId);
					reject(`Aruna action ${actionId} timed out after ${requestTimeoutMs}ms.`);
				});
			}
		});
	};
}

export function bindActions<TPlayer>(
	registry: ActionRegistry<TPlayer>,
): ServerAppBinding {
	const remote = ensureServerActionRemote();
	const connection = remote.OnServerEvent.Connect((player: Player, ...args: Array<unknown>) => {
		const requestId = args[0];
		const actionId = args[1];
		const input = args[2];

		// Drop malformed envelopes from untrusted clients before dispatch.
		if (!typeIs(requestId, "string") || !typeIs(actionId, "string")) {
			return;
		}

		// Fire-and-forget actions are one-way: dispatch still runs (for its side
		// effects and rate limiting), but no response is sent back, since the
		// client is not waiting for one.
		const fireAndForget = registry.isFireAndForget(actionId);
		void registry.dispatch(player as unknown as TPlayer, actionId, input).then((result) => {
			if (!fireAndForget) {
				remote.FireClient(player, requestId, result);
			}
		});
	});

	return {
		disconnect: () => {
			connection.Disconnect();
		},
	};
}

function ensureServerSignalRemote(): RemoteEvent {
	const storage = getReplicatedStorage();
	const existing = storage.FindFirstChild(SIGNAL_REMOTE_NAME);
	if (existing !== undefined && existing.IsA("RemoteEvent")) {
		return existing;
	}

	const remote = new Instance("RemoteEvent");
	remote.Name = SIGNAL_REMOTE_NAME;
	remote.Parent = storage;
	return remote;
}

function waitForClientSignalRemote(): RemoteEvent {
	const storage = getReplicatedStorage();
	return storage.WaitForChild(SIGNAL_REMOTE_NAME) as RemoteEvent;
}

// Server-side signal emitter over the default Aruna signal RemoteEvent.
export function createSignalPublisher<TSignals extends SignalMap>(
	signals: TSignals,
): SignalPublisher<TSignals, Player> {
	const remote = ensureServerSignalRemote();
	return createRemoteSignalPublisher<TSignals, Player>(
		{
			FireClient: (player, message) => {
				remote.FireClient(player, message);
			},
			FireAllClients: (message) => {
				remote.FireAllClients(message);
			},
		},
		signals,
	);
}

// Client-side signal subscriber over the default Aruna signal RemoteEvent.
export function createSignalSubscriber<TSignals extends SignalMap>(
	signals: TSignals,
): SignalSubscriber<TSignals> {
	const remote = waitForClientSignalRemote();
	return createRemoteSignalSubscriber<TSignals>(
		{
			OnClientEvent: {
				Connect: (callback) => remote.OnClientEvent.Connect(callback as (...args: Array<unknown>) => void),
			},
		},
		signals,
	);
}
