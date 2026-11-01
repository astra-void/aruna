import { defineResource } from "aruna/server";
import { schema } from "aruna/schema";

const questProgressSchema = schema.object({
  quest: schema.string().maxLength(32),
  step: schema.u16(),
  completed: schema.array(schema.string().maxLength(32)).maxItems(64),
});

export const questProgress = defineResource({
  id: "quests.progress",
  schema: questProgressSchema,
  load(ctx) {
    return { quest: "intro", step: 0, completed: [] };
  },
});

export const bossHealth = defineResource({
  id: "encounter.boss",
  scope: "global",
  schema: schema.object({ health: schema.u16(), phase: schema.enum(["calm", "enraged"]) }),
  load: () => ({ health: 100, phase: "calm" as const }),
  authorize: () => true,
});
