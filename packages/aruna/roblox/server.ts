// Aruna roblox-ts native runtime — server action definition surface.

import type { Infer, Schema } from "./schema";
import type { SignalMap, SignalPublisher } from "./signal-runtime";

// defineSignal lives alongside defineAction on the `aruna/server` surface so
// signal definitions import from the same entry as actions (mirrors the Node
// reference runtime's src/server.ts barrel).
export { defineSignal } from "./signal";
export type { InferSignalPayload, SignalDefinition } from "./signal";

export interface ActionContext<TPlayer = unknown, TSignals extends SignalMap = SignalMap> {
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
}

// Like ActionContext but with `publisher` guaranteed present and typed against a
// concrete signal registry and player. Produced by `createActionDefiner<TSignals,
// TPlayer>()`, whose authored action's `TPlayer` matches the app. Defined as an
// intersection so it stays a structural subtype of ActionContext.
export type PublishingActionContext<TPlayer, TSignals extends SignalMap> = ActionContext<
	TPlayer,
	TSignals
> & {
	readonly publisher: SignalPublisher<TSignals, TPlayer>;
};

export type ActionRateLimitKey = "player" | "global";

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
// `publisher`. Produced by a `createActionDefiner` binding.
export type PublishingActionDefinition<
	TInput extends Schema | undefined,
	TOutput extends Schema | undefined,
	TPlayer,
	TSignals extends SignalMap,
> = Omit<ActionDefinition<TInput, TOutput, TPlayer, TSignals>, "run"> & {
	run(
		context: PublishingActionContext<TPlayer, TSignals>,
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
export function createActionDefiner<TSignals extends SignalMap, TPlayer = Player>() {
	// Anonymous arrow (not a named function expression): roblox-ts rejects named
	// function expressions, and this runtime is compiled to Luau by rbxtsc.
	return <TInput extends Schema | undefined = undefined, TOutput extends Schema | undefined = undefined>(
		definition: PublishingActionDefinition<TInput, TOutput, TPlayer, TSignals>,
	): ActionDefinition<TInput, TOutput, TPlayer, TSignals> => definition;
}

// Re-exported so `aruna/server` is the single server entry. The imports these
// modules take back from this file are type-only, so the Luau require graph has
// no cycle.
export * from "./server-runtime";
export * from "./server-app";
