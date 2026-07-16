import type { PurchaseInput } from "../domains/shop/schema";

export function defaultPurchase(): PurchaseInput {
  return { itemId: "sword", quantity: 1 };
}
