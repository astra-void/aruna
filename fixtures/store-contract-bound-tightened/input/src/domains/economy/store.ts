import { definePlayerStore } from "aruna/server";
import { schema } from "aruna/schema";

// Same version as the committed snapshot. `name` lowered its maxLength from 32
// to 16 and `tags` gained a maxItems: records saved under the old bounds may
// exceed the new ones, so both are breaking (aruna::578). `title` raised its
// maxLength, which every saved record still satisfies.
export const profile = definePlayerStore({
  id: "player.profile",
  schema: schema.object({
    name: schema.string().maxLength(16),
    title: schema.string().maxLength(64),
    tags: schema.array(schema.string()).maxItems(10),
  }),
  defaultValue: () => ({ name: "", title: "", tags: [] }),
});
