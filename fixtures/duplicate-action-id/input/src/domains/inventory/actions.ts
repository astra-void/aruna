import { defineAction } from "aruna/server";

export const restockItem = defineAction({
  id: "shop.purchaseItem",
  run(ctx, input) {
    return { ok: true };
  },
});
