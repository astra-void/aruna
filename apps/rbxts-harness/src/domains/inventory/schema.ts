import { schema, type Infer } from "aruna/schema";
import { actionResultSchema } from "../../shared/result";

export const restockItemInputSchema = schema.object({
  itemIds: schema.array(schema.string()),
  warehouse: schema.literal("central"),
  auditTag: schema.optional(schema.string()),
});

export const restockItemOutputSchema = schema.object({
  result: actionResultSchema,
  itemIds: schema.array(schema.string()),
  warnings: schema.array(schema.string()),
});

export type RestockItemInput = Infer<typeof restockItemInputSchema>;
export type RestockItemOutput = Infer<typeof restockItemOutputSchema>;
