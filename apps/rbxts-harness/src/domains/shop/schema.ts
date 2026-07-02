import { schema, type Infer } from "aruna/schema";
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

export type PurchaseItemInput = Infer<typeof purchaseItemInputSchema>;
export type PurchaseItemOutput = Infer<typeof purchaseItemOutputSchema>;
