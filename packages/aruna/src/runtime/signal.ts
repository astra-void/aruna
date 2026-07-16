import { assertSchema, validateSchema, type Infer, type Schema } from "../schema/index.js";
import { assertSerializableActionValue } from "./serialization.js";

// A signal is a server -> client push channel. Unlike an action it has no
// request/response shape: the server emits a payload and subscribed clients
// receive it. The payload schema is optional and, when present, is enforced on
// both the publish (server) and delivery (client) sides.
export type SignalPayload<TPayloadSchema extends Schema | undefined> = [TPayloadSchema] extends [
  Schema,
]
  ? Infer<TPayloadSchema>
  : unknown;

export type SignalDefinition<
  TPayloadSchema extends Schema | undefined = undefined,
  TId extends string = string,
> = {
  readonly id: TId;
  readonly payload?: TPayloadSchema;
  // Route this signal over the dedicated UnreliableRemoteEvent: no delivery
  // or ordering guarantee, in exchange for congestion-friendly throughput.
  // For high-frequency, latest-value-wins channels (movement, VFX) — never
  // for state a client must not miss. Payloads must stay under Roblox's
  // ~900-byte unreliable limit.
  readonly unreliable?: boolean;
};

export type InferSignalPayload<TSignal extends SignalDefinition<Schema | undefined>> =
  TSignal extends SignalDefinition<infer TPayloadSchema> ? SignalPayload<TPayloadSchema> : never;

export type SignalRegistry = Record<string, SignalDefinition<Schema | undefined>>;

// Validate a payload before it is published to clients. Mirrors dispatchAction's
// output handling: enforce the serialization boundary first, then the schema.
// Signal payloads travel server -> client, so they are validated under the
// "output" role for consistent error messages with action outputs.
export function assertPublishableSignalPayload(
  signal: SignalDefinition<Schema | undefined>,
  payload: unknown,
): void {
  assertSerializableActionValue(payload, "output", signal.id);

  if (signal.payload !== undefined) {
    assertSchema(signal.payload, payload, { actionId: signal.id, role: "output" });
  }
}

// Non-throwing payload check used on the client delivery path to drop malformed
// or schema-violating messages from an untrusted wire before invoking handlers.
export function isDeliverableSignalPayload(
  signal: SignalDefinition<Schema | undefined>,
  payload: unknown,
): boolean {
  if (signal.payload === undefined) {
    return true;
  }

  return validateSchema(signal.payload, payload).ok;
}
