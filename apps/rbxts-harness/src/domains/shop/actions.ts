import { defineAction } from "aruna";
import { schema } from "aruna";
import { type PurchaseItemInput, type PurchaseItemOutput } from "./schema";
import { createActionResult } from "../../shared/result";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: schema.object({
    itemId: schema.string(),
    quantity: schema.number(),
    currency: schema.literal("coins"),
    coupon: schema.optional(schema.string()),
  }),
  output: schema.object({
    result: schema.object({
      ok: schema.boolean(),
      reason: schema.optional(schema.string()),
    }),
    itemId: schema.string(),
    total: schema.number(),
    currency: schema.literal("coins"),
  }),
  run(_ctx, input): PurchaseItemOutput {
    const typedInput: PurchaseItemInput = input;
    const total = typedInput.quantity * 50;

    return {
      result: createActionResult(
        typedInput.quantity > 0,
        typedInput.quantity > 0 ? undefined : "quantity must be positive",
      ),
      itemId: typedInput.itemId,
      total,
      currency: "coins",
    };
  },
});
