import { defineAction } from "aruna/server";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  run(ctx, input) {
    return { ctx, input };
  },
});
