import { definePlayerStore, defineStore } from "aruna/server";
import { schema } from "aruna/schema";

// Records saved under the committed snapshot still read: `coins` widened,
// `rank` gained a value, and `title` arrives with a default.
export const profile = definePlayerStore({
  id: "player.profile",
  schema: schema.object({
    coins: schema.u32(),
    rank: schema.enum(["bronze", "silver", "gold"]),
    title: schema.string().default("rookie"),
  }),
  defaultValue: () => ({ coins: 0, rank: "bronze" as const, title: "rookie" }),
});

// A reshape at a new version: migrate() converts the old records instead.
export const settings = defineStore({
  id: "game.settings",
  version: 2,
  schema: schema.object({ coinMultiplier: schema.number() }),
  defaultValue: { coinMultiplier: 1 },
  migrate: (stored, fromVersion) =>
    fromVersion === 1
      ? { coinMultiplier: (stored as { doubleCoins: boolean }).doubleCoins ? 2 : 1 }
      : undefined,
});
