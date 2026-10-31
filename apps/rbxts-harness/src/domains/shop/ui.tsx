import { isActionError } from "aruna/client";
import { purchaseItem } from "$aruna/actions/client";
import { DEFAULT_CURRENCY, DEFAULT_SHOP_ITEM_ID } from "../../shared/constants";

export function ShopPanel() {
  purchaseItem({
    itemId: DEFAULT_SHOP_ITEM_ID,
    quantity: 1,
    currency: DEFAULT_CURRENCY,
  }).catch((err: unknown) => {
    // The generated stub carries the action's declared errors, so the guard
    // narrows `data` to what OutOfStock declares.
    if (isActionError(err, purchaseItem, "OutOfStock")) {
      warn(`${err.data.itemId} is sold out`);
    }
  });

  return undefined;
}
