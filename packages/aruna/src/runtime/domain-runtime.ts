// Domain runtimes: the long-lived server work a game starts once at boot.
//
// Actions are pull (a client asks, the server answers). A domain's runtime is
// push: a heartbeat, a `PlayerAdded` connection, a round loop — anything that
// has to be running before the first client call arrives. The compiler already
// classified `runtime.ts` as server-only, but nothing started it, so every
// project hand-wrote a bootstrap script listing every `start*()` in a carefully
// chosen order. That file is pure derived information, and getting its order
// wrong fails at runtime rather than at build time.
//
// `defineRuntime` moves the order into the definitions themselves, as `after`
// edges the compiler resolves. What used to be a comment ("start this after the
// grab runtime, whose hooks it registers on") becomes an edge the build checks:
// a missing dependency or a cycle is a compile error, not a boot-order bug.

export type DomainRuntimeDefinition = {
  // Stable identifier, unique across the project. Referenced by other runtimes'
  // `after` and reported by tooling, so it must be a static string literal.
  readonly id: string;
  // Runtimes that must have started before this one. The build resolves these
  // into a start order and rejects an unknown id or a cycle.
  readonly after?: readonly string[];
  // Called once, on the server, at boot. Anything it registers (connections,
  // hooks, loops) is expected to outlive the call.
  start(): void;
};

// Starts an already-ordered runtime list. The order is decided at build time by
// the compiler's topological sort, so this deliberately does no sorting of its
// own — a runtime list assembled by hand runs exactly as written.
export function startRuntimes(runtimes: readonly DomainRuntimeDefinition[]): void {
  for (const runtime of runtimes) {
    try {
      runtime.start();
    } catch (error) {
      // Name the runtime that failed. Without this the stack points into a
      // generated file and says nothing about which domain refused to boot.
      throw new Error(`Aruna runtime "${runtime.id}" failed to start: ${String(error)}`);
    }
  }
}
