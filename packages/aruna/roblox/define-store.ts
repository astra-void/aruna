// Aruna roblox-ts native runtime — store definition surface.

import type { PlayerStoreDefinition } from "./player-store";
import type { StoreDefinition } from "./store";
import type { Schema } from "./schema";

// Declares a persisted store. Like `defineAction` and `defineSignal` this is an
// identity function: the compiler reads the literal to record the store in the
// manifest and to keep stores on the server. The `id` must be a static string
// literal — it is the DataStore name, and tooling reports it without executing
// your code.
export function defineStore<TSchema extends Schema>(
	definition: StoreDefinition<TSchema>,
): StoreDefinition<TSchema> {
	return definition;
}

// A store keyed by player and held under a session lock for as long as that
// player is on this server. Use it for save files: anything where two servers
// writing the same record would cost a player progress.
export function definePlayerStore<TSchema extends Schema, TPlayer = Player>(
	definition: PlayerStoreDefinition<TSchema, TPlayer>,
): PlayerStoreDefinition<TSchema, TPlayer> {
	return definition;
}
