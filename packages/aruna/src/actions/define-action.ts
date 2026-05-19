import type { ActionDefinition } from "../runtime/server.js";
import type { Schema } from "../schema/index.js";

export type { ActionDefinition, InferInput, InferOutput } from "../runtime/server.js";
export type { ActionRateLimitOptions } from "../runtime/rate-limit.js";

export function defineAction<
  TInputSchema extends Schema | undefined = undefined,
  TOutputSchema extends Schema | undefined = undefined,
  TPlayer = unknown,
  TDefinition extends ActionDefinition<TInputSchema, TOutputSchema, TPlayer> = ActionDefinition<
    TInputSchema,
    TOutputSchema,
    TPlayer
  >,
>(
  definition: ActionDefinition<TInputSchema, TOutputSchema, TPlayer> & TDefinition,
): TDefinition {
  return definition;
}
