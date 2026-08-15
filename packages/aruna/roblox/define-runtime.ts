// Aruna roblox-ts native runtime — domain runtime definition surface.

import type { DomainRuntimeDefinition } from "./domain-runtime";

// Declares a domain runtime: the server work that starts once at boot and keeps
// running. Like `defineAction`, `defineSignal` and `defineStore` this is an
// identity function — the compiler reads the literal to record the runtime, to
// resolve the start order from the `after` edges, and to emit the boot sequence.
//
//   export const emoteRuntime = defineRuntime({
//     id: "emote",
//     // Registers carry hooks on the grab runtime, so it has to exist first.
//     after: ["grab"],
//     start() { ... },
//   });
//
// `id` and every `after` entry must be static string literals: the build
// resolves the order without executing your code, and reports an unknown id or
// a cycle as a compile error.
export function defineRuntime(definition: DomainRuntimeDefinition): DomainRuntimeDefinition {
	return definition;
}
