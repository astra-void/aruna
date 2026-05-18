import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const restockItem = defineAction({
  id: "inventory.restockItem",
  input: schema.object({
    itemId: schema.string(),
    quantity: schema.number(),
    tags: schema.array(schema.string()),
    note: schema.optional(schema.string()),
  }),
  output: schema.object({
    ok: schema.boolean(),
    warnings: schema.array(schema.string()),
  }),
  run(ctx, input) {
    return { ctx, input };
  },
});
