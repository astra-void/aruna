import { defineAction } from "aruna/server";

export const purchaseItem = defineAction({
  id: "inventory.purchaseItem",
  run(ctx, input) {
    return { ctx, input };
  },
});
