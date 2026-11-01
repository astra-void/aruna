// Aruna roblox-ts native runtime — server-owned resources.
//
// A resource is state the server owns and clients observe: the server loads it
// (`load`), tells clients when it changed (`invalidate`), and every subscribed
// client converges on the newest value. The protocol is in
// docs/rfcs/resources.md; the parts that make it race-free are here:
//
//   * A subscription is registered before its snapshot is loaded, so no change
//     between the two goes unannounced.
//   * Every state item carries a revision from one per-server counter, taken
//     when its load starts. The server never sends a key backwards, and the
//     client never applies one backwards, so a snapshot that arrives after a
//     newer push is dropped rather than applied.
//   * Per resource and key, one load runs at a time and at most one more is
//     queued behind it; a batched channel keeps one state item per resource per
//     player per frame.
//
// Resources never carry a client write. The client sends a resource id and
// nothing else, and a player-scoped resource is always the sender's own.

import type { StoreDocument } from "./player-store";
import { firstSchemaIssue, type Infer, type Schema } from "./schema";
import { isWireSafe } from "./serialization";
import { createErrorId } from "./action-error";
import {
	createWireOutbox,
	WIRE_ITEM_RESOURCE,
	WIRE_ITEM_RESOURCE_SUBSCRIPTION,
	type ClientChannel,
	type WireBatchOptions,
	type WireCallSender,
	type WireResourceState,
	type WireResourceSubscription,
} from "./wire";

export type ResourceScope = "player" | "global";

// What `load` and `authorize` read. A player-scoped resource is loaded for one
// player; a global one is loaded once for every subscriber, so it has no player
// (`authorize` still gets the subscribing player).
export interface ResourcePlayerContext<TPlayer = unknown> {
	readonly player: TPlayer;
	// The player's session and store documents, as an action sees them.
	readonly session?: unknown;
	readonly store?: StoreDocument<unknown>;
	readonly stores?: { readonly [name: string]: StoreDocument<unknown> | undefined };
}

// A global resource is loaded once for everyone, so its `load` reads no player.
export interface ResourceGlobalContext {
	readonly player?: undefined;
}

export type ResourceLoadContext<TScope extends ResourceScope, TPlayer> = TScope extends "global"
	? ResourceGlobalContext
	: ResourcePlayerContext<TPlayer>;

export interface ResourceDefinition<
	TSchema extends Schema = Schema,
	TId extends string = string,
	TScope extends ResourceScope = ResourceScope,
	TPlayer = unknown,
> {
	readonly id: TId;
	// "player" (the default): one value per player. "global": one for everyone.
	readonly scope?: TScope;
	// What a snapshot is. A loaded value that fails it is never sent.
	readonly schema: TSchema;
	// The authoritative read. Runs on subscribe and on every invalidation;
	// returning synchronously lets an `invalidate` inside an action deliver the new
	// state before the action's response.
	load(context: ResourceLoadContext<TScope, TPlayer>): Infer<TSchema> | Promise<Infer<TSchema>>;
	// Refuses a subscription when it returns false (or throws). A property, not a
	// method, so that it can be left out: `authorize: (ctx) => ...`.
	readonly authorize?: (context: ResourcePlayerContext<TPlayer>) => boolean;
}

// `defineResource` lives on `aruna/server` with the player erased, like
// `defineAction`; `aruna/roblox`'s defaults the player to `Player`.
export function defineResource<
	TId extends string,
	TSchema extends Schema,
	TScope extends ResourceScope = "player",
	TPlayer = unknown,
>(
	definition: ResourceDefinition<TSchema, TId, TScope, TPlayer>,
): ResourceDefinition<TSchema, TId, TScope, TPlayer> {
	return definition;
}

export type AnyResourceDefinition = {
	readonly id: string;
	readonly scope?: ResourceScope;
	readonly schema: Schema;
	load(context: never): unknown;
	readonly authorize?: (context: never) => boolean;
};

export type ResourceMap = { readonly [resourceId: string]: AnyResourceDefinition };

// A resource named by its id or by its definition.
export type ResourceRef = string | { readonly id: string };

export type ResourceStatus = "loading" | "ready" | "error";

// The two errors a client can be told: a load that failed (or returned a value
// the server would not send), and a subscription `authorize` refused.
export const RESOURCE_LOAD_ERROR_NAME = "ResourceLoadError";
export const RESOURCE_FORBIDDEN_ERROR_NAME = "ResourceForbiddenError";

// The longest resource id a subscription item may carry.
export const MAX_RESOURCE_ID_LENGTH = 128;

export interface ResourceErrorInfo<TPlayer = unknown> {
	readonly resourceId: string;
	// The player the load ran for; absent for a global resource.
	readonly player?: TPlayer;
	// The id the client's error item carries.
	readonly errorId: string;
}

export type ResourceErrorHandler<TPlayer = unknown> = (
	failure: unknown,
	info: ResourceErrorInfo<TPlayer>,
) => void;

// What the host observes about its own work, for the network metrics.
export interface ResourceObserver {
	readonly onSnapshot?: (resourceId: string, recipients: number) => void;
	readonly onInvalidate?: (resourceId: string) => void;
	readonly onSubscribe?: (resourceId: string, resync: boolean) => void;
	readonly onUnsubscribe?: (resourceId: string) => void;
	readonly onLoadError?: (resourceId: string) => void;
}

// Where the host sends state items: the server channel (`replace` keeps one
// item per resource per player per frame).
export interface ResourceSink<TPlayer> {
	readonly replace: (target: TPlayer, key: string, item: defined) => void;
}

export interface ResourceHostOptions<TPlayer> {
	readonly getSession?: (player: TPlayer) => unknown;
	readonly getStore?: (player: TPlayer) => StoreDocument<unknown> | undefined;
	readonly getStores?: (player: TPlayer) => { readonly [name: string]: StoreDocument<unknown> | undefined };
	readonly onResourceError?: ResourceErrorHandler<TPlayer>;
	readonly observer?: ResourceObserver;
}

// The server side of every resource in an app: `app.resources`.
export interface ResourceHost<TPlayer = unknown> {
	// Re-reads a resource and sends the result to its subscribers. Player scope:
	// that player's value (every subscribed player's without one). Global scope:
	// the one value, to everyone subscribed. Never carries a value itself: the
	// state a client sees always comes from `load`.
	readonly invalidate: (resource: ResourceRef, player?: TPlayer) => void;
	readonly has: (resourceId: string) => boolean;
	readonly isSubscribed: (resource: ResourceRef, player: TPlayer) => boolean;
	readonly subscriberCount: (resource: ResourceRef) => number;
	// The transport's: where state items go. Items produced before a sink is
	// attached are dropped (no client can be subscribed yet).
	readonly attach: (sink: ResourceSink<TPlayer>) => void;
	// The transport's: one admitted subscription item.
	readonly receive: (player: TPlayer, item: object) => void;
	// The app's, on leave: drops everything held for the player.
	readonly forgetPlayer: (player: TPlayer) => void;
	readonly dispose: () => void;
}

// What an action sees as `ctx.resources`: invalidation for the calling player by
// default.
export interface ResourceContext<TPlayer = unknown> {
	readonly invalidate: (resource: ResourceRef, player?: TPlayer) => void;
	// Every subscribed player's value of a player-scoped resource (for a global
	// one, the same as `invalidate`).
	readonly invalidateAll: (resource: ResourceRef) => void;
}

interface KeyState<TPlayer> {
	readonly subscribers: Set<TPlayer>;
	loading: boolean;
	// An invalidation arrived while a load ran: one more load follows it.
	dirty: boolean;
	// The highest revision sent for this key; nothing lower goes out.
	sent: number;
	// The last value sent, kept for a global resource only, so a new subscriber
	// can be answered without a load.
	cached: WireResourceState | undefined;
}

function idOf(resource: ResourceRef): string {
	return typeIs(resource, "string") ? resource : resource.id;
}

function isPlayerScoped(definition: AnyResourceDefinition): boolean {
	return definition.scope !== "global";
}

export function createResourceHost<TPlayer>(
	resources: ResourceMap,
	options?: ResourceHostOptions<TPlayer>,
): ResourceHost<TPlayer> {
	const definitions = new Map<string, AnyResourceDefinition>();
	for (const [resourceId, definition] of pairs(resources as { [key: string]: AnyResourceDefinition })) {
		definitions.set(resourceId as string, definition);
	}

	const observer = options !== undefined ? options.observer : undefined;
	// One counter for every item this host produces: revisions order a server's
	// own items, across keys, resubscriptions, and rejoins.
	let revision = 0;
	let sink: ResourceSink<TPlayer> | undefined;
	let disposed = false;
	const perPlayer = new Map<string, Map<TPlayer, KeyState<TPlayer>>>();
	const global = new Map<string, KeyState<TPlayer>>();

	const resolve = (resource: ResourceRef): AnyResourceDefinition => {
		const resourceId = idOf(resource);
		const definition = definitions.get(resourceId);
		if (definition === undefined) {
			throw `Aruna resource not found: ${resourceId}`;
		}
		return definition;
	};

	const playerContext = (player: TPlayer): ResourcePlayerContext<TPlayer> => {
		const context: {
			player: TPlayer;
			session?: unknown;
			store?: StoreDocument<unknown>;
			stores?: { readonly [name: string]: StoreDocument<unknown> | undefined };
		} = { player };
		if (options !== undefined && options.getSession !== undefined) {
			const session = options.getSession(player);
			if (session !== undefined) {
				context.session = session;
			}
		}
		if (options !== undefined && options.getStore !== undefined) {
			const document = options.getStore(player);
			if (document !== undefined) {
				context.store = document;
			}
		}
		if (options !== undefined && options.getStores !== undefined) {
			context.stores = options.getStores(player);
		}
		return context;
	};

	const send = (player: TPlayer, item: WireResourceState): void => {
		if (sink !== undefined && !disposed) {
			sink.replace(player, item.r, item);
		}
	};

	const fail = (
		definition: AnyResourceDefinition,
		state: KeyState<TPlayer>,
		at: number,
		failure: unknown,
		player: TPlayer | undefined,
	): WireResourceState => {
		const errorId = createErrorId();
		if (options !== undefined && options.onResourceError !== undefined) {
			options.onResourceError(
				failure,
				player !== undefined
					? { resourceId: definition.id, player, errorId }
					: { resourceId: definition.id, errorId },
			);
		}
		if (observer !== undefined && observer.onLoadError !== undefined) {
			observer.onLoadError(definition.id);
		}
		state.cached = undefined;
		return { t: WIRE_ITEM_RESOURCE, r: definition.id, v: at, e: RESOURCE_LOAD_ERROR_NAME, i: errorId };
	};

	// What a finished load sends: the value when it is one the server would put
	// on the wire, else a load error. Server-authored, so not held to the node
	// budget that bounds a client's input.
	const stateItem = (
		definition: AnyResourceDefinition,
		state: KeyState<TPlayer>,
		at: number,
		value: unknown,
		player: TPlayer | undefined,
	): WireResourceState => {
		if (!isWireSafe(value, math.huge, definition.schema)) {
			return fail(definition, state, at, `Aruna resource ${definition.id} loaded a value that is not serializable`, player);
		}
		if (!definition.schema.validate(value)) {
			const issue = firstSchemaIssue(definition.schema, value);
			return fail(
				definition,
				state,
				at,
				issue !== undefined
					? `Aruna resource ${definition.id} loaded a value that fails its schema: ${issue}`
					: `Aruna resource ${definition.id} loaded a value that fails its schema`,
				player,
			);
		}
		return { t: WIRE_ITEM_RESOURCE, r: definition.id, v: at, d: value };
	};

	// Starts a load for one key, or marks it dirty when one is running. `player`
	// is the key of a player-scoped resource, undefined for a global one.
	const load = (definition: AnyResourceDefinition, state: KeyState<TPlayer>, player: TPlayer | undefined): void => {
		if (disposed) {
			return;
		}
		if (state.loading) {
			state.dirty = true;
			return;
		}
		state.loading = true;
		state.dirty = false;
		revision += 1;
		const at = revision;

		const finish = (item: WireResourceState): void => {
			state.loading = false;
			// Nobody left to tell (unsubscribed, left, disposed): the result is
			// dropped, and the state with it.
			if (disposed || state.subscribers.size() === 0) {
				return;
			}
			// Overtaken by a load that started later and already went out.
			if (at > state.sent) {
				state.sent = at;
				if (!isPlayerScoped(definition) && item.e === undefined) {
					state.cached = item;
				}
				let recipients = 0;
				for (const subscriber of state.subscribers) {
					send(subscriber, item);
					recipients += 1;
				}
				if (observer !== undefined && observer.onSnapshot !== undefined) {
					observer.onSnapshot(definition.id, recipients);
				}
			}
			if (state.dirty) {
				load(definition, state, player);
			}
		};

		const context = player !== undefined ? playerContext(player) : {};
		const [invoked, result] = pcall(() => definition.load(context as never));
		if (!invoked) {
			finish(fail(definition, state, at, result, player));
			return;
		}
		if (Promise.is(result)) {
			result.then(
				(value) => finish(stateItem(definition, state, at, value, player)),
				(rejection) => finish(fail(definition, state, at, rejection, player)),
			);
			return;
		}
		finish(stateItem(definition, state, at, result, player));
	};

	const newState = (): KeyState<TPlayer> => ({
		subscribers: new Set<TPlayer>(),
		loading: false,
		dirty: false,
		sent: 0,
		cached: undefined,
	});

	const stateFor = (definition: AnyResourceDefinition, player: TPlayer): KeyState<TPlayer> => {
		if (!isPlayerScoped(definition)) {
			let state = global.get(definition.id);
			if (state === undefined) {
				state = newState();
				global.set(definition.id, state);
			}
			return state;
		}
		let byPlayer = perPlayer.get(definition.id);
		if (byPlayer === undefined) {
			byPlayer = new Map<TPlayer, KeyState<TPlayer>>();
			perPlayer.set(definition.id, byPlayer);
		}
		let state = byPlayer.get(player);
		if (state === undefined) {
			state = newState();
			byPlayer.set(player, state);
		}
		return state;
	};

	const existingState = (definition: AnyResourceDefinition, player: TPlayer): KeyState<TPlayer> | undefined => {
		if (!isPlayerScoped(definition)) {
			return global.get(definition.id);
		}
		const byPlayer = perPlayer.get(definition.id);
		return byPlayer !== undefined ? byPlayer.get(player) : undefined;
	};

	const authorized = (definition: AnyResourceDefinition, player: TPlayer): boolean => {
		const authorize = definition.authorize;
		if (authorize === undefined) {
			return true;
		}
		const [ran, allowed] = pcall(() => authorize(playerContext(player) as never));
		return ran && allowed === true;
	};

	const subscribe = (definition: AnyResourceDefinition, player: TPlayer): void => {
		if (!authorized(definition, player)) {
			revision += 1;
			send(player, { t: WIRE_ITEM_RESOURCE, r: definition.id, v: revision, e: RESOURCE_FORBIDDEN_ERROR_NAME });
			return;
		}
		const state = stateFor(definition, player);
		const resync = state.subscribers.has(player);
		state.subscribers.add(player);
		if (observer !== undefined && observer.onSubscribe !== undefined) {
			observer.onSubscribe(definition.id, resync);
		}
		// A new subscriber to a global resource is answered by the load already
		// running, or by the value already out. A resync always loads fresh.
		if (!resync && state.loading) {
			return;
		}
		const cached = state.cached;
		if (!resync && cached !== undefined) {
			send(player, cached);
			return;
		}
		load(definition, state, isPlayerScoped(definition) ? player : undefined);
	};

	const unsubscribe = (definition: AnyResourceDefinition, player: TPlayer): void => {
		const state = existingState(definition, player);
		if (state === undefined || !state.subscribers.has(player)) {
			return;
		}
		state.subscribers.delete(player);
		if (observer !== undefined && observer.onUnsubscribe !== undefined) {
			observer.onUnsubscribe(definition.id);
		}
		if (isPlayerScoped(definition)) {
			const byPlayer = perPlayer.get(definition.id);
			if (byPlayer !== undefined) {
				byPlayer.delete(player);
			}
		}
	};

	return {
		invalidate: (resource, player) => {
			const definition = resolve(resource);
			if (observer !== undefined && observer.onInvalidate !== undefined) {
				observer.onInvalidate(definition.id);
			}
			if (!isPlayerScoped(definition)) {
				const state = global.get(definition.id);
				if (state === undefined) {
					return;
				}
				if (state.subscribers.size() === 0) {
					// Nobody to tell; the next subscriber loads fresh.
					state.cached = undefined;
					return;
				}
				load(definition, state, undefined);
				return;
			}
			const byPlayer = perPlayer.get(definition.id);
			if (byPlayer === undefined) {
				return;
			}
			if (player !== undefined) {
				const state = byPlayer.get(player);
				if (state !== undefined) {
					load(definition, state, player);
				}
				return;
			}
			for (const [subscriber, state] of byPlayer) {
				load(definition, state, subscriber);
			}
		},
		has: (resourceId) => definitions.has(resourceId),
		isSubscribed: (resource, player) => {
			const definition = resolve(resource);
			const state = existingState(definition, player);
			return state !== undefined && state.subscribers.has(player);
		},
		subscriberCount: (resource) => {
			const definition = resolve(resource);
			if (!isPlayerScoped(definition)) {
				const state = global.get(definition.id);
				return state !== undefined ? state.subscribers.size() : 0;
			}
			const byPlayer = perPlayer.get(definition.id);
			return byPlayer !== undefined ? byPlayer.size() : 0;
		},
		attach: (attached) => {
			sink = attached;
		},
		receive: (player, item) => {
			if (disposed) {
				return;
			}
			const subscription = item as Partial<WireResourceSubscription>;
			const resourceId = subscription.r;
			if (!typeIs(resourceId, "string")) {
				return;
			}
			const definition = definitions.get(resourceId);
			if (definition === undefined) {
				return;
			}
			if (subscription.o === 1) {
				subscribe(definition, player);
			} else if (subscription.o === 0) {
				unsubscribe(definition, player);
			}
		},
		forgetPlayer: (player) => {
			for (const [, byPlayer] of perPlayer) {
				// Cleared as well as unlinked: a load still running holds the state,
				// and must find nobody to send to when it lands.
				const state = byPlayer.get(player);
				if (state !== undefined) {
					state.subscribers.clear();
					byPlayer.delete(player);
				}
			}
			for (const [, state] of global) {
				state.subscribers.delete(player);
			}
		},
		dispose: () => {
			disposed = true;
			perPlayer.clear();
			global.clear();
			sink = undefined;
		},
	};
}

// The transport's gate for one subscription item, in the order a call is
// gated: the item's shape and the player's request budget first (charged before
// the id is read, reported as malformed or over budget), then whether the
// resource exists (reported as `unknown-resource`, and dropped without an
// answer: an answer would tell a prober which ids exist).
export interface ResourceAdmission<TPlayer> {
	readonly admitItem: (player: TPlayer, id: unknown, maxLength: number) => boolean;
	readonly reportAbuse: (
		player: TPlayer,
		info: { readonly reason: "unknown-resource" | "malformed-envelope"; readonly actionId?: string },
	) => void;
}

export function admitResourceItem<TPlayer>(
	admission: ResourceAdmission<TPlayer>,
	host: ResourceHost<TPlayer>,
	player: TPlayer,
	item: object,
): void {
	const subscription = item as Partial<WireResourceSubscription>;
	if (!admission.admitItem(player, subscription.r, MAX_RESOURCE_ID_LENGTH)) {
		return;
	}
	const resourceId = subscription.r as string;
	if (subscription.o !== 0 && subscription.o !== 1) {
		admission.reportAbuse(player, { reason: "malformed-envelope", actionId: resourceId });
		return;
	}
	if (!host.has(resourceId)) {
		admission.reportAbuse(player, { reason: "unknown-resource", actionId: resourceId });
		return;
	}
	host.receive(player, item);
}

// --- Client --------------------------------------------------------------------

export interface ResourceUpdateInfo {
	readonly revision: number;
}

export type ResourceListener<TValue> = (value: TValue, info: ResourceUpdateInfo) => void;

export interface ResourceSubscribeOptions {
	// Told the error name (`ResourceLoadError`, `ResourceForbiddenError`) when an
	// error item arrives. The last value stays.
	readonly onError?: (errorName: string, info: ResourceUpdateInfo & { readonly errorId?: string }) => void;
}

// One local subscription. Several share one wire subscription per resource.
export interface ResourceSubscription<TValue> {
	// The newest value applied, or undefined before the first one.
	readonly get: () => TValue | undefined;
	readonly status: () => ResourceStatus;
	// The revision of the newest item applied (0 before any).
	readonly revision: () => number;
	// The error name while `status()` is "error".
	readonly error: () => string | undefined;
	// Asks the server for a fresh snapshot (a resync).
	readonly refresh: () => void;
	readonly disconnect: () => void;
}

export interface ResourceClient<TResources = { readonly [resourceId: string]: unknown }> {
	// Subscribes to a resource. `listener` runs for every value applied — at once,
	// with the current value, when the resource already has one.
	readonly subscribe: <TId extends keyof TResources & string>(
		resourceId: TId,
		listener?: ResourceListener<TResources[TId]>,
		options?: ResourceSubscribeOptions,
	) => ResourceSubscription<TResources[TId]>;
	// The newest value applied for a resource this client is subscribed to.
	readonly get: <TId extends keyof TResources & string>(resourceId: TId) => TResources[TId] | undefined;
	// Asks for a fresh snapshot of every resource this client is subscribed to.
	readonly resync: () => void;
	readonly dispose: () => void;
}

export interface ResourceClientObserver {
	readonly onApplied?: (resourceId: string) => void;
	// An item dropped for its revision: a duplicate, a stale snapshot, or one
	// that arrived behind a newer item.
	readonly onStale?: (resourceId: string) => void;
}

export interface ResourceClientOptions extends WireBatchOptions {
	readonly observer?: ResourceClientObserver;
}

interface LocalListener {
	readonly listener?: ResourceListener<unknown>;
	readonly onError?: ResourceSubscribeOptions["onError"];
}

interface LocalResource {
	value: unknown;
	hasValue: boolean;
	status: ResourceStatus;
	error: string | undefined;
	readonly listeners: Set<LocalListener>;
}

function isRevision(value: unknown): value is number {
	return typeIs(value, "number") && value >= 1 && value < math.huge && math.floor(value) === value;
}

// The client end: subscription items go out through `sender` (batched like
// calls), state items arrive through `channel` — the client end of the reliable
// channel, in order with responses and signals.
export function createResourceClient<TResources = { readonly [resourceId: string]: unknown }>(
	channel: ClientChannel,
	sender: WireCallSender,
	options?: ResourceClientOptions,
): ResourceClient<TResources> {
	const observer = options !== undefined ? options.observer : undefined;
	const outbox = createWireOutbox<WireCallSender>(
		(target, frame) => {
			target.FireServer(frame);
		},
		undefined,
		options,
	);
	const active = new Map<string, LocalResource>();
	// The highest revision seen per resource, kept after an unsubscribe so an item
	// still in flight from before a resubscription cannot roll it back.
	const floors = new Map<string, number>();
	let disposed = false;

	const request = (resourceId: string, operation: 0 | 1): void => {
		outbox.push(sender, { t: WIRE_ITEM_RESOURCE_SUBSCRIPTION, r: resourceId, o: operation } satisfies WireResourceSubscription);
	};

	const removeHandler = channel.on(WIRE_ITEM_RESOURCE, (item) => {
		const state = item as Partial<WireResourceState>;
		const resourceId = state.r;
		const at = state.v;
		if (!typeIs(resourceId, "string") || !isRevision(at)) {
			return;
		}
		const floor = floors.get(resourceId);
		if (floor !== undefined && at <= floor) {
			if (observer !== undefined && observer.onStale !== undefined) {
				observer.onStale(resourceId);
			}
			return;
		}
		floors.set(resourceId, at);
		const held = active.get(resourceId);
		if (held === undefined) {
			return;
		}
		if (observer !== undefined && observer.onApplied !== undefined) {
			observer.onApplied(resourceId);
		}
		const info: ResourceUpdateInfo = { revision: at };
		// A copy: a listener may disconnect itself (or another) while it runs.
		const snapshot = new Array<LocalListener>();
		for (const entry of held.listeners) {
			snapshot.push(entry);
		}
		if (typeIs(state.e, "string")) {
			held.status = "error";
			held.error = state.e;
			const errorInfo = typeIs(state.i, "string") ? { revision: at, errorId: state.i } : info;
			for (const entry of snapshot) {
				if (entry.onError !== undefined) {
					entry.onError(state.e, errorInfo);
				}
			}
			return;
		}
		held.value = state.d;
		held.hasValue = true;
		held.status = "ready";
		held.error = undefined;
		for (const entry of snapshot) {
			if (entry.listener !== undefined) {
				entry.listener(state.d, info);
			}
		}
	});

	const client = {
		subscribe: (resourceId: string, listener?: ResourceListener<unknown>, subscribeOptions?: ResourceSubscribeOptions) => {
			if (disposed) {
				throw "Aruna resource client is disposed.";
			}
			let current = active.get(resourceId);
			const first = current === undefined;
			if (current === undefined) {
				current = {
					value: undefined,
					hasValue: false,
					status: "loading",
					error: undefined,
					listeners: new Set<LocalListener>(),
				};
				active.set(resourceId, current);
			}
			const entry: LocalListener = {
				...(listener !== undefined ? { listener } : {}),
				...(subscribeOptions !== undefined && subscribeOptions.onError !== undefined
					? { onError: subscribeOptions.onError }
					: {}),
			};
			current.listeners.add(entry);
			const held = current;
			if (first) {
				request(resourceId, 1);
			} else if (held.hasValue && listener !== undefined) {
				listener(held.value, { revision: floors.get(resourceId) ?? 0 });
			}
			let connected = true;
			return {
				get: () => (held.hasValue ? held.value : undefined),
				status: () => held.status,
				revision: () => floors.get(resourceId) ?? 0,
				error: () => held.error,
				refresh: () => {
					if (connected && !disposed) {
						request(resourceId, 1);
					}
				},
				disconnect: () => {
					if (!connected) {
						return;
					}
					connected = false;
					held.listeners.delete(entry);
					if (held.listeners.size() === 0 && active.get(resourceId) === held) {
						active.delete(resourceId);
						if (!disposed) {
							request(resourceId, 0);
						}
					}
				},
			};
		},
		get: (resourceId: string) => {
			const held = active.get(resourceId);
			return held !== undefined && held.hasValue ? held.value : undefined;
		},
		resync: () => {
			if (disposed) {
				return;
			}
			for (const [resourceId] of active) {
				request(resourceId, 1);
			}
		},
		dispose: () => {
			if (disposed) {
				return;
			}
			disposed = true;
			removeHandler();
			// What is queued (an unsubscribe) still goes out.
			outbox.dispose();
			active.clear();
		},
	};

	return client as unknown as ResourceClient<TResources>;
}

// --- Generated bindings ----------------------------------------------------------

let activeResourceClient: ResourceClient | undefined;

export function setResourceClient(client: ResourceClient): void {
	activeResourceClient = client;
}

export function clearResourceClient(client?: ResourceClient): void {
	if (client === undefined || activeResourceClient === client) {
		activeResourceClient = undefined;
	}
}

function installedResourceClient(resourceId: string): ResourceClient {
	const client = activeResourceClient;
	if (client === undefined) {
		throw `Aruna resource client is not installed: ${resourceId}. Create the client app with createClientApp({ resources: true }).`;
	}
	return client;
}

// One generated binding from `$aruna/resources/client`, bound to the resource
// client `createClientApp({ resources })` installed.
export interface ResourceBinding<TValue> {
	readonly id: string;
	readonly subscribe: (
		listener?: ResourceListener<TValue>,
		options?: ResourceSubscribeOptions,
	) => ResourceSubscription<TValue>;
	readonly get: () => TValue | undefined;
}

export function resourceBinding<TValue>(resourceId: string): ResourceBinding<TValue> {
	return {
		id: resourceId,
		subscribe: (listener, options) =>
			installedResourceClient(resourceId).subscribe(
				resourceId,
				listener as ResourceListener<unknown> | undefined,
				options,
			) as ResourceSubscription<TValue>,
		get: () => installedResourceClient(resourceId).get(resourceId) as TValue | undefined,
	};
}
