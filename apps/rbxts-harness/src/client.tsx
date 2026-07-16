// Client hook module (entries: "generated"): the generated
// src/.aruna/client/main.client.ts owns the app bootstrap, builds the invoker
// with `createRequestId`, and calls `onStart` with the app handle.
import type { ClientApp } from "aruna/client";
import { purchaseItem, restockItem } from "$aruna/actions/client";
import { createHarnessRequestId } from "./app/bootstrap";

export const createRequestId = createHarnessRequestId;

export function onStart(_app: ClientApp) {
	void purchaseItem({
		itemId: "sword",
		quantity: 1,
		currency: "coins",
	});

	void restockItem({
		itemIds: ["shield"],
		warehouse: "central",
	});
}
