import { INVENTORY_RESTOCK_ITEM_ID, SHOP_PURCHASE_ITEM_ID } from "../shared/ids";

export function createHarnessRequestId(): string {
  return "harness-request";
}

export const harnessActionIds = [SHOP_PURCHASE_ITEM_ID, INVENTORY_RESTOCK_ITEM_ID] as const;
