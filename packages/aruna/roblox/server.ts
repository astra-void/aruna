// Aruna roblox-ts native runtime — server action definition surface.

import type { Infer, Schema } from "./schema";
import type { SignalMap, SignalPublisher } from "./signal-runtime";
import type { StoreDocument } from "./player-store";
import type { ResourceContext } from "./resource";

// defineSignal lives alongside defineAction on the `aruna/server` surface so
// signal definitions import from the same entry as actions.
export { defineSignal } from "./signal";
export type { InferSignalPayload, SignalDefinition } from "./signal";
// The publisher surface, so a module that is handed one (`app.publisher`, an
// action's `ctx.publisher`) can type it without reaching into the runtime's
// internals: `SignalPublisher<Signals, Player>` with `Signals` from
// `$aruna/signals`.
export type { SignalBatchOptions, SignalMap, SignalPublisher } from "./signal-runtime";

export interface ActionContext<
	TPlayer = unknown,
	TSignals extends SignalMap = SignalMap,
	TSession = unknown,
> {
	readonly player: TPlayer;
	// The app-owned signal publisher, injected by `createServerApp` when it owns a
	// publisher (`{ signals, createPublisher }`). Lets an action push server→client
	// signals from inside `run` without a plumbing module. Optional on the base
	// context; use `createActionDefiner` for a non-optional, registry-typed one.
	//
	// The player type is `unknown` here, NOT `TPlayer`: a publisher's `to(player,
	// ...)` is contravariant in the player, so tying it to `TPlayer` would make an
	// `unknown`-player action (`defineAction` from `aruna/server`) no longer
	// assignable into a `createServerApp<Player>` registry. The precise, player-typed
	// publisher lives on `PublishingActionContext` via the definer.
	readonly publisher?: SignalPublisher<TSignals, unknown>;
	// Per-player session state, created by `createServerApp({ createSession })` on
	// player-add and injected into every action ctx for that player. Absent when no
	// session factory is configured. Optional on the base context; use
	// `createActionDefiner<TSignals, TPlayer, TSession>` for a non-optional, typed one.
	readonly session?: TSession;
	// The calling player's open store document, injected by `createServerApp` when
	// it owns a `playerStore`. Stays optional even under the typed definer, and
	// deliberately so: the document is absent while the locked read is still in
	// flight, and after a failed load there is no trustworthy value to hand out.
	// An action that persists state has to decide what to do when the save file is
	// missing, rather than being handed a default that would overwrite it.
	//
	// Carried value-erased for the same reason `publisher` is player-erased:
	// `StoreDocument<T>` is invariant in T (it both returns and accepts one), so
	// binding it here would stop an untyped action from being assignable into a
	// typed app's registry. The precise type lives on `PublishingActionContext`.
	readonly store?: StoreDocument<unknown>;
	// The calling player's documents from `createServerApp({ playerStores })`, by
	// name. Each is undefined until its load lands and after a failed load, for
	// the reason `store` is; `requireStores(...)` refuses an action until they
	// are there. Value-erased like `store`; `createActionDefiner`'s `TStores`
	// types it.
	readonly stores?: { readonly [name: string]: StoreDocument<unknown> | undefined };
	// Invalidation for the app's resources, injected when `createServerApp` was
	// given `resources`: `ctx.resources?.invalidate(questProgress)` re-reads the
	// calling player's value and sends it to them. Player-erased for the same
	// reason `publisher` is.
	readonly resources?: ResourceContext<unknown>;
}

// Like ActionContext but with `publisher` and `session` guaranteed present and
// typed against a concrete signal registry, player, and session. Produced by
// `createActionDefiner<TSignals, TPlayer, TSession>()`, whose authored action's
// `TPlayer` matches the app. Defined as an intersection so it stays a structural
// subtype of ActionContext.
export type PublishingActionContext<
	TPlayer,
	TSignals extends SignalMap,
	TSession = unknown,
	TStore = unknown,
	TStores = { readonly [name: string]: unknown },
> = ActionContext<TPlayer, TSignals, TSession> & {
	readonly publisher: SignalPublisher<TSignals, TPlayer>;
	readonly session: TSession;
	// Narrows the erased `store` from the base context to the value your player
	// store holds. Still optional: the document may not be loaded yet.
	readonly store?: StoreDocument<TStore>;
	// Narrows `stores` to your named stores' values. Present when the app owns
	// `playerStores`; each document still optional.
	readonly stores?: { readonly [K in keyof TStores]?: StoreDocument<TStores[K]> };
};

// What a custom rate-limit key function receives about the throttled call. The
// player is carried erased (`unknown`); narrow it in the function if needed.
export interface ActionRateLimitKeyInfo {
	readonly actionId: string;
	readonly player: unknown;
	readonly input: unknown;
}

// A per-action custom bucket-key function: returns the bucket a call belongs to.
// Same throttle applies to all calls sharing a returned key — e.g. key by an
// input field to throttle per target. Applied at runtime; recorded as the
// "custom" key in tooling.
export type ActionRateLimitKeyFn = (info: ActionRateLimitKeyInfo) => string;

// The per-action bucketing strategy: "player" / "global" literals or a custom
// key function.
export type ActionRateLimitKey = "player" | "global" | ActionRateLimitKeyFn;

// How a limit counts calls. "fixedWindow" (the default) allows `max` calls per
// `windowMs` window, counted from a window boundary, so two full windows back to
// back can let up to 2 × `max` through in quick succession. "tokenBucket" holds
// at most `max` calls' worth of tokens and refills `max` of them evenly over
// `windowMs`: a burst is never more than `max`, and the sustained rate is the
// same.
export type ActionRateLimitStrategy = "fixedWindow" | "tokenBucket";

export interface ActionRateLimitOptions {
	readonly key: ActionRateLimitKey;
	readonly windowMs: number;
	readonly max: number;
	readonly strategy?: ActionRateLimitStrategy;
}

export type InferInput<S> = S extends Schema ? Infer<S> : unknown;
export type InferOutput<S> = S extends Schema ? Infer<S> : unknown;

// One error an action declares it can fail with. `data` is what the client
// receives with it; omit it for an error that carries none.
export interface ActionErrorDeclaration {
	readonly data?: Schema;
}

// An action's `errors`: each failure a client should be able to tell apart, by
// name. The compiler records them in the contract, and the generated client
// stub types them, so `isActionError(err, stub, "OutOfStock")` narrows `data`.
export type ActionErrorMap = { readonly [name: string]: ActionErrorDeclaration };

// The data a declared error takes, as `ctx.fail`'s rest arguments: one when the
// declaration has a `data` schema, none otherwise.
export type ActionErrorDataArgs<TDeclaration> = TDeclaration extends { readonly data: infer S }
	? S extends Schema
		? [data: Infer<S>]
		: []
	: [];

// Throws the declared error `name`. The server checks `data` against the
// declared schema before the client sees it; a mismatch is a server bug, sent
// as ActionInternalError. Write `throw ctx.fail(...)` (or `return`), so the
// line after it is known to be unreachable.
export type ActionFail<TErrors extends ActionErrorMap> = <TName extends keyof TErrors & string>(
	name: TName,
	...data: ActionErrorDataArgs<TErrors[TName]>
) => never;

// What `run` gets besides the base context when the action declares `errors`.
export interface ActionFailContext<TErrors extends ActionErrorMap> {
	readonly fail: ActionFail<TErrors>;
}

// No declared errors: no `fail`. The erased `ActionErrorMap` (an action map's
// element type) keeps a required one: its `fail` takes any name and no data,
// which every declared `fail` accepts in its place, so an action of any player
// type with errors still slots into an app's action map.
type FailContextFor<TErrors extends ActionErrorMap> = keyof TErrors extends never
	? {}
	: ActionFailContext<TErrors>;

export interface ActionDefinition<
	TInput extends Schema | undefined = undefined,
	TOutput extends Schema | undefined = undefined,
	TPlayer = unknown,
	TSignals extends SignalMap = SignalMap,
	TErrors extends ActionErrorMap = {},
> {
	readonly id: string;
	readonly rateLimit?: ActionRateLimitOptions;
	// One-way action: the client does not wait for an ack and the server skips
	// the response, trading delivery confirmation for throughput on high-frequency
	// commands. The default (false/undefined) keeps the request/response roundtrip.
	readonly fireAndForget?: boolean;
	// Declares that running this action twice has the same effect as running it
	// once. Only then does the client's default retry policy retry a timeout: a
	// timeout does not mean the server did not run the action, only that the
	// response was late. Must be a boolean literal (the compiler reads it into the
	// manifest and passes it from the generated client stub).
	readonly idempotent?: boolean;
	readonly input?: TInput;
	readonly output?: TOutput;
	// The failures a client can tell apart, thrown with `ctx.fail(name, data)`.
	// Must be an object literal of `{ data?: schema }` objects (the compiler reads
	// it into the manifest and the contract).
	readonly errors?: TErrors;
	run(
		context: ActionContext<TPlayer, TSignals> & FailContextFor<TErrors>,
		input: InferInput<TInput>,
	): InferOutput<TOutput> | Promise<InferOutput<TOutput>>;
}

// An action definition whose `run` ctx carries a non-optional, registry-typed
// `publisher` and `session`. Produced by a `createActionDefiner` binding.
export type PublishingActionDefinition<
	TInput extends Schema | undefined,
	TOutput extends Schema | undefined,
	TPlayer,
	TSignals extends SignalMap,
	TSession = unknown,
	TStore = unknown,
	TErrors extends ActionErrorMap = {},
	TStores = { readonly [name: string]: unknown },
> = Omit<ActionDefinition<TInput, TOutput, TPlayer, TSignals, TErrors>, "run"> & {
	run(
		context: PublishingActionContext<TPlayer, TSignals, TSession, TStore, TStores> & FailContextFor<TErrors>,
		input: InferInput<TInput>,
	): InferOutput<TOutput> | Promise<InferOutput<TOutput>>;
};

export function defineAction<
	TInput extends Schema | undefined = undefined,
	TOutput extends Schema | undefined = undefined,
	TPlayer = unknown,
	TSignals extends SignalMap = SignalMap,
	TErrors extends ActionErrorMap = {},
>(
	definition: ActionDefinition<TInput, TOutput, TPlayer, TSignals, TErrors>,
): ActionDefinition<TInput, TOutput, TPlayer, TSignals, TErrors> {
	return definition;
}

// Builds a `defineAction` bound to your project's signal registry, so an action's
// `ctx.publisher.to/toMany/toAll(...)` is checked against the real signal ids and
// payloads — and present without a `?`. The publisher is still injected by
// `createServerApp`; this is pure typing sugar, no runtime state.
// `TStore` types `ctx.store` against the value your player store holds — pass
// the store's value type to get `ctx.store?.get()` typed instead of `unknown`.
// It stays optional on the ctx by design; see the note on ActionContext.
//
// `TStores` types `ctx.stores` from `createServerApp({ playerStores })`: pass
// `{ progress: ProgressValue; inventory: InventoryValue }`.
export function createActionDefiner<
	TSignals extends SignalMap,
	TPlayer = Player,
	TSession = unknown,
	TStore = unknown,
	TStores = { readonly [name: string]: unknown },
>() {
	// Anonymous arrow (not a named function expression): roblox-ts rejects named
	// function expressions, and this runtime is compiled to Luau by rbxtsc.
	return <
		TInput extends Schema | undefined = undefined,
		TOutput extends Schema | undefined = undefined,
		TErrors extends ActionErrorMap = {},
	>(
		definition: PublishingActionDefinition<TInput, TOutput, TPlayer, TSignals, TSession, TStore, TErrors, TStores>,
	): ActionDefinition<TInput, TOutput, TPlayer, TSignals, TErrors> => definition;
}

// Re-exported so `aruna/server` is the single server entry. The imports these
// modules take back from this file are type-only, so the Luau require graph has
// no cycle.
export * from "./server-runtime";
export * from "./server-app";
// The error an action throws when the client should see its name and message.
export { actionError } from "./action-error";
export type { PublicActionError } from "./action-error";
// The request budget and the `onAbuse` report, for a handler typed on its own.
export type {
	RequestAbuseHandler,
	RequestAbuseInfo,
	RequestAbuseReason,
	RequestBudgetOptions,
} from "./request-guard";
// Server-owned resources (docs/resources.md). `defineResource` here leaves the
// player type open, like `defineAction`; `aruna/roblox`'s defaults it to Player.
export { defineResource } from "./resource";
export type {
	AnyResourceDefinition,
	ResourceContext,
	ResourceDefinition,
	ResourceErrorHandler,
	ResourceErrorInfo,
	ResourceGlobalContext,
	ResourceHost,
	ResourceLoadContext,
	ResourceMap,
	ResourcePlayerContext,
	ResourceRef,
	ResourceScope,
} from "./resource";
// Domain runtimes: the boot sequence the compiler resolves from `after` edges.
export * from "./define-runtime";
export * from "./domain-runtime";
// Persistence: the safe DataStore core and the session-locked player document.
export * from "./define-store";
export * from "./store";
export * from "./player-store";
