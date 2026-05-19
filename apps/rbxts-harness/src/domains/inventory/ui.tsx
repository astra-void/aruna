import { restockItem } from "$aruna/actions/client";
import { DEFAULT_INVENTORY_ITEM_ID, DEFAULT_WAREHOUSE } from "../../shared/constants";

export function InventoryPanel() {
  void restockItem({
    itemIds: [DEFAULT_INVENTORY_ITEM_ID],
    warehouse: DEFAULT_WAREHOUSE,
  });

  return undefined;
}
