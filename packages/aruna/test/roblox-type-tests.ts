// Type-level assertions for the roblox-ts-native runtime, checked by
// `tsc -p tsconfig.roblox.json` (rbxts ambient types, noLib). Lives outside
// roblox/ so it is never vendored into consumers.
import { defineSignal } from "../roblox/signal";
import { schema } from "../roblox/schema";

type Expect<T extends true> = T;
type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

// Gap 2a: the id must stay the literal from the call site, not widen to
// `string` — consumers key publishes/subscribes off `definition.id`.
const spraySignal = defineSignal({
	id: "spray.painted",
	payload: schema.object({ x: schema.number() }),
});

type _NativeSignalIdStaysLiteral = Expect<Equal<typeof spraySignal.id, "spray.painted">>;

const bareSignal = defineSignal({ id: "match.started" });
type _NativeBareSignalIdStaysLiteral = Expect<Equal<typeof bareSignal.id, "match.started">>;

export {};
