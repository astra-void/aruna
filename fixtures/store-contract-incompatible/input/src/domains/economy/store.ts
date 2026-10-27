import { definePlayerStore } from "aruna/server";
import { schema } from "aruna/schema";

// Same version as the committed snapshot, but records saved under it cannot be
// read: `gems` is required with no default, and `coins` narrowed from number to
// u8. `name` was removed, which only warns.
export const profile = definePlayerStore({
  id: "player.profile",
  schema: schema.object({
    coins: schema.u8(),
    gems: schema.number(),
  }),
  defaultValue: () => ({ coins: 0, gems: 0 }),
});
