// Aruna roblox-ts native runtime — domain runtime boot sequence.
//
// A domain's `runtime.ts` is the long-lived server work: a heartbeat, a
// `PlayerAdded` connection, a round loop. The compiler classifies those files
// server-only but nothing started them, so projects hand-wrote a bootstrap
// Script listing every `start*()` in a chosen order — derived information whose
// ordering mistakes only surface at runtime, and which races the generated
// entry Script because Roblox does not order Scripts.
//
// `defineRuntime` puts the order in the definitions as `after` edges; the build
// resolves them and emits the boot sequence into the generated server entry, so
// the starts happen in one Script, after the app is wired.

export interface DomainRuntimeDefinition {
	// Stable identifier, unique across the project. Referenced by other runtimes'
	// `after` and reported by tooling, so it must be a static string literal.
	readonly id: string;
	// Runtimes that must have started before this one. The build resolves these
	// into a start order and rejects an unknown id or a cycle.
	readonly after?: readonly string[];
	// Called once, on the server, at boot.
	start(): void;
}

// Starts an already-ordered runtime list. The order is decided at build time by
// the compiler's topological sort, so this does no sorting of its own.
export function startRuntimes(runtimes: readonly DomainRuntimeDefinition[]): void {
	for (const runtime of runtimes) {
		const [ok, err] = pcall(() => {
			runtime.start();
		});
		if (!ok) {
			// Name the runtime that failed: without this the traceback points into
			// a generated file and says nothing about which domain refused to boot.
			error(`Aruna runtime "${runtime.id}" failed to start: ${tostring(err)}`);
		}
	}
}
