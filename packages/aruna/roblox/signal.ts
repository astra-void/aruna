// Aruna roblox-ts native runtime — server -> client signal definition surface.
//
// A signal is the push counterpart to an action: the server emits a payload and
// subscribed clients receive it. Mirrors ./server.ts (defineAction).

import type { Infer, Schema } from "./schema";

export interface SignalDefinition<
	TPayload extends Schema | undefined = undefined,
	TId extends string = string,
> {
	readonly id: TId;
	readonly payload?: TPayload;
	// Route this signal over the dedicated UnreliableRemoteEvent: no delivery
	// or ordering guarantee, in exchange for congestion-friendly throughput.
	// For high-frequency, latest-value-wins channels (movement, VFX) — never
	// for state a client must not miss. Payloads must stay under Roblox's
	// ~900-byte unreliable limit.
	readonly unreliable?: boolean;
	// "binary" sends the payload as an `encodeBinary` buffer laid out from the
	// payload schema (required): no field names or type tags on the wire, and a
	// fingerprint that makes a client on a different schema drop the message
	// instead of misreading it. The compiler knows its largest frame, which
	// matters most for an unreliable signal. Must be the string literal.
	readonly wire?: "binary";
}

export type InferSignalPayload<S> = S extends Schema ? Infer<S> : unknown;

// The identity helper captures the id as a literal type (`TId extends string`
// forces literal inference, mirroring the Node runtime): `defineSignal({ id:
// "spray.painted", ... }).id` stays "spray.painted", so call sites never retype
// signal ids.
export function defineSignal<
	TId extends string,
	TPayload extends Schema | undefined = undefined,
>(definition: SignalDefinition<TPayload, TId>): SignalDefinition<TPayload, TId> {
	return definition;
}
