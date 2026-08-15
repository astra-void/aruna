// Type-level assertions for the roblox-ts-native runtime, checked by
// `tsc -p tsconfig.roblox.json` (rbxts ambient types, noLib). Lives outside
// roblox/ so it is never vendored into consumers.
import { createServerApp } from "../roblox/server-app";
import { createPlayerStore } from "../roblox/player-store";
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

// Gap 3: an app that owns a player store. `createServerApp` names the store
// with its schema erased, so a concretely-typed `PlayerStore` must flow into
// `playerStore` without a cast, and `app.playerStore` must come back usable.
const profileSchema = schema.object({ coins: schema.number() });

const profileStore = createPlayerStore<typeof profileSchema, Player>({
	id: "player.profile",
	schema: profileSchema,
	defaultValue: { coins: 0 },
});

const appWithPlayerStore = createServerApp<Player>({
	actions: {},
	playerStore: profileStore,
});

appWithPlayerStore.playerStore?.saveAll();

export {};
