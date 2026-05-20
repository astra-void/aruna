import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";
import { canPurchaseItem } from "./model";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  rateLimit: { key: "player", windowMs: 1000, max: 5 },
  input: schema.object({
    itemId: schema.string(),
  }),
  output: schema.object({
    ok: schema.boolean(),
  }),
  run(_ctx, input) {
    const ok = canPurchaseItem(input.itemId);
    return {
      ok,
    };
  },
});
