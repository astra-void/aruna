import { definePlayerStore } from "aruna/server";
import { schema } from "aruna/schema";

export const profile = definePlayerStore({
  id: "player.profile",
  schema: schema.object({ coins: schema.u32() }),
  defaultValue: { coins: 0 },
});
