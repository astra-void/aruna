import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";
import { type PurchaseItemInput, type PurchaseItemOutput } from "./schema";
import { createActionResult } from "../../shared/result";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  rateLimit: {
    key: "player",
    windowMs: 1000,
    max: 5,
  },
  input: schema.object({
    itemId: schema.string().maxLength(64),
    quantity: schema.number(),
    currency: schema.literal("coins"),
    coupon: schema.optional(schema.string().maxLength(32)),
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
  // A failure the client can tell apart, with the data it needs to say why.
  errors: {
    OutOfStock: { data: schema.object({ itemId: schema.string().maxLength(64) }) },
  },
  run(ctx, input): PurchaseItemOutput {
    const typedInput: PurchaseItemInput = input;
    if (typedInput.itemId === "sold-out") {
      throw ctx.fail("OutOfStock", { itemId: typedInput.itemId });
    }
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
