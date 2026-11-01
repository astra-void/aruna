// Optimistic updates (docs/rfcs/ui-bindings.md). The server tags an optimistic
// call's invalidations with its key; the first item of each tagged resource
// names the call in `k`, and the call's response names what is still on its way
// in `p`. Each network case pins one ordering, and fails without the rule that
// handles it: a shown value never goes back (100 after 70) and never applies an
// update twice (40).
import { invokeOptimistic, resourceBinding, type ActionInvokeOptions } from "aruna/client";
import { beginOptimisticCall, createResourceHost } from "aruna/internal/resource";
import {
  createServerChannel,
  readWireFrame,
  WIRE_ITEM_RESOURCE_SUBSCRIPTION,
  type WireFrameScheduler,
} from "aruna/internal/wire";
import { defineAction, defineResource } from "aruna/roblox";
import { schema } from "aruna/schema";
import { createTestNetwork, createTestPlayer, createTestServerApp, describe, expect, it } from "aruna/testing";
import { observeAction, observeResource } from "aruna/ui";
import { waitUntil } from "./support";

type Wallet = { readonly coins: number };
type LoadMode = "sync" | "async" | "fail";

// Coins per player behind a wallet resource, and a purchase that spends them.
// The wallet's load can be made to wait for the spec (an async load) or to fail;
// a waiting load read the coins when it started.
function shop() {
  const coins = new Map<number, number>();
  const waiting = new Array<() => void>();
  let mode: LoadMode = "sync";
  const wallet = defineResource({
    id: "economy.wallet",
    schema: schema.object({ coins: schema.u32() }),
    load(ctx) {
      const value = { coins: coins.get(ctx.player.UserId) ?? 0 };
      if (mode === "fail") {
        throw "the wallet store is down";
      }
      if (mode === "async") {
        return new Promise<Wallet>((resolve) => {
          waiting.push(() => resolve(value));
        });
      }
      return value;
    },
  });
  const buy = defineAction({
    id: "shop.buy",
    input: schema.object({ price: schema.u16() }),
    run(ctx, input) {
      coins.set(ctx.player.UserId, (coins.get(ctx.player.UserId) ?? 0) - input.price);
      ctx.resources?.invalidate(wallet);
      return true;
    },
  });
  return {
    coins,
    actions: { [buy.id]: buy },
    resources: { [wallet.id]: wallet },
    setMode: (chosen: LoadMode) => {
      mode = chosen;
    },
    finishLoads: () => {
      const ready = [...waiting];
      waiting.clear();
      for (const finish of ready) {
        finish();
      }
    },
  };
}

function network(g: ReturnType<typeof shop>) {
  g.coins.set(101, 100);
  return createTestNetwork({ actions: g.actions, resources: g.resources, players: [101] });
}

type NetworkClient = ReturnType<ReturnType<typeof network>["client"]>;

let callCount = 0;

// `invokeOptimistic`, through this client's own resource client rather than the
// installed one.
function buyOptimistically(client: NetworkClient, price: number, key?: string, settleTimeoutMs?: number) {
  callCount += 1;
  const callKey = key ?? `buy-${callCount}`;
  const call = beginOptimisticCall(client.resources, callKey, settleTimeoutMs);
  call.update("economy.wallet", (current) => ({ coins: (current as Wallet).coins - price }));
  const promise = client.invoke("shop.buy", { price }, { idempotencyKey: callKey, optimistic: true });
  promise.then(
    () => call.succeeded(),
    () => call.failed(),
  );
  return promise;
}

// Every value an optimistic subscription is told to show.
function watch(client: NetworkClient) {
  const shown = new Array<number>();
  const subscription = client.resources.subscribe(
    "economy.wallet",
    (value) => shown.push((value as Wallet).coins),
    { optimistic: true },
  );
  return { shown, subscription };
}

describe("optimistic updates over the network", () => {
  it("removes an update with the item that contains its call when the item comes first", async () => {
    const g = shop();
    const net = network(g);
    const alice = net.client(101);
    const seen = watch(alice);
    net.flush();
    const bought = buyOptimistically(alice, 30);
    expect(seen.subscription.get()).toEqual({ coins: 70 });
    expect(seen.subscription.pending()).toBe(true);
    net.flush();
    await bought;
    expect(seen.shown).toEqual([100, 70, 70]);
    expect(seen.subscription.pending()).toBe(false);
    net.dispose();
  });

  it("keeps an update after the response while the call's item is on its way", async () => {
    const g = shop();
    const net = network(g);
    const alice = net.client(101);
    const seen = watch(alice);
    net.flush();
    g.setMode("async");
    const bought = buyOptimistically(alice, 30);
    net.flush();
    await bought;
    expect(seen.subscription.pending()).toBe(true);
    expect(seen.subscription.get()).toEqual({ coins: 70 });
    g.finishLoads();
    net.flush();
    expect(seen.shown).toEqual([100, 70, 70]);
    expect(seen.subscription.pending()).toBe(false);
    net.dispose();
  });

  it("keeps an update through a load that started before the call, until the follow-up", async () => {
    const g = shop();
    const net = network(g);
    const alice = net.client(101);
    const seen = watch(alice);
    net.flush();
    g.setMode("async");
    // A load already running read the wallet before the purchase.
    net.app.resources!.invalidate("economy.wallet", net.player(101));
    const bought = buyOptimistically(alice, 30);
    net.flush();
    await bought;
    g.finishLoads();
    net.flush();
    expect(seen.subscription.pending()).toBe(true);
    expect(seen.subscription.get()).toEqual({ coins: 70 });
    g.finishLoads();
    net.flush();
    expect(seen.subscription.pending()).toBe(false);
    expect(seen.subscription.get()).toEqual({ coins: 70 });
    expect(seen.shown.includes(40)).toBe(false);
    expect(seen.shown[seen.shown.size() - 1]).toBe(70);
    net.dispose();
  });

  it("removes an update with the error item of a load that failed", async () => {
    const g = shop();
    const net = network(g);
    const alice = net.client(101);
    const seen = watch(alice);
    net.flush();
    g.setMode("fail");
    const bought = buyOptimistically(alice, 30);
    net.flush();
    await bought;
    expect(seen.subscription.pending()).toBe(false);
    expect(seen.subscription.status()).toBe("error");
    expect(seen.subscription.get()).toEqual({ coins: 100 });
    expect(seen.shown).toEqual([100, 70, 100]);
    net.dispose();
  });

  it("removes an update when its call times out unanswered", async () => {
    const g = shop();
    const net = network(g);
    const alice = net.client(101);
    const seen = watch(alice);
    net.flush();
    net.link(101).reliable.hold();
    const bought = buyOptimistically(alice, 30);
    net.advance(11_000);
    await expect(bought).rejects.toThrow();
    expect(seen.subscription.pending()).toBe(false);
    expect(seen.subscription.get()).toEqual({ coins: 100 });
    // The server did run it, and its snapshot still arrives.
    net.link(101).reliable.release();
    net.flush();
    expect(seen.subscription.get()).toEqual({ coins: 70 });
    net.dispose();
  });

  it("applies a call's updates once, however many times the call is sent", async () => {
    const g = shop();
    const net = network(g);
    const alice = net.client(101);
    const seen = watch(alice);
    net.flush();
    const first = buyOptimistically(alice, 30, "buy-again");
    const second = buyOptimistically(alice, 30, "buy-again");
    expect(seen.subscription.get()).toEqual({ coins: 70 });
    net.flush();
    await first;
    await second;
    expect(g.coins.get(101)).toBe(70);
    expect(seen.subscription.get()).toEqual({ coins: 70 });
    expect(seen.shown.includes(40)).toBe(false);
    net.dispose();
  });

  it("applies two calls oldest first, each leaving with its own item", async () => {
    const g = shop();
    const net = network(g);
    const alice = net.client(101);
    const seen = watch(alice);
    net.flush();
    g.setMode("async");
    const first = buyOptimistically(alice, 30);
    const second = buyOptimistically(alice, 20);
    net.flush();
    await first;
    await second;
    g.finishLoads();
    net.flush();
    g.finishLoads();
    net.flush();
    expect(seen.shown).toEqual([100, 70, 50, 50, 50]);
    expect(seen.subscription.pending()).toBe(false);
    net.dispose();
  });

  it("drops the updates of a resource the client stops subscribing to", async () => {
    const g = shop();
    const net = network(g);
    const alice = net.client(101);
    const seen = watch(alice);
    net.flush();
    g.setMode("async");
    const bought = buyOptimistically(alice, 30);
    net.flush();
    await bought;
    seen.subscription.disconnect();
    const again = alice.resources.subscribe("economy.wallet", undefined, { optimistic: true });
    expect(again.pending()).toBe(false);
    g.finishLoads();
    net.flush();
    g.finishLoads();
    net.flush();
    expect(again.get()).toEqual({ coins: 70 });
    net.dispose();
  });

  it("drops an update whose item never comes, after the settle timeout", async () => {
    const g = shop();
    const net = network(g);
    const alice = net.client(101);
    const seen = watch(alice);
    net.flush();
    g.setMode("async");
    const bought = buyOptimistically(alice, 30, undefined, 50);
    net.flush();
    await bought;
    expect(seen.subscription.pending()).toBe(true);
    await waitUntil(() => !seen.subscription.pending(), 5000);
    expect(seen.subscription.pending()).toBe(false);
    expect(seen.subscription.get()).toEqual({ coins: 100 });
    net.dispose();
  });
});

// A frame scheduler a spec steps by hand.
function manualFrames() {
  const callbacks = new Array<() => void>();
  const scheduler: WireFrameScheduler = {
    connect: (onFrame) => {
      callbacks.push(onFrame);
      return { Disconnect: () => {} };
    },
  };
  return {
    scheduler,
    step: () => {
      for (const callback of [...callbacks]) {
        callback();
      }
    },
  };
}

describe("optimistic updates on the server", () => {
  it("names a call only to its caller, and keeps both keys when a newer item replaces a queued one", () => {
    let round = 1;
    const board = defineResource({
      id: "arena.board",
      scope: "global",
      schema: schema.object({ round: schema.u16() }),
      load() {
        return { round };
      },
    });
    const host = createResourceHost<Player>({ [board.id]: board });
    const frames = manualFrames();
    const keysByPlayer = new Map<number, string>();
    const channel = createServerChannel<Player>(
      {
        FireClient: (player, frame) => {
          const read = readWireFrame(frame);
          if (read.ok) {
            for (const item of read.items) {
              const keys = (item as { readonly k?: ReadonlyArray<string> }).k;
              keysByPlayer.set(player.UserId, keys !== undefined ? keys.join(",") : "");
            }
          }
        },
        FireAllClients: () => {},
      },
      { frameScheduler: frames.scheduler },
    );
    host.attach(channel);
    const alice = createTestPlayer({ userId: 101 });
    const bob = createTestPlayer({ userId: 202 });
    host.receive(alice, { t: WIRE_ITEM_RESOURCE_SUBSCRIPTION, r: board.id, o: 1 });
    host.receive(bob, { t: WIRE_ITEM_RESOURCE_SUBSCRIPTION, r: board.id, o: 1 });
    frames.step();
    keysByPlayer.clear();

    round = 2;
    host.invalidateForCall(board.id, alice, { caller: alice, key: "a1" });
    round = 3;
    host.invalidateForCall(board.id, alice, { caller: alice, key: "a2" });
    expect(host.pendingTags(alice, "a1")).toEqual([]);
    frames.step();
    expect(keysByPlayer.get(101)).toBe("a1,a2");
    expect(keysByPlayer.get(202)).toBe("");
    host.dispose();
  });

  it("reports a tag as pending until the item that delivers it is queued", () => {
    const waiting = new Array<() => void>();
    const slow = defineResource({
      id: "economy.slow",
      schema: schema.object({ coins: schema.u32() }),
      load() {
        return new Promise<{ coins: number }>((resolve) => {
          waiting.push(() => resolve({ coins: 1 }));
        });
      },
    });
    const host = createResourceHost<Player>({ [slow.id]: slow });
    host.attach(createServerChannel<Player>({ FireClient: () => {}, FireAllClients: () => {} }, { batching: false }));
    const alice = createTestPlayer({ userId: 101 });
    host.receive(alice, { t: WIRE_ITEM_RESOURCE_SUBSCRIPTION, r: slow.id, o: 1 });
    waiting.remove(0)!();
    host.invalidateForCall(slow.id, undefined, { caller: alice, key: "a1" });
    expect(host.pendingTags(alice, "a1")).toEqual([slow.id]);
    waiting.remove(0)!();
    expect(host.pendingTags(alice, "a1")).toEqual([]);
    host.dispose();
  });
});

describe("invokeOptimistic and the bindings", () => {
  function harnessed() {
    const g = shop();
    g.coins.set(1, 100);
    const harness = createTestServerApp({ actions: g.actions, resources: g.resources });
    const player = createTestPlayer({ userId: 1 });
    harness.join(player);
    const client = harness.client(player);
    const buy = (input: { price: number }, options?: ActionInvokeOptions) =>
      client.invoke("shop.buy", input, options) as Promise<boolean>;
    return { g, harness, buy, wallet: resourceBinding<Wallet>("economy.wallet") };
  }

  it("shows the update at once and settles it from the snapshot", async () => {
    const world = harnessed();
    const subscription = world.wallet.subscribe(undefined, { optimistic: true });
    world.g.setMode("async");
    const bought = invokeOptimistic(world.buy, { price: 30 }, (update) =>
      update(world.wallet, (current) => ({ coins: current.coins - 30 })),
    );
    expect(subscription.get()).toEqual({ coins: 70 });
    expect(world.wallet.get()).toEqual({ coins: 100 });
    await bought;
    expect(subscription.pending()).toBe(true);
    world.g.finishLoads();
    await waitUntil(() => !subscription.pending());
    expect(subscription.pending()).toBe(false);
    expect(subscription.get()).toEqual({ coins: 70 });
    world.harness.dispose();
  });

  it("sends nothing and leaves nothing behind when the updates throw", async () => {
    const world = harnessed();
    const subscription = world.wallet.subscribe(undefined, { optimistic: true });
    await expect(
      invokeOptimistic(world.buy, { price: 30 }, () => {
        throw "broken update";
      }),
    ).rejects.toThrow("broken update");
    expect(world.g.coins.get(1)).toBe(100);
    expect(subscription.pending()).toBe(false);
    world.harness.dispose();
  });

  it("ignores an update of a resource the client does not subscribe to", async () => {
    const world = harnessed();
    await invokeOptimistic(world.buy, { price: 30 }, (update) =>
      update(world.wallet, (current) => ({ coins: current.coins - 30 })),
    );
    expect(world.g.coins.get(1)).toBe(70);
    const subscription = world.wallet.subscribe(undefined, { optimistic: true });
    expect(subscription.pending()).toBe(false);
    world.harness.dispose();
  });

  it("puts a call's updates in the view a component reads", async () => {
    const world = harnessed();
    const observation = observeResource(world.wallet);
    world.g.setMode("async");
    const action = observeAction(world.buy, {
      optimistic: (input, update) => update(world.wallet, (current) => ({ coins: current.coins - input.price })),
    });
    action.invoke({ price: 30 });
    expect(observation.current().value).toEqual({ coins: 70 });
    expect(observation.current().serverValue).toEqual({ coins: 100 });
    expect(observation.current().pending).toBe(true);
    await waitUntil(() => action.current().status === "success");
    world.g.finishLoads();
    await waitUntil(() => !observation.current().pending);
    expect(observation.current().value).toEqual({ coins: 70 });
    expect(observation.current().serverValue).toEqual({ coins: 70 });
    observation.release();
    world.harness.dispose();
  });
});
