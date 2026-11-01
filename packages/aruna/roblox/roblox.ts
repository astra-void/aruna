// Aruna roblox-ts native runtime — default RemoteEvent action transport.

import {
	ACTION_CANCELLED_ERROR_NAME,
	ACTION_VERSION_MISMATCH_ERROR_NAME,
	type ActionInvoker,
	type ContractHandshakeOptions,
	type VersionMismatchInfo,
} from "./client-runtime";
import type { ActionDefinition, ActionErrorMap } from "./server";
import type { ActionRegistry } from "./server-runtime";
import type { ServerAppBinding, ServerTransport } from "./server-app";
import type { Schema } from "./schema";
import {
	admitResourceItem,
	createResourceClient as createChannelResourceClient,
	type ResourceClient,
	type ResourceClientOptions,
	type ResourceDefinition,
	type ResourceHost,
	type ResourceScope,
} from "./resource";
import {
	createRemoteSignalPublisher,
	createRemoteSignalSubscriber,
	type SignalClientLike,
	type SignalMap,
	type SignalPublisher,
	type SignalServerLike,
	type SignalSubscriber,
} from "./signal-runtime";
import {
	createClientChannel,
	createServerChannel,
	createWireOutbox,
	readWireFrame,
	WIRE_ITEM_CALL,
	WIRE_ITEM_RESOURCE_SUBSCRIPTION,
	WIRE_ITEM_RESPONSE,
	type ClientChannel,
	type ServerChannel,
	type WireBatchOptions,
	type WireCall,
	type WireCallReceiver,
	type WireCallSender,
	type WireClientRemote,
	type WireProtocolErrorHandler,
	type WireResponse,
	type WireServerRemote,
} from "./wire";

// Roblox-flavored definition helpers. `defineSignal` is unchanged from
// `aruna/server`; `defineAction` defaults `TPlayer` to `Player` so `ctx.player`
// is typed without a per-action annotation. Both are identity functions — the
// `ActionDefinition` import is type-only, so the Luau require graph stays
// acyclic.
export { defineSignal } from "./signal";
// `createActionDefiner` (Player-defaulting) is shared with the `aruna/server`
// surface so a registry-typed `ctx.publisher` is available from either import.
export { createActionDefiner } from "./server";
// Store definitions are identical on both surfaces; `definePlayerStore` already
// defaults its player to `Player`.
export { defineStore, definePlayerStore } from "./define-store";
// Also on `aruna/server`: the error an action throws when the client should see
// its name and message.
export { actionError } from "./action-error";
export type { PublicActionError } from "./action-error";
// The lower-level signal endpoints over a remote you supply yourself (anything
// with FireClient/FireAllClients, or OnClientEvent). `createSignalPublisher` /
// `createSignalSubscriber` below wrap them around the default Aruna remotes.
export { createRemoteSignalPublisher, createRemoteSignalSubscriber };
// The resource client over a channel and sender you supply, for a remote you
// wire yourself (the test harness does).
export { createChannelResourceClient as createRemoteResourceClient };
export type {
	ResourceBinding,
	ResourceClient,
	ResourceClientOptions,
	ResourceListener,
	ResourceStatus,
	ResourceSubscribeOptions,
	ResourceSubscription,
	ResourceUpdateInfo,
} from "./resource";
export type {
	SignalClientLike,
	SignalMap,
	SignalPublisher,
	SignalServerLike,
	SignalSubscriber,
	SignalSubscriberOptions,
} from "./signal-runtime";
// The DataStoreService adapter. Roblox-only by nature, so it lives on this entry
// rather than `aruna/server`, alongside the RemoteEvent transport.
export * from "./datastore";
// The wire protocol the transports speak (docs/wire-protocol.md): the frame
// codec and the per-frame outbox, for a remote you wire yourself.
export * from "./wire";

// `defineResource` with the player typed as `Player`, as `defineAction` here is.
export function defineResource<
	TId extends string,
	TSchema extends Schema,
	TScope extends ResourceScope = "player",
	TPlayer = Player,
>(
	definition: ResourceDefinition<TSchema, TId, TScope, TPlayer>,
): ResourceDefinition<TSchema, TId, TScope, TPlayer> {
	return definition;
}

export function defineAction<
	TInput extends Schema | undefined = undefined,
	TOutput extends Schema | undefined = undefined,
	TPlayer = Player,
	TSignals extends SignalMap = SignalMap,
	TErrors extends ActionErrorMap = {},
>(
	definition: ActionDefinition<TInput, TOutput, TPlayer, TSignals, TErrors>,
): ActionDefinition<TInput, TOutput, TPlayer, TSignals, TErrors> {
	return definition;
}

// The one reliable remote: action calls one way; action responses and reliable
// signals the other, through one ordered channel per player
// (docs/wire-protocol.md).
export const REMOTE_NAME = "ArunaRemoteEvent";
export const SIGNAL_UNRELIABLE_REMOTE_NAME = "ArunaSignalUnreliableRemoteEvent";
// Attribute on the remote where the server advertises its contract hash, so a
// client with a mismatched compiled-in hash can detect a deploy skew.
export const CONTRACT_HASH_ATTRIBUTE_NAME = "ArunaContractHash";

interface ActionResponsePayload {
	readonly ok: boolean;
	readonly output?: unknown;
	readonly error?: string;
	readonly errorName?: string;
	readonly retryAfterMs?: number;
	readonly resetAtMs?: number;
	readonly errorId?: string;
	readonly errorData?: unknown;
}

// The structured rejection every failed invoke carries: `message` is always
// present; `name` discriminates the failure ("ActionRateLimitError",
// "ActionValidationError", "ActionTimeoutError", ...) and rate limits carry
// `retryAfterMs`/`resetAtMs` so callers can back off instead of string-matching.
// An `ActionInternalError` carries `errorId`, which the server's `onError` got
// for the same failure. An error the action declares with data carries it as
// `data`; `isActionError` (aruna/client) narrows it to the declared type.
export interface ActionError {
	readonly message: string;
	readonly name?: string;
	readonly retryAfterMs?: number;
	readonly resetAtMs?: number;
	readonly errorId?: string;
	readonly data?: unknown;
}

function toActionError(payload: ActionResponsePayload): ActionError {
	return {
		message: payload.error !== undefined ? payload.error : "action failed",
		...(payload.errorName !== undefined ? { name: payload.errorName } : {}),
		...(payload.retryAfterMs !== undefined ? { retryAfterMs: payload.retryAfterMs } : {}),
		...(payload.resetAtMs !== undefined ? { resetAtMs: payload.resetAtMs } : {}),
		...(payload.errorId !== undefined ? { errorId: payload.errorId } : {}),
		...(payload.errorData !== undefined ? { data: payload.errorData } : {}),
	};
}

function getReplicatedStorage(): ReplicatedStorage {
	return game.GetService("ReplicatedStorage");
}

function ensureServerRemote(): RemoteEvent {
	const storage = getReplicatedStorage();
	const existing = storage.FindFirstChild(REMOTE_NAME);
	if (existing !== undefined && existing.IsA("RemoteEvent")) {
		return existing;
	}

	const remote = new Instance("RemoteEvent");
	remote.Name = REMOTE_NAME;
	remote.Parent = storage;
	return remote;
}

function waitForClientRemote(): RemoteEvent {
	const storage = getReplicatedStorage();
	return storage.WaitForChild(REMOTE_NAME) as RemoteEvent;
}

// Adapters from a real remote to the wire's structural ends. A RemoteEvent's
// members are methods and an RBXScriptConnection's Disconnect is too, while the
// wire calls plain fields; each adapter is typed at the Roblox side so roblox-ts
// emits a method call there.
function serverRemoteOf(remote: RemoteEvent): WireServerRemote<Player> {
	return {
		FireClient: (player, frame) => {
			remote.FireClient(player, frame);
		},
		FireAllClients: (frame) => {
			remote.FireAllClients(frame);
		},
	};
}

function clientRemoteOf(remote: RemoteEvent): WireClientRemote {
	return {
		OnClientEvent: {
			Connect: (callback) => {
				const connection = remote.OnClientEvent.Connect((frame: unknown) => {
					callback(frame);
				});
				return {
					Disconnect: () => {
						connection.Disconnect();
					},
				};
			},
		},
	};
}

function callSenderOf(remote: RemoteEvent): WireCallSender {
	return {
		FireServer: (frame) => {
			remote.FireServer(frame);
		},
	};
}

function callReceiverOf(remote: RemoteEvent): WireCallReceiver<Player> {
	return {
		OnServerEvent: {
			Connect: (callback) => {
				const connection = remote.OnServerEvent.Connect((player: Player, frame: unknown) => {
					callback(player, frame);
				});
				return {
					Disconnect: () => {
						connection.Disconnect();
					},
				};
			},
		},
	};
}

// One channel per remote, end to end: every default-wired producer on the server
// (robloxRemoteEvent, createSignalPublisher) shares the remote's server channel,
// and every default-wired consumer on the client (createActionInvoker,
// createSignalSubscriber) its client channel. Two outboxes on one remote would
// each keep their own order but not each other's, which is the reordering this
// rules out. Keyed by the instance, so a remote that was replaced gets fresh
// channels.
const serverChannels = new Map<RemoteEvent, ServerChannel<Player>>();
const clientChannels = new Map<RemoteEvent, ClientChannel>();

function defaultServerChannel(remote: RemoteEvent): ServerChannel<Player> {
	let channel = serverChannels.get(remote);
	if (channel === undefined) {
		channel = createServerChannel(serverRemoteOf(remote));
		serverChannels.set(remote, channel);
	}
	return channel;
}

function defaultClientChannel(remote: RemoteEvent): ClientChannel {
	let channel = clientChannels.get(remote);
	if (channel === undefined) {
		channel = createClientChannel(clientRemoteOf(remote), remote.Name);
		clientChannels.set(remote, channel);
	}
	return channel;
}

// A server channel over the default remote with batching of your own, instead of
// the shared one: for a spec that steps frames by hand. Pass it to
// `robloxRemoteEvent({ channel })` / `bindActions(registry, { channel })` and
// publish through `createRemoteSignalPublisher(channel, ...)`; the default
// wiring keeps using the shared channel, so mix the two only on purpose.
export function createRemoteEventChannel(options?: WireBatchOptions): ServerChannel<Player> {
	return createServerChannel(serverRemoteOf(ensureServerRemote()), options);
}

let requestCounter = 0;
function defaultRequestId(): string {
	requestCounter += 1;
	return `aruna-${requestCounter}`;
}

// The default request timeout, applied when requestTimeoutMs is not given.
// Pass requestTimeoutMs: 0 to explicitly opt out (wait forever).
export const DEFAULT_ACTION_REQUEST_TIMEOUT_MS = 10_000;

// `batching` (default true) sends this invoker's calls once per frame.
export interface RemoteActionInvokerOptions extends WireBatchOptions {
	readonly createRequestId?: () => string;
	// Milliseconds to wait for a server response before rejecting with a timeout
	// error. Defaults to DEFAULT_ACTION_REQUEST_TIMEOUT_MS (10s); pass 0 to
	// disable the timeout entirely.
	readonly requestTimeoutMs?: number;
	// Called for a frame the channel drops (docs/wire-protocol.md). Without it,
	// the channel's default: a warning in Studio.
	readonly onProtocolError?: WireProtocolErrorHandler;
}

export interface CreateActionInvokerOptions extends ContractHandshakeOptions, RemoteActionInvokerOptions {}

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
	const remote = waitForClientRemote();

	// Contract handshake: compare the client's compiled-in hash against the one
	// the server advertised on the remote. A mismatch fires the callback once; a
	// nil attribute (older server) is unknown, not a mismatch.
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

	return invokerOver(
		callSenderOf(remote),
		defaultClientChannel(remote),
		options,
		rejectOnMismatch ? versionMismatch : undefined,
	);
}

// An invoker over a remote you supply: calls go out through `remote`, responses
// arrive through `channel` — the client end of the reliable channel, which the
// signal subscriber shares so the two are handled in the order the server sent
// them. `createActionInvoker` is this over the default remote, plus the
// contract handshake.
export function createRemoteActionInvoker(
	remote: WireCallSender,
	channel: ClientChannel,
	options?: RemoteActionInvokerOptions,
): ActionInvoker {
	return invokerOver(remote, channel, options, undefined);
}

function invokerOver(
	remote: WireCallSender,
	channel: ClientChannel,
	options: RemoteActionInvokerOptions | undefined,
	// Set when every invoke must be refused for a contract mismatch.
	refusedFor: VersionMismatchInfo | undefined,
): ActionInvoker {
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
	if (options !== undefined && options.onProtocolError !== undefined) {
		channel.onProtocolError(options.onProtocolError);
	}
	// Calls leave once per frame (or one per frame with `batching: false`).
	const outbox = createWireOutbox<WireCallSender>(
		(target, frame) => {
			target.FireServer(frame);
		},
		undefined,
		options,
	);
	const sendCall = (call: WireCall): void => {
		outbox.push(remote, call);
	};

	channel.on(WIRE_ITEM_RESPONSE, (item) => {
		const response = item as Partial<WireResponse>;
		const requestId = response.i;
		if (!typeIs(requestId, "string") || !typeIs(response.r, "table")) {
			return;
		}
		const entry = pending.get(requestId);
		if (entry !== undefined) {
			pending.delete(requestId);
			if (entry.timeoutThread !== undefined) {
				task.cancel(entry.timeoutThread);
			}
			if (entry.unsubscribeCancel !== undefined) {
				entry.unsubscribeCancel();
			}
			entry.resolve(response.r as ActionResponsePayload);
		}
	});

	return (actionId, input, options) => {
		// Hard-block every invoke when the contract hash mismatched and the caller
		// opted into rejecting (rejectOnMismatch); otherwise the mismatch is
		// warn-only via onVersionMismatch and invokes proceed.
		if (refusedFor !== undefined) {
			return Promise.reject({
				message: `Aruna contract mismatch: client ${refusedFor.expected} vs server ${refusedFor.actual}.`,
				name: ACTION_VERSION_MISMATCH_ERROR_NAME,
			} satisfies ActionError);
		}

		// Fire-and-forget: fire the request and resolve immediately. No pending
		// entry is registered (the server's ignored ack, if any, is dropped) and
		// no timeout is armed. Matches the server binder skipping its response.
		if (options !== undefined && options.fireAndForget === true) {
			sendCall({ t: WIRE_ITEM_CALL, i: createRequestId(), a: actionId, d: input });
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
			// The idempotency key rides along only when there is one.
			const idempotencyKey = options !== undefined ? options.idempotencyKey : undefined;
			sendCall({
				t: WIRE_ITEM_CALL,
				i: requestId,
				a: actionId,
				d: input,
				...(idempotencyKey !== undefined ? { k: idempotencyKey } : {}),
			});

			// With `batching: false` the response may have arrived synchronously
			// above; only arm the timeout and cancellation listener while still
			// pending.
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
	// The server's contract hash, advertised on the remote so clients can detect
	// a deploy skew. Pass the generated `contractHash`; omit to advertise nothing
	// (clients then treat this server as unknown, never mismatched).
	readonly contractHash?: string;
	// The server channel responses go out through. Defaults to the remote's
	// shared channel — the one `createSignalPublisher` publishes through, so a
	// player reads responses and signals in the order they were produced.
	readonly channel?: ServerChannel<Player>;
}

// Server transport over the default Aruna RemoteEvent, for
// `createServerApp({ transport: robloxRemoteEvent() })`. The native registry
// already bakes `defaultRateLimit` into dispatch, so the transport just binds.
export function robloxRemoteEvent<TPlayer = Player>(
	options?: RobloxRemoteEventOptions,
): ServerTransport<TPlayer> {
	return (registry, resources) => bindActions(registry, options, resources);
}

export function bindActions<TPlayer>(
	registry: ActionRegistry<TPlayer>,
	options?: RobloxRemoteEventOptions,
	resources?: ResourceHost<TPlayer>,
): ServerAppBinding {
	const remote = ensureServerRemote();
	// Advertise the contract hash so a client with a mismatched compiled-in hash
	// can surface the skew before it corrupts a payload mid-session.
	const contractHash = options !== undefined ? options.contractHash : undefined;
	if (contractHash !== undefined) {
		remote.SetAttribute(CONTRACT_HASH_ATTRIBUTE_NAME, contractHash);
	}
	const channel =
		options !== undefined && options.channel !== undefined ? options.channel : defaultServerChannel(remote);
	// The registry is generic over the player only for in-process callers and
	// tests; over a RemoteEvent the sender is always a Player.
	return bindRemoteActions(
		registry,
		callReceiverOf(remote) as unknown as WireCallReceiver<TPlayer>,
		channel as unknown as ServerChannel<TPlayer>,
		resources,
	);
}

// Binds a registry to a remote you supply: calls arrive through `remote`,
// responses go out through `channel`. `bindActions` is this over the default
// remote. Disconnecting stops reading calls and flushes what the channel holds;
// the channel itself belongs to whoever created it.
export function bindRemoteActions<TPlayer>(
	registry: ActionRegistry<TPlayer>,
	remote: WireCallReceiver<TPlayer>,
	channel: ServerChannel<TPlayer>,
	// The app's resource host: its state items go out through `channel`, in
	// order with responses and signals, and subscription items arriving on
	// `remote` are admitted and handed to it.
	resources?: ResourceHost<TPlayer>,
): ServerAppBinding {
	if (resources !== undefined) {
		resources.attach(channel);
	}
	const connection = remote.OnServerEvent.Connect((sender, frame) => {
		// The frame as a whole first: its shape, its protocol version, and its
		// length, before any call in it is read. A frame that fails is dropped
		// whole, charged one request, and reported.
		const read = readWireFrame(frame);
		if (!read.ok) {
			registry.refuseFrame(sender, read.reason);
			return;
		}

		for (const item of read.items) {
			// A resource subscription, when the app has resources: admitted like a
			// call (charged, bounded, an unknown id reported) and handed over.
			if (
				resources !== undefined &&
				typeIs(item, "table") &&
				(item as { readonly t?: unknown }).t === WIRE_ITEM_RESOURCE_SUBSCRIPTION
			) {
				admitResourceItem(registry, resources, sender, item as object);
				continue;
			}
			// Only calls (and resource subscriptions) travel client to server; an
			// item of any other kind is malformed, and charged and reported like a
			// call with bad ids.
			const call =
				typeIs(item, "table") && (item as { readonly t?: unknown }).t === WIRE_ITEM_CALL
					? (item as Partial<WireCall>)
					: undefined;
			const requestId = call !== undefined ? call.i : undefined;
			const actionId = call !== undefined ? call.a : undefined;

			// Each call is charged on its own: drop a malformed one (ids must be
			// bounded strings), charge the player's request budget, dropping the
			// call when it is spent, and drop a call to an action the server does
			// not define. None of them gets a response.
			if (!registry.admitEnvelope(sender, requestId, actionId)) {
				continue;
			}
			if (call === undefined || !typeIs(requestId, "string") || !typeIs(actionId, "string")) {
				continue;
			}

			// Fire-and-forget actions are one-way: dispatch still runs (for its
			// side effects and rate limiting), but no response is sent back, since
			// the client is not waiting for one. The idempotency key is untrusted:
			// dispatch ignores anything that is not a string of at most 64
			// characters.
			const fireAndForget = registry.isFireAndForget(actionId);
			void registry.dispatch(sender, actionId, call.d, call.k).then((result) => {
				if (!fireAndForget) {
					channel.push(sender, { t: WIRE_ITEM_RESPONSE, i: requestId, r: result } satisfies WireResponse);
				}
			});
		}
	});

	return {
		disconnect: () => {
			connection.Disconnect();
			channel.flush();
		},
	};
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

// UnreliableRemoteEvent shares RemoteEvent's structural API, but the nominal
// type can't stand in for one; adapt through the RemoteEvent shape.
function unreliableServerRemoteOf(remote: UnreliableRemoteEvent): SignalServerLike<Player> {
	return serverRemoteOf(remote as unknown as RemoteEvent);
}

function unreliableClientRemoteOf(remote: UnreliableRemoteEvent): SignalClientLike {
	return clientRemoteOf(remote as unknown as RemoteEvent);
}

// Server-side signal emitter over the default Aruna RemoteEvent, through its
// shared server channel: reliable signals and action responses for a player
// leave in the order they were produced. Registries containing
// `unreliable: true` signals also get the dedicated UnreliableRemoteEvent; those
// signals route over it automatically.
export function createSignalPublisher<TSignals extends SignalMap>(
	signals: TSignals,
): SignalPublisher<TSignals, Player> {
	const remote = ensureServerRemote();
	const unreliableRemote = hasUnreliableSignal(signals)
		? ensureServerUnreliableSignalRemote()
		: undefined;
	return createRemoteSignalPublisher<TSignals, Player>(
		defaultServerChannel(remote),
		signals,
		unreliableRemote !== undefined ? unreliableServerRemoteOf(unreliableRemote) : undefined,
	);
}

// The client end of the app's resources over the default Aruna RemoteEvent:
// subscriptions go out on the call remote, state items arrive through its shared
// client channel, in order with action responses and signals.
// `createClientApp({ resources: true })` builds and installs this one.
export function createResourceClient<TResources = { readonly [resourceId: string]: unknown }>(
	options?: ResourceClientOptions,
): ResourceClient<TResources> {
	const remote = waitForClientRemote();
	return createChannelResourceClient<TResources>(defaultClientChannel(remote), callSenderOf(remote), options);
}

// Client-side signal subscriber over the default Aruna RemoteEvent, through its
// shared client channel (and the unreliable remote, when the registry declares
// unreliable signals).
export function createSignalSubscriber<TSignals extends SignalMap>(
	signals: TSignals,
): SignalSubscriber<TSignals> {
	const remote = waitForClientRemote();
	const unreliableRemote = hasUnreliableSignal(signals)
		? waitForClientUnreliableSignalRemote()
		: undefined;
	return createRemoteSignalSubscriber<TSignals>(
		defaultClientChannel(remote),
		signals,
		unreliableRemote !== undefined ? unreliableClientRemoteOf(unreliableRemote) : undefined,
	);
}
