import { createClientApp } from "aruna/client";
import { createActionInvoker } from "aruna/roblox";
import { purchaseItem } from "$aruna/actions/client";
import { createHarnessRequestId } from "./app/bootstrap";
import { packageConsumptionLabel } from "./app/providers";

export function startClientApp() {
  const clientApp = createClientApp({
    transport: createActionInvoker({
      createRequestId: createHarnessRequestId,
    }),
  });

  void purchaseItem({
    itemId: packageConsumptionLabel,
  });

  return clientApp;
}

startClientApp();
