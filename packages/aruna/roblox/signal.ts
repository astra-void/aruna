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
