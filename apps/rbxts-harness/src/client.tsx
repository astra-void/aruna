import { createClientApp } from "aruna/client";
import { createActionInvoker } from "aruna/roblox";
import { purchaseItem, restockItem } from "$aruna/actions/client";
import { createHarnessRequestId } from "./app/bootstrap";

export function startClientApp() {
  const clientApp = createClientApp({
    transport: createActionInvoker({
      createRequestId: createHarnessRequestId,
    }),
  });

  void purchaseItem({
    itemId: "sword",
    quantity: 1,
    currency: "coins",
  });

  void restockItem({
    itemIds: ["shield"],
    warehouse: "central",
  });

  return clientApp;
}

startClientApp();
