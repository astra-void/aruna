// Aruna roblox-ts native runtime — server -> client signal definition surface.
//
// A signal is the push counterpart to an action: the server emits a payload and
// subscribed clients receive it. Mirrors ./server.ts (defineAction).

import type { Infer, Schema } from "./schema";

export interface SignalDefinition<TPayload extends Schema | undefined = undefined> {
	readonly id: string;
	readonly payload?: TPayload;
}

export type InferSignalPayload<S> = S extends Schema ? Infer<S> : unknown;

export function defineSignal<TPayload extends Schema | undefined = undefined>(
	definition: SignalDefinition<TPayload>,
): SignalDefinition<TPayload> {
	return definition;
}
