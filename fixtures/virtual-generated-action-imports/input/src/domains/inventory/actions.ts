import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const restockItem = defineAction({
  id: "inventory.restockItem",
  input: schema.object({
    itemIds: schema.array(schema.string()),
  }),
  output: schema.object({
    warnings: schema.array(schema.string()),
  }),
  async run() {
    return { warnings: [] };
  },
});
