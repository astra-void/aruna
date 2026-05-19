import { createClientApp } from "aruna/client";
import { createDefaultRobloxActionInvoker } from "aruna/roblox-runtime";
import { purchaseItem, restockItem } from "$aruna/actions/client";
import { createHarnessRequestId } from "./app/bootstrap";

export function startClientApp() {
  const clientApp = createClientApp({
    invoker: createDefaultRobloxActionInvoker({
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
