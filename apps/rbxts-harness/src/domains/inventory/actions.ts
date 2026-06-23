import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";
import { type RestockItemInput, type RestockItemOutput } from "./schema";
import { createActionResult } from "../../shared/result";

export const restockItem = defineAction({
  id: "inventory.restockItem",
  input: schema.object({
    itemIds: schema.array(schema.string()),
    warehouse: schema.literal("central"),
    auditTag: schema.optional(schema.string()),
  }),
  output: schema.object({
    result: schema.object({
      ok: schema.boolean(),
      reason: schema.optional(schema.string()),
    }),
    itemIds: schema.array(schema.string()),
    warnings: schema.array(schema.string()),
  }),
  run(_ctx, input): RestockItemOutput {
    const typedInput: RestockItemInput = input;
    const warnings = typedInput.auditTag === undefined ? [] : [`audit:${typedInput.auditTag}`];
    const hasItems = typedInput.itemIds[0] !== undefined;

    return {
      result: createActionResult(hasItems, hasItems ? undefined : "no items to restock"),
      itemIds: typedInput.itemIds,
      warnings,
    };
  },
});
