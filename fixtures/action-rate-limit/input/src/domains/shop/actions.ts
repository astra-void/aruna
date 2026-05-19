import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  rateLimit: {
    limit: 5,
    windowMs: 1000,
  },
  input: schema.object({ itemId: schema.string() }),
  output: schema.object({ ok: schema.boolean() }),
  run() {
    return { ok: true };
  },
});
