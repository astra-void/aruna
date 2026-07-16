import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: schema.object({
    itemId: schema.string(),
  }),
  output: schema.object({
    ok: schema.boolean(),
  }),
  run(ctx, input) {
    return { ctx, input };
  },
});
