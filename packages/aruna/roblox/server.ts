// Aruna roblox-ts native runtime — server action definition surface.

import type { Infer, Schema } from "./schema";
import type { SignalMap, SignalPublisher } from "./signal-runtime";
import type { StoreDocument } from "./player-store";

// defineSignal lives alongside defineAction on the `aruna/server` surface so
// signal definitions import from the same entry as actions (mirrors the Node
// reference runtime's src/server.ts barrel).
export { defineSignal } from "./signal";
export type { InferSignalPayload, SignalDefinition } from "./signal";

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
> = ActionContext<TPlayer, TSignals, TSession> & {
	readonly publisher: SignalPublisher<TSignals, TPlayer>;
	readonly session: TSession;
	// Narrows the erased `store` from the base context to the value your player
	// store holds. Still optional: the document may not be loaded yet.
	readonly store?: StoreDocument<TStore>;
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

export interface ActionRateLimitOptions {
	readonly key: ActionRateLimitKey;
	readonly windowMs: number;
	readonly max: number;
}

export type InferInput<S> = S extends Schema ? Infer<S> : unknown;
export type InferOutput<S> = S extends Schema ? Infer<S> : unknown;

export interface ActionDefinition<
	TInput extends Schema | undefined = undefined,
	TOutput extends Schema | undefined = undefined,
	TPlayer = unknown,
	TSignals extends SignalMap = SignalMap,
> {
	readonly id: string;
	readonly rateLimit?: ActionRateLimitOptions;
	// One-way action: the client does not wait for an ack and the server skips
	// the response, trading delivery confirmation for throughput on high-frequency
	// commands. The default (false/undefined) keeps the request/response roundtrip.
	readonly fireAndForget?: boolean;
	readonly input?: TInput;
	readonly output?: TOutput;
	run(
		context: ActionContext<TPlayer, TSignals>,
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
> = Omit<ActionDefinition<TInput, TOutput, TPlayer, TSignals>, "run"> & {
	run(
		context: PublishingActionContext<TPlayer, TSignals, TSession, TStore>,
		input: InferInput<TInput>,
	): InferOutput<TOutput> | Promise<InferOutput<TOutput>>;
};

export function defineAction<
	TInput extends Schema | undefined = undefined,
	TOutput extends Schema | undefined = undefined,
	TPlayer = unknown,
	TSignals extends SignalMap = SignalMap,
>(
	definition: ActionDefinition<TInput, TOutput, TPlayer, TSignals>,
): ActionDefinition<TInput, TOutput, TPlayer, TSignals> {
	return definition;
}

// Builds a `defineAction` bound to your project's signal registry, so an action's
// `ctx.publisher.to/toMany/toAll(...)` is checked against the real signal ids and
// payloads — and present without a `?`. The publisher is still injected by
// `createServerApp`; this is pure typing sugar, no runtime state. Mirrors the
// Node reference runtime's `createActionDefiner`.
// `TStore` types `ctx.store` against the value your player store holds — pass
// the store's value type to get `ctx.store?.get()` typed instead of `unknown`.
// It stays optional on the ctx by design; see the note on ActionContext.
export function createActionDefiner<
	TSignals extends SignalMap,
	TPlayer = Player,
	TSession = unknown,
	TStore = unknown,
>() {
	// Anonymous arrow (not a named function expression): roblox-ts rejects named
	// function expressions, and this runtime is compiled to Luau by rbxtsc.
	return <TInput extends Schema | undefined = undefined, TOutput extends Schema | undefined = undefined>(
		definition: PublishingActionDefinition<TInput, TOutput, TPlayer, TSignals, TSession, TStore>,
	): ActionDefinition<TInput, TOutput, TPlayer, TSignals> => definition;
}

// Re-exported so `aruna/server` is the single server entry. The imports these
// modules take back from this file are type-only, so the Luau require graph has
// no cycle.
export * from "./server-runtime";
export * from "./server-app";
// Persistence: the safe DataStore core and the session-locked player document.
export * from "./define-store";
export * from "./store";
export * from "./player-store";
