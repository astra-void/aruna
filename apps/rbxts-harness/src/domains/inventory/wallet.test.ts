// The wallet over the multiplayer test network: real clients, real wire, a
// virtual clock (docs/testing.md#multiplayer-networks).
import { createTestNetwork, describe, expect, it } from "aruna/testing";
import { claimDaily } from "./actions";
import { wallet } from "./resources";
import { dailyClaimed } from "./signals";
import type { Wallet } from "./schema";

function network() {
  return createTestNetwork({
    actions: { [claimDaily.id]: claimDaily },
    resources: { [wallet.id]: wallet },
    signals: { [dailyClaimed.id]: dailyClaimed },
    players: [301, 302],
    latencyMs: 30,
  });
}

describe("inventory.wallet", () => {
  it("shows each player their own balance, updated before the claim resolves", async () => {
    const net = network();
    const alice = net.client(301);
    const bob = net.client(302);
    const aliceSeen = new Array<number>();
    alice.resources.subscribe("inventory.wallet", (value) => aliceSeen.push((value as Wallet).coins));
    const bobWallet = bob.resources.subscribe("inventory.wallet");
    net.flush();

    let balanceAtResponse = -1;
    const claimed = alice.invoke("inventory.claimDaily").then(() => {
      balanceAtResponse = aliceSeen[aliceSeen.size() - 1]!;
    });
    net.flush();
    await claimed;
    expect(balanceAtResponse).toBe(25);
    expect((bobWallet.get() as Wallet).coins).toBe(0);
    net.dispose();
  });

  it("refuses a second claim within the window, per player", async () => {
    const net = network();
    const alice = net.client(301);
    void alice.invoke("inventory.claimDaily");
    let second = "pending";
    alice.invoke("inventory.claimDaily").catch((err: unknown) => (second = (err as { name: string }).name));
    const bobClaim = net.client(302).invoke("inventory.claimDaily");
    net.flush();
    expect(second).toBe("ActionRateLimitError");
    expect(((await bobClaim) as Wallet).coins >= 25).toBe(true);
    net.dispose();
  });
});
