import type { DomainRuntimeDefinition } from "../runtime/domain-runtime.js";

export type { DomainRuntimeDefinition } from "../runtime/domain-runtime.js";

// Declares a domain runtime — the server work that starts once at boot and keeps
// running. Like `defineAction`, `defineSignal` and `defineStore` this is an
// identity function: the value it returns is the definition itself, and the
// compiler reads the literal to record the runtime in the manifest, resolve the
// start order from the `after` edges, and emit the boot sequence.
//
//   export const scoreRuntime = defineRuntime({
//     id: "score",
//     start() {
//       Players.PlayerAdded.Connect(createStatsFolder);
//     },
//   });
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
