import { schema, type InferSchema } from "aruna";
import { actionResultSchema } from "../../shared/result";

export const purchaseItemInputSchema = schema.object({
  itemId: schema.string(),
  quantity: schema.number(),
  currency: schema.literal("coins"),
  coupon: schema.optional(schema.string()),
});

export const purchaseItemOutputSchema = schema.object({
  result: actionResultSchema,
  itemId: schema.string(),
  total: schema.number(),
  currency: schema.literal("coins"),
});

export type PurchaseItemInput = InferSchema<typeof purchaseItemInputSchema>;
export type PurchaseItemOutput = InferSchema<typeof purchaseItemOutputSchema>;
