import { purchaseItem } from "$aruna/actions/client";
import { DEFAULT_CURRENCY, DEFAULT_SHOP_ITEM_ID } from "../../shared/constants";

export function ShopPanel() {
  void purchaseItem({
    itemId: DEFAULT_SHOP_ITEM_ID,
    quantity: 1,
    currency: DEFAULT_CURRENCY,
  });

  return undefined;
}
