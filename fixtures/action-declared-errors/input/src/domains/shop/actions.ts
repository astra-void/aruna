import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

// Declared errors: the manifest and the contract record them, and the generated
// client stub is typed with them (`PurchaseItemErrors`), so `isActionError`
// can narrow a rejection's data.
export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: schema.object({
    itemId: schema.string().maxLength(64),
  }),
  output: schema.object({
    ok: schema.boolean(),
  }),
  errors: {
    OutOfStock: { data: schema.object({ itemId: schema.string(), restockIn: schema.u16() }) },
    NotEnoughCoins: {},
  },
  run(ctx, input) {
    if (input.itemId === "") {
      throw ctx.fail("NotEnoughCoins");
    }
    return { ok: true };
  },
});

// An action without errors keeps the plain stub.
export const browse = defineAction({
  id: "shop.browse",
  output: schema.array(schema.string()),
  run() {
    return [];
  },
});
