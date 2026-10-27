import { definePlayerStore } from "aruna/server";
import { schema } from "aruna/schema";

// Same version as the committed snapshot. `level` changed its .min() and
// `nickname` its .minLength(): the compiler cannot evaluate either against saved
// records, only see that the chain changed, so each is a warning, not a gate
// failure. `nickname` kept its maxLength, which is not part of the hash.
export const profile = definePlayerStore({
  id: "player.profile",
  schema: schema.object({
    level: schema.number().min(1),
    nickname: schema.string().minLength(3).maxLength(20),
  }),
  defaultValue: () => ({ level: 1, nickname: "new" }),
});
