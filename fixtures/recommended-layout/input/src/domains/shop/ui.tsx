import { SHOP_ITEM_ID } from "./model";
import type { PurchaseInput } from "./schema";

export function shopPanelLabel(input: PurchaseInput): string {
  return `${SHOP_ITEM_ID}:${input.quantity}`;
}
