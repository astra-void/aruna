// A spec written the way a game project writes one: it imports the action under
// test directly (a spec may reach server code), drives it through the real
// dispatch path with the in-process harness, and never touches a RemoteEvent.
import { createTestPlayer, createTestServerApp, describe, expect, it } from "aruna/testing";
import { purchaseItem } from "./actions";
import type { PurchaseItemOutput } from "./schema";

const actions = { "shop.purchaseItem": purchaseItem };

describe("shop.purchaseItem", () => {
  it("prices the order and reports success", async () => {
    const harness = createTestServerApp({ actions });
    const player = createTestPlayer({ name: "Ada" });

    const output = (await harness.invoke(player, "shop.purchaseItem", {
      itemId: "sword",
      quantity: 2,
      currency: "coins",
    })) as PurchaseItemOutput;

    expect(output.total).toBe(100);
    expect(output.itemId).toBe("sword");
    expect(output.result.ok).toBe(true);

    harness.dispose();
  });

  it("refuses a non-positive quantity with a reason", async () => {
    const harness = createTestServerApp({ actions });

    const output = (await harness.invoke(createTestPlayer(), "shop.purchaseItem", {
      itemId: "sword",
      quantity: 0,
      currency: "coins",
    })) as PurchaseItemOutput;

    expect(output.result.ok).toBe(false);
    expect(output.result.reason).toBe("quantity must be positive");

    harness.dispose();
  });

  it("rejects input the schema does not accept", async () => {
    const harness = createTestServerApp({ actions });

    await expect(
      harness.invoke(createTestPlayer(), "shop.purchaseItem", {
        itemId: "sword",
        quantity: 1,
        currency: "gems",
      }),
    ).rejects.toThrow("invalid action input");

    harness.dispose();
  });

  it("enforces the action's rate limit", async () => {
    const harness = createTestServerApp({ actions });
    const player = createTestPlayer();
    const order = { itemId: "rope", quantity: 1, currency: "coins" };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await harness.invoke(player, "shop.purchaseItem", order);
    }
    await expect(harness.invoke(player, "shop.purchaseItem", order)).rejects.toThrow("rate limited");

    harness.dispose();
  });
});
