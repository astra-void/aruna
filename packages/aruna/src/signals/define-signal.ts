import type { SignalDefinition } from "../runtime/signal.js";
import type { Schema } from "../schema/index.js";

export type { InferSignalPayload, SignalDefinition, SignalRegistry } from "../runtime/signal.js";

// Mirror of defineAction for server -> client push channels. The identity helper
// preserves the literal definition type so payload inference and signal ids stay
// precise at the call site.
export function defineSignal<
  TPayloadSchema extends Schema | undefined = undefined,
  TDefinition extends SignalDefinition<TPayloadSchema> = SignalDefinition<TPayloadSchema>,
>(definition: SignalDefinition<TPayloadSchema> & TDefinition): TDefinition {
  return definition;
}
