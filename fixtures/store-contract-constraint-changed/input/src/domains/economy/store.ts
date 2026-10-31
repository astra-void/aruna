import { definePlayerStore } from "aruna/server";
import { schema } from "aruna/schema";

const limits = { nickname: 20 };

// Same version as the committed snapshot. `level` changed what its .refine()
// checks, and `nickname` the expression its maxLength is computed from: the
// compiler sees both changes but cannot judge them against saved records, so
// each is a warning, not a gate failure. `nickname` also lowered its
// .minLength(), which every saved record still satisfies, so it is not listed.
export const profile = definePlayerStore({
  id: "player.profile",
  schema: schema.object({
    level: schema.number().min(0).refine((value) => (value as number) % 2 === 0, "expected an even level"),
    nickname: schema.string().minLength(2).maxLength(limits.nickname),
  }),
  defaultValue: () => ({ level: 0, nickname: "new" }),
});
