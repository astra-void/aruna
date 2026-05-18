import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const restockItem = defineAction({
  id: "inventory.restockItem",
  input: schema.object({
    itemId: schema.string(),
    quantity: schema.number(),
  }),
  output: schema.object({
    ok: schema.boolean(),
  }),
  run(ctx, input) {
    return { ctx, input };
  },
});
