import { createClientApp } from "aruna/client";
import { createDefaultRobloxActionInvoker } from "aruna/roblox-runtime";
import { purchaseItem } from "$aruna/actions/client";
import { createHarnessRequestId } from "./app/bootstrap";
import { packageConsumptionLabel } from "./app/providers";

export function startClientApp() {
  const clientApp = createClientApp({
    invoker: createDefaultRobloxActionInvoker({
      createRequestId: createHarnessRequestId,
    }),
  });

  void purchaseItem({
    itemId: packageConsumptionLabel,
  });

  return clientApp;
}

startClientApp();
