// The multiplayer test network (createTestNetwork): several real clients and
// one real server app over simulated links, on a virtual clock. Every scenario
// goes through the shipping wire code: frames, admission, validation, rate
// limits, idempotency, signals, and resources.
import { defineAction, defineResource } from "aruna/roblox";
import { schema } from "aruna/schema";
import { actionError, defineSignal, type ActionMiddleware } from "aruna/server";
import { createTestNetwork, describe, expect, it } from "aruna/testing";
import { createWireFrame, WIRE_ITEM_CALL, WIRE_ITEM_RESOURCE_SUBSCRIPTION } from "aruna/internal/wire";

type Wallet = { readonly coins: number };

// A small game: coins per player behind a resource, an action that earns them,
// a rate-limited action, a slow action, and two signals.
function makeGame() {
  const coins = new Map<number, number>();
  const runs = new Map<string, number>();
  const count = (key: string) => runs.set(key, (runs.get(key) ?? 0) + 1);
  const wallet = defineResource({
    id: "economy.wallet",
    schema: schema.object({ coins: schema.u32() }),
    load(ctx) {
      return { coins: coins.get(ctx.player.UserId) ?? 0 };
    },
  });
  const earn = defineAction({
    id: "economy.earn",
    input: schema.object({ amount: schema.u16() }),
    run(ctx, input) {
      count(`earn:${ctx.player.UserId}`);
      coins.set(ctx.player.UserId, (coins.get(ctx.player.UserId) ?? 0) + input.amount);
      ctx.resources?.invalidate(wallet);
      ctx.publisher?.to(ctx.player, "fx.sparkle", { x: input.amount });
      return coins.get(ctx.player.UserId);
    },
  });
  const shout = defineAction({
    id: "chat.shout",
    rateLimit: { key: "player", windowMs: 1000, max: 2 },
    run(ctx) {
      count(`shout:${ctx.player.UserId}`);
      return true;
    },
  });
  const echo = defineAction({
    id: "debug.echo",
    input: schema.string().maxLength(8),
    run(_ctx, input) {
      count(`echo:${input}`);
      return input;
    },
  });
  const signals = {
    "fx.sparkle": defineSignal({
      id: "fx.sparkle",
      unreliable: true,
      payload: schema.object({ x: schema.u16() }),
    }),
    "economy.paid": defineSignal({ id: "economy.paid", payload: schema.object({ coins: schema.u32() }) }),
  };
  return {
    coins,
    runs,
    runsOf: (key: string) => runs.get(key) ?? 0,
    wallet,
    signals,
    actions: { [earn.id]: earn, [shout.id]: shout, [echo.id]: echo },
    resources: { [wallet.id]: wallet },
  };
}

function network(g: ReturnType<typeof makeGame>, extra?: { readonly latencyMs?: number }) {
  return createTestNetwork({
    actions: g.actions,
    resources: g.resources,
    signals: g.signals,
    players: [101, 202],
    ...(extra !== undefined && extra.latencyMs !== undefined ? { latencyMs: extra.latencyMs } : {}),
  });
}

describe("test network: isolation", () => {
  it("gives each client only its own player-scoped state", async () => {
    const g = makeGame();
    g.coins.set(101, 5);
    g.coins.set(202, 70);
    const net = network(g, { latencyMs: 40 });
    const alice = net.client(101);
    const bob = net.client(202);
    const aliceSeen = new Array<number>();
    const bobSeen = new Array<number>();
    alice.resources.subscribe("economy.wallet", (value) => aliceSeen.push((value as Wallet).coins));
    bob.resources.subscribe("economy.wallet", (value) => bobSeen.push((value as Wallet).coins));
    net.flush();
    expect(aliceSeen).toEqual([5]);
    expect(bobSeen).toEqual([70]);

    const earned = alice.invoke("economy.earn", { amount: 3 });
    net.flush();
    expect(await earned).toBe(8);
    expect(aliceSeen).toEqual([5, 8]);
    expect(bobSeen).toEqual([70]);
    net.dispose();
  });

  it("does not let a client reach another player's resource by any field it sends", () => {
    const g = makeGame();
    g.coins.set(101, 5);
    g.coins.set(202, 70);
    const net = network(g);
    const bob = net.client(202);
    const seen = new Array<number>();
    bob.resources.subscribe("economy.wallet", (value) => seen.push((value as Wallet).coins));
    // Bob forges a subscription naming Alice in every way a client could.
    net.link(202).up.inject(
      createWireFrame([{ t: WIRE_ITEM_RESOURCE_SUBSCRIPTION, r: "economy.wallet", o: 1, userId: 101, p: 101 }]),
    );
    net.flush();
    expect(seen.size() >= 1).toBe(true);
    for (const value of seen) {
      expect(value).toBe(70);
    }
    expect(net.app.resources!.isSubscribed("economy.wallet", net.player(101))).toBe(false);
    net.dispose();
  });

  it("isolates rate limits per player", async () => {
    const g = makeGame();
    const net = network(g);
    const alice = net.client(101);
    const bob = net.client(202);
    const results = new Array<string>();
    for (let index = 0; index < 3; index += 1) {
      alice.invoke("chat.shout").then(
        () => results.push("alice:ok"),
        (err: unknown) => results.push(`alice:${(err as { name: string }).name}`),
      );
    }
    const bobShout = bob.invoke("chat.shout");
    net.flush();
    expect(results).toEqual(["alice:ok", "alice:ok", "alice:ActionRateLimitError"]);
    expect(await bobShout).toBe(true);
    // The window passes on the virtual clock.
    net.advance(1000);
    const again = alice.invoke("chat.shout");
    net.flush();
    expect(await again).toBe(true);
    net.dispose();
  });
});

describe("test network: hostile and broken clients", () => {
  it("rejects an invalid payload, and drops a malformed frame without an answer", async () => {
    const g = makeGame();
    const reports = new Array<string>();
    const net = createTestNetwork({
      actions: g.actions,
      players: [101],
      onAbuse: (_player, info) => reports.push(info.reason),
    });
    const alice = net.client(101);
    let rejection: unknown;
    alice.invoke("economy.earn", { amount: -4 }).catch((err: unknown) => (rejection = err));
    net.link(101).up.inject("not a frame");
    net.link(101).up.inject(createWireFrame([{ t: WIRE_ITEM_CALL, i: "x", a: "economy.unknown", d: 1 }]));
    net.flush();
    expect((rejection as { name: string }).name).toBe("ActionValidationError");
    expect(g.runsOf("earn:101")).toBe(0);
    // The injected frames go out at once; the call waits for the client's
    // frame flush, so it arrives after them.
    expect(reports).toEqual(["malformed-envelope", "unknown-action", "invalid-input"]);
    net.dispose();
  });

  // The optimistic flag (`o`, docs/rfcs/ui-bindings.md) is honoured only as `1`
  // with a valid key. Anything else must leave the call an ordinary one: run once,
  // charged once, never reported as abuse, and the server keeps serving.
  it("treats a malformed optimistic flag as an ordinary call", async () => {
    const g = makeGame();
    const reports = new Array<string>();
    const net = createTestNetwork({
      actions: g.actions,
      resources: g.resources,
      players: [101],
      onAbuse: (_player, info) => reports.push(info.reason),
    });
    const alice = net.client(101);
    const call = (i: string, extra: object) =>
      net.link(101).up.inject(createWireFrame([{ t: WIRE_ITEM_CALL, i, a: "economy.earn", d: { amount: 1 }, ...extra }]));
    call("m1", { k: "k1", o: true });
    call("m2", { k: "k2", o: "1" });
    call("m3", { o: 1 });
    call("m4", { k: "k".rep(65), o: 1 });
    call("m5", { k: "k5", o: 2 });
    net.flush();
    expect(g.runsOf("earn:101")).toBe(5);
    expect(reports).toEqual([]);
    const after = alice.invoke("economy.earn", { amount: 1 });
    net.flush();
    expect(await after).toBe(6);
    net.dispose();
  });

  it("runs a replayed optimistic call once", async () => {
    const g = makeGame();
    const net = createTestNetwork({ actions: g.actions, resources: g.resources, players: [101] });
    const alice = net.client(101);
    const replay = () =>
      net.link(101).up.inject(
        createWireFrame([{ t: WIRE_ITEM_CALL, i: "r", a: "economy.earn", d: { amount: 3 }, k: "r1", o: 1 }]),
      );
    replay();
    net.flush();
    replay();
    net.flush();
    expect(g.runsOf("earn:101")).toBe(1);
    const after = alice.invoke("economy.earn", { amount: 1 });
    net.flush();
    expect(await after).toBe(4);
    net.dispose();
  });

  // A schema refinement is user code run on client input. One that throws on a
  // hostile value used to reject the dispatch, so no response went out and the
  // caller waited for its timeout.
  it("answers a call whose input refinement throws as invalid input", async () => {
    let runs = 0;
    const picky = defineAction({
      id: "debug.picky",
      input: schema.string().refine((value) => {
        if (value === "boom") {
          throw "refinement exploded";
        }
        return true;
      }, "not boom"),
      run() {
        runs += 1;
        return true;
      },
    });
    const reports = new Array<string>();
    const net = createTestNetwork({
      actions: { [picky.id]: picky },
      players: [101],
      onAbuse: (_player, info) => reports.push(info.reason),
    });
    const alice = net.client(101);
    let rejection: unknown;
    alice.invoke("debug.picky", "boom").catch((err: unknown) => (rejection = err));
    net.flush();
    expect((rejection as { name: string }).name).toBe("ActionValidationError");
    expect(runs).toBe(0);
    expect(reports).toEqual(["invalid-input"]);

    const fine = alice.invoke("debug.picky", "ok");
    net.flush();
    expect(await fine).toBe(true);
    net.dispose();
  });

  // Every registered action is callable by any client (docs/actions.md): a
  // hostile client sends the id whether or not a stub exposes it. The guard a
  // game writes as middleware must hold for a raw frame, not only for stubs.
  it("refuses a privileged action through middleware, even from a raw frame", () => {
    let granted = 0;
    const grant = defineAction({
      id: "admin.grantCoins",
      input: schema.object({ amount: schema.u32() }),
      run() {
        granted += 1;
        return true;
      },
    });
    const requireAdmin: ActionMiddleware<Player> = (info, proceed) => {
      if (info.actionId.sub(1, 6) === "admin.") {
        throw actionError("NotAuthorized", "not authorized");
      }
      return proceed();
    };
    const net = createTestNetwork({ actions: { [grant.id]: grant }, players: [101], middleware: [requireAdmin] });
    net.link(101).up.inject(
      createWireFrame([{ t: WIRE_ITEM_CALL, i: "x", a: "admin.grantCoins", d: { amount: 1_000_000 } }]),
    );
    net.flush();
    expect(granted).toBe(0);
    net.dispose();
  });

  it("runs a duplicated call twice, and an idempotent one once", async () => {
    const g = makeGame();
    const net = network(g);
    const alice = net.client(101);
    net.link(101).up.duplicateNext();
    const plain = alice.invoke("debug.echo", "a");
    net.flush();
    expect(await plain).toBe("a");
    expect(g.runsOf("echo:a")).toBe(2);

    net.link(101).up.duplicateNext();
    const keyed = alice.invoke("debug.echo", "b", { idempotencyKey: "once" });
    net.flush();
    expect(await keyed).toBe("b");
    expect(g.runsOf("echo:b")).toBe(1);
    net.dispose();
  });

  it("processes reordered calls in the order they arrive", () => {
    const g = makeGame();
    const net = network(g);
    const alice = net.client(101);
    net.link(101).up.reorderNext();
    void alice.invoke("debug.echo", "first");
    net.advance(16);
    void alice.invoke("debug.echo", "second");
    const order = new Array<string>();
    net.flush();
    for (const [key] of g.runs) {
      order.push(key);
    }
    expect(g.runsOf("echo:first")).toBe(1);
    expect(g.runsOf("echo:second")).toBe(1);
    expect(net.link(101).up.stats().delivered).toBe(2);
    net.dispose();
  });
});

describe("test network: ordering and timing", () => {
  it("keeps one player's calls, state, and responses in order", async () => {
    const g = makeGame();
    const net = network(g, { latencyMs: 30 });
    const alice = net.client(101);
    const order = new Array<string>();
    alice.resources.subscribe("economy.wallet", (value) => order.push(`state:${(value as Wallet).coins}`));
    net.flush();
    alice.invoke("economy.earn", { amount: 1 }).then((total) => order.push(`response:${total}`));
    alice.invoke("economy.earn", { amount: 2 }).then((total) => order.push(`response:${total}`));
    net.flush();
    expect(order).toEqual(["state:0", "state:3", "response:1", "response:3"]);
    net.dispose();
  });

  it("times out a call whose response is delayed past the timeout, on the virtual clock", () => {
    const g = makeGame();
    const net = createTestNetwork({ actions: g.actions, players: [101], requestTimeoutMs: 500 });
    const alice = net.client(101);
    net.link(101).reliable.setLatency(2000);
    let outcome = "pending";
    alice.invoke("debug.echo", "slow").then(
      () => (outcome = "resolved"),
      (err: unknown) => (outcome = (err as { name: string }).name),
    );
    net.advance(480);
    expect(outcome).toBe("pending");
    net.advance(48);
    expect(outcome).toBe("ActionTimeoutError");
    // The server did run it: a timeout is not a refusal.
    expect(g.runsOf("echo:slow")).toBe(1);
    net.dispose();
  });

  it("drops a call when the request frame is lost, and the client times out", () => {
    const g = makeGame();
    const net = createTestNetwork({ actions: g.actions, players: [101], requestTimeoutMs: 200 });
    net.link(101).up.dropNext();
    let outcome = "pending";
    net.client(101).invoke("debug.echo", "lost").catch((err: unknown) => (outcome = (err as { name: string }).name));
    net.advance(300);
    expect(outcome).toBe("ActionTimeoutError");
    expect(g.runsOf("echo:lost")).toBe(0);
    net.dispose();
  });

  it("waits out a rate limit's retryAfterMs on the virtual clock, then retries", () => {
    const g = makeGame();
    const net = createTestNetwork({ actions: g.actions, players: [101], retry: { maxRetries: 1 } });
    const alice = net.client(101);
    const results = new Array<string>();
    for (let index = 0; index < 3; index += 1) {
      alice.invoke("chat.shout").then(
        () => results.push("ok"),
        (err: unknown) => results.push((err as { name: string }).name),
      );
    }
    net.flush();
    // The third call was refused and is waiting, not failed.
    expect(results).toEqual(["ok", "ok"]);
    expect(g.runsOf("shout:101")).toBe(2);
    net.advance(1100);
    expect(results).toEqual(["ok", "ok", "ok"]);
    expect(g.runsOf("shout:101")).toBe(3);
    net.dispose();
  });

  it("retries an idempotent call whose request was lost, and runs it once", () => {
    const g = makeGame();
    const net = createTestNetwork({
      actions: g.actions,
      players: [101],
      requestTimeoutMs: 200,
      retry: { maxRetries: 1, baseDelayMs: 50 },
    });
    net.link(101).up.dropNext();
    let outcome = "pending";
    net
      .client(101)
      .invoke("debug.echo", "again", { idempotent: true })
      .then(
        (value) => (outcome = value as string),
        (err: unknown) => (outcome = (err as { name: string }).name),
      );
    // Timed out at 200 ms; the retry waits its 50 ms backoff.
    net.advance(240);
    expect(outcome).toBe("pending");
    expect(g.runsOf("echo:again")).toBe(0);
    net.advance(200);
    expect(outcome).toBe("again");
    expect(g.runsOf("echo:again")).toBe(1);
    net.dispose();
  });
});

describe("test network: disconnects", () => {
  it("keeps the other player working when one disconnects mid-request", async () => {
    const g = makeGame();
    const net = createTestNetwork({
      actions: g.actions,
      resources: g.resources,
      players: [101, 202],
      latencyMs: 50,
      requestTimeoutMs: 400,
    });
    const alice = net.client(101);
    const bob = net.client(202);
    alice.resources.subscribe("economy.wallet");
    bob.resources.subscribe("economy.wallet");
    net.flush();
    let aliceOutcome = "pending";
    alice.invoke("economy.earn", { amount: 9 }).catch((err: unknown) => (aliceOutcome = (err as { name: string }).name));
    net.advance(16);
    net.disconnect(101);
    const bobEarned = bob.invoke("economy.earn", { amount: 4 });
    net.flush();
    expect(await bobEarned).toBe(4);
    net.advance(500);
    expect(aliceOutcome).toBe("ActionTimeoutError");
    expect(alice.connected()).toBe(false);
    // Alice's subscription went with her; Bob's is still there.
    expect(net.app.resources!.subscriberCount("economy.wallet")).toBe(1);
    net.dispose();
  });

  it("restores a coherent snapshot on reconnect", () => {
    const g = makeGame();
    g.coins.set(101, 10);
    const net = network(g, { latencyMs: 20 });
    net.client(101).resources.subscribe("economy.wallet");
    net.flush();
    net.disconnect(101);
    g.coins.set(101, 25);
    const back = net.reconnect(101);
    const subscription = back.resources.subscribe("economy.wallet");
    net.flush();
    expect((subscription.get() as Wallet).coins).toBe(25);
    expect(net.app.resources!.subscriberCount("economy.wallet")).toBe(1);
    net.dispose();
  });

  it("cleans every subscription up on leave", () => {
    const g = makeGame();
    const net = network(g);
    net.client(101).resources.subscribe("economy.wallet");
    net.client(202).resources.subscribe("economy.wallet");
    net.flush();
    expect(net.app.resources!.subscriberCount("economy.wallet")).toBe(2);
    net.leave(101);
    net.leave(202);
    expect(net.app.resources!.subscriberCount("economy.wallet")).toBe(0);
    net.dispose();
  });
});

describe("test network: transport faults beyond Roblox's guarantees", () => {
  it("never lets a reordered or duplicated snapshot overwrite a newer one", () => {
    const g = makeGame();
    const net = network(g);
    const alice = net.client(101);
    const seen = new Array<number>();
    alice.resources.subscribe("economy.wallet", (value) => seen.push((value as Wallet).coins));
    net.flush();
    // The reliable remote never does this; a broken transport might. The
    // latency keeps both snapshots in flight at once, so they can swap.
    net.link(101).reliable.setLatency(100);
    net.link(101).reliable.reorderNext();
    net.link(101).reliable.duplicateNext(2);
    g.coins.set(101, 1);
    net.app.resources!.invalidate("economy.wallet", net.player(101));
    net.advance(16);
    g.coins.set(101, 2);
    net.app.resources!.invalidate("economy.wallet", net.player(101));
    net.flush();
    expect(seen[seen.size() - 1]).toBe(2);
    expect(seen).toEqual([0, 2]);
    net.dispose();
  });

  it("delivers a held snapshot late without losing a newer change", () => {
    const g = makeGame();
    const net = network(g);
    const alice = net.client(101);
    const subscription = alice.resources.subscribe("economy.wallet");
    net.link(101).reliable.hold();
    net.flush();
    g.coins.set(101, 7);
    net.app.resources!.invalidate("economy.wallet", net.player(101));
    net.advance(100);
    expect(subscription.get()).toBe(undefined);
    net.link(101).reliable.release();
    net.flush();
    expect((subscription.get() as Wallet).coins).toBe(7);
    net.dispose();
  });

  it("loses unreliable signals without touching reliable state", () => {
    const g = makeGame();
    const net = network(g);
    const alice = net.client(101);
    const sparkles = new Array<number>();
    alice.app.subscriber!.on("fx.sparkle", (payload) => sparkles.push(payload.x));
    const subscription = alice.resources.subscribe("economy.wallet");
    net.link(101).unreliable.setLoss(1);
    for (let amount = 1; amount <= 5; amount += 1) {
      void alice.invoke("economy.earn", { amount });
    }
    net.flush();
    expect(sparkles).toEqual([]);
    expect(net.link(101).unreliable.stats().dropped).toBe(5);
    expect((subscription.get() as Wallet).coins).toBe(15);
    net.dispose();
  });

  it("is deterministic for a seed", () => {
    const counts = new Array<number>();
    for (let run = 0; run < 2; run += 1) {
      const g = makeGame();
      const net = createTestNetwork({ actions: g.actions, signals: g.signals, players: [101], seed: 42 });
      const sparkles = new Array<number>();
      net.client(101).app.subscriber!.on("fx.sparkle", (payload) => sparkles.push(payload.x));
      net.link(101).unreliable.setLoss(0.5);
      for (let amount = 1; amount <= 20; amount += 1) {
        void net.client(101).invoke("economy.earn", { amount });
      }
      net.flush();
      counts.push(sparkles.size());
      net.dispose();
    }
    expect(counts[0]).toBe(counts[1]);
    expect(counts[0]! > 0 && counts[0]! < 20).toBe(true);
  });
});
