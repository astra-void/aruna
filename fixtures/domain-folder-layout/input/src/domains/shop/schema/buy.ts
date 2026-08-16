import { schema } from "aruna/schema";

export const buyInput = schema.object({
  itemId: schema.string(),
});
