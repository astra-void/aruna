import { createClientApp } from "aruna/client";
import { createRemoteEventActionInvoker } from "aruna/roblox-runtime";
import { purchaseItem, restockItem } from "$aruna/actions/client";
import { actionRemoteEventClient } from "../shared/remotes";

export const clientApp = createClientApp({
  invoker: createRemoteEventActionInvoker(actionRemoteEventClient, {
    createRequestId: () => "harness-request",
  }),
});

void purchaseItem({
  itemId: "sword",
  quantity: 1,
  currency: "coins",
}).then((result) => {
  const ok: boolean = result.result.ok;
  const itemId: string = result.itemId;
  const total: number = result.total;
  const currency: "coins" | "gems" = result.currency;

  void ok;
  void itemId;
  void total;
  void currency;
});

void restockItem({
  itemIds: ["shield", "potion"],
  warehouse: "central",
}).then((result) => {
  const ok: boolean = result.result.ok;
  const warnings: string[] = result.warnings;

  void ok;
  void warnings;
});
