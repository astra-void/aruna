import type { PlayerStoreDefinition } from "../runtime/player-store.js";
import type { StoreDefinition } from "../runtime/store.js";
import type { Schema } from "../schema/index.js";

export type { PlayerStoreDefinition } from "../runtime/player-store.js";
export type { StoreDefinition, StoreMigrate, StoreRetryOptions } from "../runtime/store.js";

// Declares a persisted store. Like `defineAction` and `defineSignal` this is an
// identity function: the value it returns is the definition itself, and the
// compiler reads the literal to record the store in the manifest and to enforce
// that stores stay server-side.
//
//   export const settings = defineStore({
//     id: "game.settings",
//     schema: schema.object({ musicEnabled: schema.boolean() }),
//     defaultValue: { musicEnabled: true },
//   });
//
// The `id` must be a static string literal — it is the DataStore name, and
// tooling reports it without executing your code.
export function defineStore<TSchema extends Schema>(
  definition: StoreDefinition<TSchema>,
): StoreDefinition<TSchema> {
  return definition;
}

// A store keyed by player and held under a session lock for as long as that
// player is on this server. Use it for save files: anything where two servers
// writing the same record would cost a player progress.
//
//   export const profile = definePlayerStore({
//     id: "player.profile",
//     version: 2,
//     schema: profileSchema,
//     defaultValue: () => ({ coins: 0, unlocked: [] }),
//     migrate: (stored, from) => (from === 1 ? upgradeV1(stored) : undefined),
//   });
export function definePlayerStore<TSchema extends Schema, TPlayer = unknown>(
  definition: PlayerStoreDefinition<TSchema, TPlayer>,
): PlayerStoreDefinition<TSchema, TPlayer> {
  return definition;
}
