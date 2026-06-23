// Aruna roblox-ts native runtime — server action definition surface.

import type { Infer, Schema } from "./schema";

// defineSignal lives alongside defineAction on the `aruna/server` surface so
// signal definitions import from the same entry as actions (mirrors the Node
// reference runtime's src/server.ts barrel).
export { defineSignal } from "./signal";
export type { InferSignalPayload, SignalDefinition } from "./signal";

export interface ActionContext<TPlayer = unknown> {
	readonly player: TPlayer;
}

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
> {
	readonly id: string;
	readonly rateLimit?: ActionRateLimitOptions;
	readonly input?: TInput;
	readonly output?: TOutput;
	run(
		context: ActionContext<TPlayer>,
		input: InferInput<TInput>,
	): InferOutput<TOutput> | Promise<InferOutput<TOutput>>;
}

export function defineAction<
	TInput extends Schema | undefined = undefined,
	TOutput extends Schema | undefined = undefined,
	TPlayer = unknown,
>(
	definition: ActionDefinition<TInput, TOutput, TPlayer>,
): ActionDefinition<TInput, TOutput, TPlayer> {
	return definition;
}
