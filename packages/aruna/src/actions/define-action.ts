import type {
  ActionDefinition,
  ActionSchemaInput,
  ActionSchemaOutput,
  PublishingActionRunContext,
} from "../runtime/server.js";
import type { SignalRegistry } from "../runtime/signal.js";
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
>(definition: ActionDefinition<TInputSchema, TOutputSchema, TPlayer> & TDefinition): TDefinition {
  return definition;
}

// An action definition whose `run` ctx carries a non-optional, registry-typed
// `publisher` and `session`. Same shape as ActionDefinition otherwise. Produced
// when you author an action through a `createActionDefiner` binding.
export type PublishingActionDefinition<
  TInputSchema extends Schema | undefined,
  TOutputSchema extends Schema | undefined,
  TPlayer,
  TSignals extends SignalRegistry,
  TSession = unknown,
  TStore = unknown,
> = Omit<ActionDefinition<TInputSchema, TOutputSchema, TPlayer, TSignals>, "run"> & {
  run(
    ctx: PublishingActionRunContext<TPlayer, TSignals, TSession, TStore>,
    input: ActionSchemaInput<TInputSchema>,
  ): ActionSchemaOutput<TOutputSchema> | Promise<ActionSchemaOutput<TOutputSchema>>;
};

// Builds a `defineAction` bound to your project's signal registry, so an action's
// `ctx.publisher.to/toMany/toAll(...)` is checked against the real signal ids and
// payloads (a wrong id or payload is a compile error) — and present without a
// `?`. The publisher itself is still injected by `createServerApp`; this is pure
// typing sugar, no runtime state.
//
//   // src/shared/define.ts
//   import { createActionDefiner } from "aruna/server";
//   import type { Signals } from "$aruna/signals";
//   export const defineAction = createActionDefiner<Signals, Player>();
//
//   // src/domains/score/actions.ts
//   import { defineAction } from "../../shared/define";
//   export const bump = defineAction({
//     id: "score.bump",
//     run(ctx) {
//       ctx.publisher.toAll("score.changed", { value: 1 }); // typed, no `?`
//       return undefined;
//     },
//   });
// `TStore` types `ctx.store` against the value your `playerStore` holds — pass
// the store's value type to get `ctx.store?.get()` typed instead of `unknown`.
// It stays optional on the ctx by design; see the note on ActionRunContext.
export function createActionDefiner<
  TSignals extends SignalRegistry,
  TPlayer = unknown,
  TSession = unknown,
  TStore = unknown,
>() {
  return function definePublishingAction<
    TInputSchema extends Schema | undefined = undefined,
    TOutputSchema extends Schema | undefined = undefined,
  >(
    definition: PublishingActionDefinition<
      TInputSchema,
      TOutputSchema,
      TPlayer,
      TSignals,
      TSession,
      TStore
    >,
  ): ActionDefinition<TInputSchema, TOutputSchema, TPlayer, TSignals> {
    return definition;
  };
}
