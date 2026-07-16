import type { SignalDefinition } from "../runtime/signal.js";
import type { Schema } from "../schema/index.js";

export type { InferSignalPayload, SignalDefinition, SignalRegistry } from "../runtime/signal.js";

// Mirror of defineAction for server -> client push channels. The identity
// helper captures the id as a literal type (`TId extends string` forces literal
// inference), so `definition.id` never widens to `string` and call sites can
// key publishes/subscribes off it without retyping the literal.
export function defineSignal<
  TId extends string,
  TPayloadSchema extends Schema | undefined = undefined,
>(definition: SignalDefinition<TPayloadSchema, TId>): SignalDefinition<TPayloadSchema, TId> {
  return definition;
}
