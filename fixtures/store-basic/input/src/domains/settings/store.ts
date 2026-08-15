import { defineStore } from "aruna/server";
import { schema } from "aruna/schema";

export const settings = defineStore({
  id: "game.settings",
  scope: "live",
  schema: schema.object({
    doubleCoinsEnabled: schema.boolean(),
  }),
  defaultValue: { doubleCoinsEnabled: false },
});
