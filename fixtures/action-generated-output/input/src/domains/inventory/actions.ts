import { defineAction } from "aruna/server";

export const restockItem = defineAction({
  id: "inventory.restockItem",
  run(ctx, input) {
    return { ctx, input };
  },
});
