import { defineAction } from "aruna/server";
import { buyInput } from "../schema/buy";
import { priceOf } from "./pricing";

export const buyItem = defineAction({
  id: "shop.buyItem",
  input: buyInput,
  async run(ctx, input) {
    return { price: priceOf(input.itemId) };
  },
});
