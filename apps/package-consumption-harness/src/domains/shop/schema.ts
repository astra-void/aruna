import { schema } from "aruna/schema";

export const purchaseItemInput = schema.object({
  itemId: schema.string(),
});

export const purchaseItemOutput = schema.object({
  ok: schema.boolean(),
});
