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
import type { Infer, Schema } from "./schema";
import { firstSchemaIssue } from "./schema-check";
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
	// How long an async `load` may run before it counts as failed
	// (ResourceLoadError, `onResourceError` told why) and its key is free again.
	// Default DEFAULT_RESOURCE_LOAD_TIMEOUT_MS; 0 waits forever. A result that
	// arrives after the timeout is dropped.
	readonly loadTimeoutMs?: number;
}

// A load that waits on something outside the server (a DataStore, HttpService)
// can hang; without a bound, a hung load would stall its key for good.
export const DEFAULT_RESOURCE_LOAD_TIMEOUT_MS = 30_000;

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
	readonly loadTimeoutMs?: number;
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

// The most optimistic-call tags one caller may hold on one key. A tag lives until
// a load that started after it finishes, and loads have no timeout, so without a
// cap a client could grow a key's tags at its request rate for as long as a load
// stays open. Past the cap a call is simply not tagged: its response leaves the
// resource out of `p`, and the client settles that update at the response.
const MAX_OPTIMISTIC_TAGS_PER_CALLER = 32;

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
	readonly replace: (
		target: TPlayer,
		key: string,
		item: defined,
		merge?: (queued: defined, incoming: defined) => defined,
	) => void;
}

// An optimistic call (docs/rfcs/ui-bindings.md): who made it, and the
// idempotency key the client matches its updates by.
export interface ResourceCallTag<TPlayer = unknown> {
	readonly caller: TPlayer;
	readonly key: string;
}

export interface ResourceHostOptions<TPlayer> {
	readonly getSession?: (player: TPlayer) => unknown;
	readonly getStore?: (player: TPlayer) => StoreDocument<unknown> | undefined;
	readonly getStores?: (player: TPlayer) => { readonly [name: string]: StoreDocument<unknown> | undefined };
	readonly onResourceError?: ResourceErrorHandler<TPlayer>;
	readonly observer?: ResourceObserver;
	// Schedules a load timeout; returns a cancel. Defaults to `task.delay`. The
	// test network passes its virtual clock.
	readonly delay?: (delayMs: number, callback: () => void) => () => void;
}

// The server side of every resource in an app: `app.resources`.
export interface ResourceHost<TPlayer = unknown> {
	// Re-reads a resource and sends the result to its subscribers. Player scope:
	// that player's value (every subscribed player's without one). Global scope:
	// the one value, to everyone subscribed. Never carries a value itself: the
	// state a client sees always comes from `load`.
	readonly invalidate: (resource: ResourceRef, player?: TPlayer) => void;
	// The registry's, for an invalidation from an optimistic call: tags the
	// caller's key, when the caller is subscribed to it, before invalidating. The
	// first item of that key loaded after the tag carries the call's key in `k`.
	readonly invalidateForCall: (resource: ResourceRef, player: TPlayer | undefined, call: ResourceCallTag<TPlayer>) => void;
	// The transport's, as it answers an optimistic call: the resources the call
	// tagged for its caller whose item has not been queued yet (`p`).
	readonly pendingTags: (caller: TPlayer, key: string) => ReadonlyArray<string>;
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
	// Optimistic calls whose invalidation of this key no item sent so far was
	// loaded after. A load takes the ones recorded before it starts; its item
	// delivers them, and an item that is never sent leaves them to the next.
	tags: Array<ResourceCallTag<TPlayer>>;
}

function idOf(resource: ResourceRef): string {
	return typeIs(resource, "string") ? resource : resource.id;
}

// What replaces a state item still queued for a player this frame: the newer
// item, carrying the older one's keys too. Those were delivered when the older
// item was queued, and the newer one is now the first that player receives.
function mergeTags(queued: defined, incoming: defined): defined {
	const older = (queued as WireResourceState).k;
	if (older === undefined) {
		return incoming;
	}
	const newer = incoming as WireResourceState;
	const keys = [...older];
	if (newer.k !== undefined) {
		for (const key of newer.k) {
			if (!keys.includes(key)) {
				keys.push(key);
			}
		}
	}
	return { ...newer, k: keys };
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
	const delay =
		options !== undefined && options.delay !== undefined
			? options.delay
			: (delayMs: number, callback: () => void): (() => void) => {
					const thread = task.delay(delayMs / 1000, callback);
					return () => task.cancel(thread);
				};
	// Load timeouts still armed, so `dispose` leaves no timer behind.
	const timers = new Set<() => void>();
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
			sink.replace(player, item.r, item, mergeTags);
		}
	};

	// The item one subscriber gets: with the keys of that subscriber's own calls
	// among the delivered tags, and nobody else's.
	const tagged = (item: WireResourceState, covering: ReadonlyArray<ResourceCallTag<TPlayer>>, subscriber: TPlayer): WireResourceState => {
		const keys = new Array<string>();
		for (const tag of covering) {
			if (tag.caller === subscriber) {
				keys.push(tag.key);
			}
		}
		return keys.size() > 0 ? { ...item, k: keys } : item;
	};

	const fail = (
		definition: AnyResourceDefinition,
		state: KeyState<TPlayer>,
		at: number,
		failure: unknown,
		player: TPlayer | undefined,
	): WireResourceState => {
		const errorId = createErrorId();
		const onResourceError = options !== undefined ? options.onResourceError : undefined;
		if (onResourceError !== undefined) {
			// The app's handler runs inside the load pipeline: a throw from it must
			// not leave the key loading forever.
			const [reported, problem] = pcall(() =>
				onResourceError(
					failure,
					player !== undefined
						? { resourceId: definition.id, player, errorId }
						: { resourceId: definition.id, errorId },
				),
			);
			if (!reported) {
				warn(`Aruna resource ${definition.id}: onResourceError threw: ${tostring(problem)}`);
			}
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
		// The calls tagged before this load started: it read state after their
		// invalidations, so its item is the first to contain them.
		const covering = state.tags.size() > 0 ? [...state.tags] : undefined;

		const finish = (item: WireResourceState): void => {
			state.loading = false;
			// Nobody left to tell (unsubscribed, left, disposed): the result is
			// dropped, and the state with it. A player-scoped state stays linked
			// while its load runs (see `unsubscribe`), so it is unlinked here.
			if (disposed || state.subscribers.size() === 0) {
				if (!disposed && player !== undefined && isPlayerScoped(definition)) {
					const byPlayer = perPlayer.get(definition.id);
					if (byPlayer !== undefined && byPlayer.get(player) === state) {
						byPlayer.delete(player);
					}
				}
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
					send(subscriber, covering !== undefined ? tagged(item, covering, subscriber) : item);
					recipients += 1;
				}
				if (covering !== undefined) {
					state.tags = state.tags.filter((tag) => !covering.includes(tag));
				}
				if (observer !== undefined && observer.onSnapshot !== undefined) {
					observer.onSnapshot(definition.id, recipients);
				}
			}
			if (state.dirty) {
				load(definition, state, player);
			}
		};

		// Validation runs the schema's `refine` callbacks, user code: a throw is a
		// load error like any other, never an escape that leaves the key loading.
		const settle = (value: unknown): void => {
			const [checked, item] = pcall(() => stateItem(definition, state, at, value, player));
			finish(checked ? item : fail(definition, state, at, item, player));
		};

		const [invoked, result] = pcall(() =>
			definition.load((player !== undefined ? playerContext(player) : {}) as never),
		);
		if (!invoked) {
			finish(fail(definition, state, at, result, player));
			return;
		}
		if (Promise.is(result)) {
			// Whichever comes first, the result or the timeout, settles the load;
			// the other is dropped.
			let settled = false;
			let cancelTimeout: (() => void) | undefined;
			const once = (settleWith: () => void): void => {
				if (settled) {
					return;
				}
				settled = true;
				if (cancelTimeout !== undefined) {
					cancelTimeout();
					timers.delete(cancelTimeout);
				}
				settleWith();
			};
			const timeoutMs = definition.loadTimeoutMs ?? DEFAULT_RESOURCE_LOAD_TIMEOUT_MS;
			if (timeoutMs > 0) {
				const cancel = delay(timeoutMs, () => {
					timers.delete(cancel);
					once(() => {
						finish(
							fail(definition, state, at, `Aruna resource ${definition.id}: load timed out after ${timeoutMs}ms`, player),
						);
						// Stops the work too, when the load's promise can be cancelled.
						result.cancel();
					});
				});
				cancelTimeout = cancel;
				timers.add(cancel);
			}
			result.then(
				(value) => once(() => settle(value)),
				(rejection) => once(() => finish(fail(definition, state, at, rejection, player))),
			);
			return;
		}
		settle(result);
	};

	const newState = (): KeyState<TPlayer> => ({
		subscribers: new Set<TPlayer>(),
		loading: false,
		dirty: false,
		sent: 0,
		cached: undefined,
		tags: [],
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

	const unsubscribe = (definition: AnyResourceDefinition, player: TPlayer): void => {
		const state = existingState(definition, player);
		if (state === undefined || !state.subscribers.has(player)) {
			return;
		}
		state.subscribers.delete(player);
		if (state.tags.size() > 0) {
			state.tags = state.tags.filter((tag) => tag.caller !== player);
		}
		if (observer !== undefined && observer.onUnsubscribe !== undefined) {
			observer.onUnsubscribe(definition.id);
		}
		// A player-scoped state is dropped with its last subscriber, unless a load
		// is still running for it: then it stays linked until that load finishes,
		// so subscribing again joins the running load instead of starting another.
		// Otherwise toggling subscribe and unsubscribe would start a new load per
		// toggle, around the one-load-per-key coalescing.
		if (isPlayerScoped(definition) && !state.loading) {
			const byPlayer = perPlayer.get(definition.id);
			if (byPlayer !== undefined) {
				byPlayer.delete(player);
			}
		}
	};

	const subscribe = (definition: AnyResourceDefinition, player: TPlayer): void => {
		if (!authorized(definition, player)) {
			// A resync refused after a change of mind (a role lost) ends the
			// subscription it was refreshing: nothing more goes to this player.
			unsubscribe(definition, player);
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
			// Under a fresh revision: the client may have seen this item before it
			// unsubscribed, or a higher one (a Forbidden answer), and would drop the
			// original as stale. No load is running, so every later one is higher.
			revision += 1;
			send(player, { ...cached, v: revision });
			return;
		}
		load(definition, state, isPlayerScoped(definition) ? player : undefined);
	};

	const host: ResourceHost<TPlayer> = {
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
					// Nobody to tell; the next subscriber loads fresh. A load already
					// running read the old state: whoever subscribes while it runs
					// waits on it, so it must be followed by another.
					state.cached = undefined;
					if (state.loading) {
						state.dirty = true;
					}
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
			// A copy: a load that yields lets a join or leave change the map
			// mid-iteration, which `pairs` does not allow for additions.
			const keys = new Array<{ readonly subscriber: TPlayer; readonly state: KeyState<TPlayer> }>();
			for (const [subscriber, state] of byPlayer) {
				keys.push({ subscriber, state });
			}
			for (const key of keys) {
				load(definition, key.state, key.subscriber);
			}
		},
		invalidateForCall: (resource, player, call) => {
			const definition = resolve(resource);
			// Only the caller's own key is tagged: invalidating another player's
			// value is not something the caller's updates predict.
			const state = !isPlayerScoped(definition)
				? global.get(definition.id)
				: player === undefined || player === call.caller
					? existingState(definition, call.caller)
					: undefined;
			// Tagged before the load starts: a synchronous load finishes inside
			// `invalidate`, and its item must carry the tag.
			if (state !== undefined && state.subscribers.has(call.caller)) {
				let held = 0;
				let alreadyTagged = false;
				for (const tag of state.tags) {
					if (tag.caller === call.caller) {
						held += 1;
						if (tag.key === call.key) {
							alreadyTagged = true;
						}
					}
				}
				if (!alreadyTagged && held < MAX_OPTIMISTIC_TAGS_PER_CALLER) {
					state.tags.push({ caller: call.caller, key: call.key });
				}
			}
			host.invalidate(resource, player);
		},
		pendingTags: (caller, key) => {
			const pending = new Array<string>();
			const holds = (state: KeyState<TPlayer>) =>
				state.tags.some((tag) => tag.key === key && tag.caller === caller);
			for (const [resourceId, byPlayer] of perPlayer) {
				const state = byPlayer.get(caller);
				if (state !== undefined && holds(state)) {
					pending.push(resourceId);
				}
			}
			for (const [resourceId, state] of global) {
				if (holds(state)) {
					pending.push(resourceId);
				}
			}
			return pending;
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
				if (state.tags.size() > 0) {
					state.tags = state.tags.filter((tag) => tag.caller !== player);
				}
			}
		},
		dispose: () => {
			disposed = true;
			for (const cancel of timers) {
				cancel();
			}
			timers.clear();
			perPlayer.clear();
			global.clear();
			sink = undefined;
		},
	};
	return host;
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
	// For an optimistic subscription: whether the value has pending optimistic
	// updates applied.
	readonly pending?: boolean;
}

export type ResourceListener<TValue> = (value: TValue, info: ResourceUpdateInfo) => void;

export interface ResourceSubscribeOptions {
	// Told the error name (`ResourceLoadError`, `ResourceForbiddenError`) when an
	// error item arrives. The last value stays.
	readonly onError?: (errorName: string, info: ResourceUpdateInfo & { readonly errorId?: string }) => void;
	// The value to show instead of the server's: the newest snapshot with the
	// pending optimistic updates applied (docs/rfcs/ui-bindings.md). The listener
	// also runs when an update comes or goes. Without it, a subscription never
	// sees an optimistic update.
	readonly optimistic?: boolean;
}

// One local subscription. Several share one wire subscription per resource.
export interface ResourceSubscription<TValue> {
	// The newest value applied, or undefined before the first one. With
	// `optimistic`, that value with the pending updates applied.
	readonly get: () => TValue | undefined;
	// Whether the resource has pending optimistic updates.
	readonly pending: () => boolean;
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
	readonly optimistic: boolean;
}

// An optimistic update waiting for the snapshot that contains its call.
interface PendingUpdate {
	readonly key: string;
	readonly updater: (current: unknown) => unknown;
}

// A resource client's side of the optimistic calls made through it.
interface Overlay {
	// Adds an update; false when the client is not subscribed to the resource.
	readonly add: (resourceId: string, update: PendingUpdate) => boolean;
	readonly remove: (resourceId: string, key: string) => void;
}

const overlays = new Map<ResourceClient, Overlay>();

function warnInStudio(message: string): void {
	const [ran, studio] = pcall(() => game.GetService("RunService").IsStudio());
	if (ran && studio === true) {
		warn(message);
	}
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
	// Pending optimistic updates per resource, oldest call first. Never sent and
	// never part of a snapshot: what an optimistic subscription shows is the
	// snapshot with these applied over it.
	const updates = new Map<string, Array<PendingUpdate>>();
	// Updates that threw, warned about once. Weak: a removed update is not kept.
	const warned = new WeakSet<PendingUpdate>();

	const request = (resourceId: string, operation: 0 | 1): void => {
		outbox.push(sender, { t: WIRE_ITEM_RESOURCE_SUBSCRIPTION, r: resourceId, o: operation } satisfies WireResourceSubscription);
	};

	const hasUpdates = (resourceId: string): boolean => {
		const list = updates.get(resourceId);
		return list !== undefined && list.size() > 0;
	};

	// The snapshot with every pending update applied, oldest first. An update
	// re-runs against each new snapshot, so a push that lands while its call is
	// pending shows through with the update on top. One that throws is skipped.
	const shownOf = (resourceId: string, held: LocalResource): unknown => {
		if (!held.hasValue) {
			return undefined;
		}
		const list = updates.get(resourceId);
		if (list === undefined) {
			return held.value;
		}
		let shown = held.value;
		for (const update of list) {
			const base = shown;
			const [applied, result] = pcall(() => update.updater(base));
			if (applied) {
				shown = result;
			} else if (!warned.has(update)) {
				warned.add(update);
				warnInStudio(`Aruna optimistic update of ${resourceId} threw, and is skipped: ${tostring(result)}`);
			}
		}
		return shown;
	};

	// Tells the optimistic listeners of a resource what it shows now.
	const notifyShown = (resourceId: string): void => {
		const held = active.get(resourceId);
		if (held === undefined || !held.hasValue) {
			return;
		}
		const shown = shownOf(resourceId, held);
		const info: ResourceUpdateInfo = { revision: floors.get(resourceId) ?? 0, pending: hasUpdates(resourceId) };
		const snapshot = new Array<ResourceListener<unknown>>();
		for (const entry of held.listeners) {
			if (entry.optimistic && entry.listener !== undefined) {
				snapshot.push(entry.listener);
			}
		}
		for (const listener of snapshot) {
			listener(shown, info);
		}
	};

	const replaceUpdates = (resourceId: string, kept: Array<PendingUpdate>): void => {
		if (kept.size() === 0) {
			updates.delete(resourceId);
		} else {
			updates.set(resourceId, kept);
		}
	};

	// Removes the updates of the calls an item names in `k`: it is the first
	// item to contain them. True when any was removed.
	const settleKeys = (resourceId: string, keys: unknown): boolean => {
		const list = updates.get(resourceId);
		if (list === undefined || !typeIs(keys, "table")) {
			return false;
		}
		const settled = new Set<string>();
		for (const key of keys as Array<unknown>) {
			if (typeIs(key, "string")) {
				settled.add(key);
			}
		}
		const kept = new Array<PendingUpdate>();
		const removed = new Set<string>();
		for (const update of list) {
			if (settled.has(update.key)) {
				removed.add(update.key);
			} else {
				kept.push(update);
			}
		}
		if (removed.size() === 0) {
			return false;
		}
		replaceUpdates(resourceId, kept);
		for (const key of removed) {
			settleResource(key, resourceId);
		}
		return true;
	};

	// Every update of a resource the client no longer shows.
	const dropUpdates = (resourceId: string): void => {
		const list = updates.get(resourceId);
		if (list === undefined) {
			return;
		}
		updates.delete(resourceId);
		for (const update of list) {
			settleResource(update.key, resourceId);
		}
	};

	const removeHandler = channel.on(WIRE_ITEM_RESOURCE, (item) => {
		const state = item as Partial<WireResourceState>;
		const resourceId = state.r;
		const at = state.v;
		if (!typeIs(resourceId, "string") || !isRevision(at)) {
			return;
		}
		// The calls this item is the first to contain leave in the step that
		// handles it, whether it is applied or stale.
		const settled = settleKeys(resourceId, state.k);
		const floor = floors.get(resourceId);
		if (floor !== undefined && at <= floor) {
			if (observer !== undefined && observer.onStale !== undefined) {
				observer.onStale(resourceId);
			}
			if (settled) {
				notifyShown(resourceId);
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
			if (settled) {
				notifyShown(resourceId);
			}
			return;
		}
		held.value = state.d;
		held.hasValue = true;
		held.status = "ready";
		held.error = undefined;
		const shown = shownOf(resourceId, held);
		const shownInfo: ResourceUpdateInfo = { revision: at, pending: hasUpdates(resourceId) };
		for (const entry of snapshot) {
			if (entry.listener !== undefined) {
				if (entry.optimistic) {
					entry.listener(shown, shownInfo);
				} else {
					entry.listener(state.d, info);
				}
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
			const optimistic = subscribeOptions !== undefined && subscribeOptions.optimistic === true;
			const entry: LocalListener = {
				...(listener !== undefined ? { listener } : {}),
				...(subscribeOptions !== undefined && subscribeOptions.onError !== undefined
					? { onError: subscribeOptions.onError }
					: {}),
				optimistic,
			};
			current.listeners.add(entry);
			const held = current;
			if (first) {
				request(resourceId, 1);
			} else if (held.hasValue && listener !== undefined) {
				if (optimistic) {
					listener(shownOf(resourceId, held), {
						revision: floors.get(resourceId) ?? 0,
						pending: hasUpdates(resourceId),
					});
				} else {
					listener(held.value, { revision: floors.get(resourceId) ?? 0 });
				}
			}
			let connected = true;
			return {
				get: () => (!held.hasValue ? undefined : optimistic ? shownOf(resourceId, held) : held.value),
				pending: () => hasUpdates(resourceId),
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
						dropUpdates(resourceId);
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
			// The server stops sending, too: every wire subscription is ended, and
			// what is queued goes out before the outbox stops.
			for (const [resourceId] of active) {
				request(resourceId, 0);
			}
			outbox.dispose();
			active.clear();
			const pendingIds = new Array<string>();
			for (const [resourceId] of updates) {
				pendingIds.push(resourceId);
			}
			for (const resourceId of pendingIds) {
				dropUpdates(resourceId);
			}
			overlays.delete(client as unknown as ResourceClient);
		},
	};

	overlays.set(client as unknown as ResourceClient, {
		add: (resourceId, update) => {
			if (disposed || !active.has(resourceId)) {
				warnInStudio(`Aruna optimistic update of ${resourceId} ignored: this client is not subscribed to it.`);
				return false;
			}
			const list = updates.get(resourceId);
			if (list === undefined) {
				updates.set(resourceId, [update]);
			} else {
				list.push(update);
			}
			notifyShown(resourceId);
			return true;
		},
		remove: (resourceId, key) => {
			const list = updates.get(resourceId);
			if (list === undefined) {
				return;
			}
			const kept = list.filter((update) => update.key !== key);
			if (kept.size() === list.size()) {
				return;
			}
			replaceUpdates(resourceId, kept);
			settleResource(key, resourceId);
			notifyShown(resourceId);
		},
	});

	return client as unknown as ResourceClient<TResources>;
}

// --- Optimistic calls (docs/rfcs/ui-bindings.md) ---------------------------------

// How long an update outlives its call's response while the item that contains
// the call is still on its way. A load that never settles must not pin it.
export const DEFAULT_OPTIMISTIC_SETTLE_TIMEOUT_MS = 10_000;

interface OptimisticCallRecord {
	readonly key: string;
	readonly overlay: Overlay;
	readonly settleTimeoutMs: number;
	// The resources the call still has updates on.
	readonly resources: Set<string>;
	// Whether its response arrived (and said what is still on its way).
	answered: boolean;
	// Bumped to cancel a scheduled timeout.
	generation: number;
}

// Calls with updates still pending, by idempotency key: what a response is
// matched to, whichever client app's invoker received it.
const optimisticCalls = new Map<string, OptimisticCallRecord>();

// A resource no longer has updates of a call (settled by an item, removed, or
// dropped with its subscription).
function settleResource(key: string, resourceId: string): void {
	const record = optimisticCalls.get(key);
	if (record === undefined) {
		return;
	}
	record.resources.delete(resourceId);
	if (record.resources.size() === 0) {
		optimisticCalls.delete(key);
		record.generation += 1;
	}
}

function removeAll(record: OptimisticCallRecord): void {
	const resourceIds = new Array<string>();
	for (const resourceId of record.resources) {
		resourceIds.push(resourceId);
	}
	for (const resourceId of resourceIds) {
		record.overlay.remove(resourceId, record.key);
	}
	if (optimisticCalls.get(record.key) === record) {
		optimisticCalls.delete(record.key);
	}
}

function armSettleTimeout(record: OptimisticCallRecord): void {
	record.generation += 1;
	const generation = record.generation;
	task.delay(record.settleTimeoutMs / 1000, () => {
		if (record.generation === generation && optimisticCalls.get(record.key) === record) {
			removeAll(record);
		}
	});
}

// One optimistic call's handle on a resource client.
export interface OptimisticCallHandle {
	// An update of a resource for this call; ignored (with a warning in Studio)
	// when the client is not subscribed to it.
	readonly update: (resourceId: string, updater: (current: unknown) => unknown) => void;
	// The call's promise resolved. Without a response handed over first (a
	// fire-and-forget action, a custom transport), the updates wait for their
	// items or the settle timeout.
	readonly succeeded: () => void;
	// The call's promise rejected. Without a response (a timeout, a
	// cancellation), nothing will confirm the updates, so they leave now.
	readonly failed: () => void;
}

const NOOP_CALL: OptimisticCallHandle = { update: () => {}, succeeded: () => {}, failed: () => {} };

// Starts an optimistic call through `client`. A key that already has a call is
// the same logical call (the server runs it once), so its updates are not
// added a second time.
export function beginOptimisticCall(
	client: ResourceClient,
	key: string,
	settleTimeoutMs: number = DEFAULT_OPTIMISTIC_SETTLE_TIMEOUT_MS,
): OptimisticCallHandle {
	const overlay = overlays.get(client);
	if (overlay === undefined || optimisticCalls.has(key)) {
		return NOOP_CALL;
	}
	const record: OptimisticCallRecord = {
		key,
		overlay,
		settleTimeoutMs,
		resources: new Set(),
		answered: false,
		generation: 0,
	};
	optimisticCalls.set(key, record);
	return {
		update: (resourceId, updater) => {
			if (optimisticCalls.get(key) === record && overlay.add(resourceId, { key, updater })) {
				record.resources.add(resourceId);
			}
		},
		succeeded: () => {
			if (!record.answered && optimisticCalls.get(key) === record) {
				if (record.resources.size() === 0) {
					optimisticCalls.delete(key);
				} else {
					armSettleTimeout(record);
				}
			}
		},
		failed: () => {
			if (!record.answered) {
				removeAll(record);
			}
		},
	};
}

// The invoker's, as an optimistic call's response arrives: an update of a
// resource the response does not name as still on its way leaves now (its item
// came first, or the call did not invalidate it); the rest wait for their item,
// or the settle timeout.
export function answerOptimisticCall(key: string, pending: ReadonlyArray<string>): void {
	const record = optimisticCalls.get(key);
	if (record === undefined) {
		return;
	}
	record.answered = true;
	const resourceIds = new Array<string>();
	for (const resourceId of record.resources) {
		resourceIds.push(resourceId);
	}
	for (const resourceId of resourceIds) {
		if (!pending.includes(resourceId)) {
			record.overlay.remove(resourceId, key);
		}
	}
	if (optimisticCalls.get(key) === record) {
		armSettleTimeout(record);
	}
}

// A response's `p`, kept to the strings in it.
export function pendingResourceIds(value: unknown): ReadonlyArray<string> {
	const ids = new Array<string>();
	if (typeIs(value, "table")) {
		for (const id of value as Array<unknown>) {
			if (typeIs(id, "string")) {
				ids.push(id);
			}
		}
	}
	return ids;
}

// --- Generated bindings ----------------------------------------------------------

let activeResourceClient: ResourceClient | undefined;

export function setResourceClient(client: ResourceClient): void {
	activeResourceClient = client;
}

// The installed client, or undefined before `createClientApp({ resources })`.
export function currentResourceClient(): ResourceClient | undefined {
	return activeResourceClient;
}

export function clearResourceClient(client?: ResourceClient): void {
	if (client === undefined || activeResourceClient === client) {
		activeResourceClient = undefined;
	}
}

// The client `createClientApp({ resources })` installed. Also what `aruna/ui`
// keys its shared subscriptions by, so a replaced client app starts them over.
export function installedResourceClient(resourceId: string): ResourceClient {
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
