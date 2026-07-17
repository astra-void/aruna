// Aruna roblox-ts native runtime — default RemoteEvent action transport.

import {
	ACTION_CANCELLED_ERROR_NAME,
	ACTION_VERSION_MISMATCH_ERROR_NAME,
	type ActionInvoker,
	type ContractHandshakeOptions,
	type VersionMismatchInfo,
} from "./client-runtime";
import type { ActionDefinition } from "./server";
import type { ActionRegistry } from "./server-runtime";
import type { ServerAppBinding, ServerTransport } from "./server-app";
import type { Schema } from "./schema";
import {
	createRemoteSignalPublisher,
	createRemoteSignalSubscriber,
	type SignalClientLike,
	type SignalMap,
	type SignalPublisher,
	type SignalServerLike,
	type SignalSubscriber,
} from "./signal-runtime";

// Roblox-flavored definition helpers. `defineSignal` is unchanged from
// `aruna/server`; `defineAction` defaults `TPlayer` to `Player` so `ctx.player`
// is typed without a per-action annotation. Both are identity functions — the
// `ActionDefinition` import is type-only, so the Luau require graph stays
// acyclic.
export { defineSignal } from "./signal";
// `createActionDefiner` (Player-defaulting) is shared with the `aruna/server`
// surface so a registry-typed `ctx.publisher` is available from either import.
export { createActionDefiner } from "./server";

export function defineAction<
	TInput extends Schema | undefined = undefined,
	TOutput extends Schema | undefined = undefined,
	TPlayer = Player,
	TSignals extends SignalMap = SignalMap,
>(
	definition: ActionDefinition<TInput, TOutput, TPlayer, TSignals>,
): ActionDefinition<TInput, TOutput, TPlayer, TSignals> {
	return definition;
}

export const ACTION_REMOTE_NAME = "ArunaActionRemoteEvent";
export const SIGNAL_REMOTE_NAME = "ArunaSignalRemoteEvent";
export const SIGNAL_UNRELIABLE_REMOTE_NAME = "ArunaSignalUnreliableRemoteEvent";
// Attribute on the action remote where the server advertises its contract hash,
// so a client with a mismatched compiled-in hash can detect a deploy skew.
export const CONTRACT_HASH_ATTRIBUTE_NAME = "ArunaContractHash";

interface ActionResponsePayload {
	readonly ok: boolean;
	readonly output?: unknown;
	readonly error?: string;
	readonly errorName?: string;
	readonly retryAfterMs?: number;
	readonly resetAtMs?: number;
}

// The structured rejection every failed invoke carries: `message` is always
// present; `name` discriminates the failure ("ActionRateLimitError",
// "ActionValidationError", "ActionTimeoutError", ...) and rate limits carry
// `retryAfterMs`/`resetAtMs` so callers can back off instead of string-matching.
export interface ActionError {
	readonly message: string;
	readonly name?: string;
	readonly retryAfterMs?: number;
	readonly resetAtMs?: number;
}

function toActionError(payload: ActionResponsePayload): ActionError {
	return {
		message: payload.error !== undefined ? payload.error : "action failed",
		...(payload.errorName !== undefined ? { name: payload.errorName } : {}),
		...(payload.retryAfterMs !== undefined ? { retryAfterMs: payload.retryAfterMs } : {}),
		...(payload.resetAtMs !== undefined ? { resetAtMs: payload.resetAtMs } : {}),
	};
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

// The default request timeout, applied when requestTimeoutMs is not given.
// Pass requestTimeoutMs: 0 to explicitly opt out (wait forever). Mirrors the
// Node reference runtime.
export const DEFAULT_ACTION_REQUEST_TIMEOUT_MS = 10_000;

export interface CreateActionInvokerOptions extends ContractHandshakeOptions {
	readonly createRequestId?: () => string;
	// Milliseconds to wait for a server response before rejecting with a timeout
	// error. Defaults to DEFAULT_ACTION_REQUEST_TIMEOUT_MS (10s); pass 0 to
	// disable the timeout entirely. Mirrors the Node reference runtime's
	// ActionInvokerOptions.requestTimeoutMs.
	readonly requestTimeoutMs?: number;
}

interface PendingActionRequest {
	readonly resolve: (payload: ActionResponsePayload) => void;
	timeoutThread?: thread;
	// Removes the CancelToken listener when the request settles by any means, so
	// a resolved/timed-out request does not keep the token subscribed.
	unsubscribeCancel?: () => void;
}

export function createActionInvoker(
	options?: CreateActionInvokerOptions,
): ActionInvoker {
	const remote = waitForClientActionRemote();

	// Contract handshake: compare the client's compiled-in hash against the one
	// the server advertised on the action remote. A mismatch fires the callback
	// once; a nil attribute (older server) is unknown, not a mismatch.
	const expectedContractHash = options !== undefined ? options.expectedContractHash : undefined;
	let versionMismatch: VersionMismatchInfo | undefined;
	if (expectedContractHash !== undefined) {
		const actual = remote.GetAttribute(CONTRACT_HASH_ATTRIBUTE_NAME);
		if (typeIs(actual, "string") && actual !== expectedContractHash) {
			versionMismatch = { expected: expectedContractHash, actual };
			if (options !== undefined && options.onVersionMismatch !== undefined) {
				options.onVersionMismatch(versionMismatch);
			}
		}
	}
	const rejectOnMismatch =
		versionMismatch !== undefined && options !== undefined && options.rejectOnMismatch === true;

	const createRequestId =
		options !== undefined && options.createRequestId !== undefined
			? options.createRequestId
			: defaultRequestId;
	// Timeouts are on by default: a dropped response (disconnect, server crash
	// mid-dispatch) must not leave the caller pending forever. 0 opts out.
	const requestTimeoutMs =
		options !== undefined && options.requestTimeoutMs !== undefined
			? options.requestTimeoutMs
			: DEFAULT_ACTION_REQUEST_TIMEOUT_MS;
	const pending = new Map<string, PendingActionRequest>();

	remote.OnClientEvent.Connect((requestId: string, payload: ActionResponsePayload) => {
		const entry = pending.get(requestId);
		if (entry !== undefined) {
			pending.delete(requestId);
			if (entry.timeoutThread !== undefined) {
				task.cancel(entry.timeoutThread);
			}
			if (entry.unsubscribeCancel !== undefined) {
				entry.unsubscribeCancel();
			}
			entry.resolve(payload);
		}
	});

	return (actionId, input, options) => {
		// Hard-block every invoke when the contract hash mismatched and the caller
		// opted into rejecting (rejectOnMismatch); otherwise the mismatch is
		// warn-only via onVersionMismatch and invokes proceed.
		if (rejectOnMismatch && versionMismatch !== undefined) {
			return Promise.reject({
				message: `Aruna contract mismatch: client ${versionMismatch.expected} vs server ${versionMismatch.actual}.`,
				name: ACTION_VERSION_MISMATCH_ERROR_NAME,
			} satisfies ActionError);
		}

		// Fire-and-forget: fire the request and resolve immediately. No pending
		// entry is registered (the server's ignored ack, if any, is dropped) and
		// no timeout is armed. Matches the server binder skipping its response.
		if (options !== undefined && options.fireAndForget === true) {
			const requestId = createRequestId();
			remote.FireServer(requestId, actionId, input);
			return Promise.resolve(undefined);
		}

		return new Promise<unknown>((resolve, reject) => {
			const signal = options !== undefined ? options.signal : undefined;

			// Already cancelled before we fire: reject without touching the wire.
			if (signal !== undefined && signal.isCancelled) {
				reject({
					message: `Aruna action ${actionId} was cancelled.`,
					name: ACTION_CANCELLED_ERROR_NAME,
				} satisfies ActionError);
				return;
			}

			const requestId = createRequestId();
			const entry: PendingActionRequest = {
				resolve: (payload) => {
					if (payload.ok) {
						resolve(payload.output);
					} else {
						reject(toActionError(payload));
					}
				},
			};
			pending.set(requestId, entry);
			remote.FireServer(requestId, actionId, input);

			// The response may have arrived synchronously above; only arm the
			// timeout and cancellation listener while still pending.
			if (pending.get(requestId) !== entry) {
				return;
			}

			if (signal !== undefined) {
				entry.unsubscribeCancel = signal.onCancel(() => {
					if (pending.get(requestId) !== entry) {
						return;
					}
					pending.delete(requestId);
					if (entry.timeoutThread !== undefined) {
						task.cancel(entry.timeoutThread);
					}
					reject({
						message: `Aruna action ${actionId} was cancelled.`,
						name: ACTION_CANCELLED_ERROR_NAME,
					} satisfies ActionError);
				});
			}

			// Arm a timeout only when enabled. task.delay uses seconds.
			if (requestTimeoutMs > 0) {
				entry.timeoutThread = task.delay(requestTimeoutMs / 1000, () => {
					if (pending.get(requestId) !== entry) {
						return;
					}
					pending.delete(requestId);
					if (entry.unsubscribeCancel !== undefined) {
						entry.unsubscribeCancel();
					}
					reject({
						message: `Aruna action ${actionId} timed out after ${requestTimeoutMs}ms.`,
						name: "ActionTimeoutError",
					} satisfies ActionError);
				});
			}
		});
	};
}

// Options for the default Aruna RemoteEvent server transport.
export interface RobloxRemoteEventOptions {
	// The server's contract hash, advertised on the action remote so clients can
	// detect a deploy skew. Pass the generated `contractHash`; omit to advertise
	// nothing (clients then treat this server as unknown, never mismatched).
	readonly contractHash?: string;
}

// Server transport over the default Aruna RemoteEvent, for
// `createServerApp({ transport: robloxRemoteEvent() })`. The native registry
// already bakes `defaultRateLimit` into dispatch, so the transport just binds.
export function robloxRemoteEvent<TPlayer = Player>(
	options?: RobloxRemoteEventOptions,
): ServerTransport<TPlayer> {
	return (registry) =>
		bindActions(registry, options !== undefined ? options.contractHash : undefined);
}

export function bindActions<TPlayer>(
	registry: ActionRegistry<TPlayer>,
	contractHash?: string,
): ServerAppBinding {
	const remote = ensureServerActionRemote();
	// Advertise the contract hash so a client with a mismatched compiled-in hash
	// can surface the skew before it corrupts a payload mid-session.
	if (contractHash !== undefined) {
		remote.SetAttribute(CONTRACT_HASH_ATTRIBUTE_NAME, contractHash);
	}
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

function ensureServerUnreliableSignalRemote(): UnreliableRemoteEvent {
	const storage = getReplicatedStorage();
	const existing = storage.FindFirstChild(SIGNAL_UNRELIABLE_REMOTE_NAME);
	if (existing !== undefined && existing.IsA("UnreliableRemoteEvent")) {
		return existing;
	}

	const remote = new Instance("UnreliableRemoteEvent");
	remote.Name = SIGNAL_UNRELIABLE_REMOTE_NAME;
	remote.Parent = storage;
	return remote;
}

function waitForClientSignalRemote(): RemoteEvent {
	const storage = getReplicatedStorage();
	return storage.WaitForChild(SIGNAL_REMOTE_NAME) as RemoteEvent;
}

function waitForClientUnreliableSignalRemote(): UnreliableRemoteEvent {
	const storage = getReplicatedStorage();
	return storage.WaitForChild(SIGNAL_UNRELIABLE_REMOTE_NAME) as UnreliableRemoteEvent;
}

// Whether any signal in the registry opts into the unreliable channel; the
// dedicated UnreliableRemoteEvent is only created/waited on when one does.
function hasUnreliableSignal(signals: SignalMap): boolean {
	for (const [, definition] of pairs(signals as { [key: string]: { unreliable?: boolean } })) {
		if (definition.unreliable === true) {
			return true;
		}
	}
	return false;
}

type SignalRemoteInstance = RemoteEvent | UnreliableRemoteEvent;

// UnreliableRemoteEvent shares RemoteEvent's structural API, but the nominal
// union can't call methods directly; adapt through the RemoteEvent shape.
function toSignalServerLike(remote: SignalRemoteInstance): SignalServerLike<Player> {
	const fireable = remote as unknown as RemoteEvent;
	return {
		FireClient: (player, message) => {
			fireable.FireClient(player, message);
		},
		FireAllClients: (message) => {
			fireable.FireAllClients(message);
		},
	};
}

function toSignalClientLike(remote: SignalRemoteInstance): SignalClientLike {
	const listenable = remote as unknown as RemoteEvent;
	return {
		OnClientEvent: {
			Connect: (callback) =>
				listenable.OnClientEvent.Connect(callback as (...args: Array<unknown>) => void),
		},
	};
}

// Server-side signal emitter over the default Aruna signal RemoteEvent.
// Registries containing `unreliable: true` signals also get the dedicated
// UnreliableRemoteEvent; those signals route over it automatically.
export function createSignalPublisher<TSignals extends SignalMap>(
	signals: TSignals,
): SignalPublisher<TSignals, Player> {
	const remote = ensureServerSignalRemote();
	const unreliableRemote = hasUnreliableSignal(signals)
		? ensureServerUnreliableSignalRemote()
		: undefined;
	return createRemoteSignalPublisher<TSignals, Player>(
		toSignalServerLike(remote),
		signals,
		unreliableRemote !== undefined ? toSignalServerLike(unreliableRemote) : undefined,
	);
}

// Client-side signal subscriber over the default Aruna signal RemoteEvent (and
// the unreliable channel, when the registry declares unreliable signals).
export function createSignalSubscriber<TSignals extends SignalMap>(
	signals: TSignals,
): SignalSubscriber<TSignals> {
	const remote = waitForClientSignalRemote();
	const unreliableRemote = hasUnreliableSignal(signals)
		? waitForClientUnreliableSignalRemote()
		: undefined;
	return createRemoteSignalSubscriber<TSignals>(
		toSignalClientLike(remote),
		signals,
		unreliableRemote !== undefined ? toSignalClientLike(unreliableRemote) : undefined,
	);
}
