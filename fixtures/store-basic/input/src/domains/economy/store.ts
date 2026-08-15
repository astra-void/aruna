import { definePlayerStore } from "aruna/server";
import { schema } from "aruna/schema";

export const profile = definePlayerStore({
  id: "player.profile",
  version: 2,
  schema: schema.object({
    coins: schema.u32(),
    unlocked: schema.array(schema.string()),
  }),
  defaultValue: () => ({ coins: 0, unlocked: [] }),
  migrate: (stored, fromVersion) =>
    fromVersion === 1 ? { coins: 0, unlocked: [] } : undefined,
});
