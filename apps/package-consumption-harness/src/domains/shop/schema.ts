import { schema } from "aruna/schema";

export const purchaseItemInput = schema.object({
  itemId: schema.string().maxLength(64),
});

export const purchaseItemOutput = schema.object({
  ok: schema.boolean(),
});
