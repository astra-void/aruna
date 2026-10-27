// Server-side de-duplication of retried calls. A retrying client sends one
// idempotency key with every attempt of a call; the server must run the action
// once and give every attempt the same result.
import { defineAction } from "aruna/roblox";
import { createServerApp } from "aruna/server";
import { createTestPlayer, createTestServerApp, describe, expect, it } from "aruna/testing";
import { IDEMPOTENCY_MAX_ENTRIES_PER_PLAYER, IDEMPOTENCY_TTL_MS } from "aruna/internal/idempotency";
import { robloxRemoteEvent } from "aruna/roblox";
import { rejectionOf, wireRemote } from "./support";

function counterActions() {
  const calls = { count: 0 };
  let release: (() => void) | undefined;
  const actions = {
    "shop.buy": defineAction({
      id: "shop.buy",
      async run() {
        calls.count += 1;
        if (release === undefined) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { order: calls.count };
      },
    }),
    "shop.limited": defineAction({
      id: "shop.limited",
      rateLimit: { key: "player", windowMs: 1000, max: 1 },
      run() {
        calls.count += 1;
        return { order: calls.count };
      },
    }),
  };
  return {
    actions,
    calls,
    // Lets every pending and later `shop.buy` run finish.
    releaseAll() {
      const pending = release;
      release = () => undefined;
      if (pending !== undefined) {
        pending();
      }
    },
  };
}

describe("idempotency keys", () => {
  it("runs a duplicate key once and gives both callers the same result", async () => {
    const fixture = counterActions();
    const harness = createTestServerApp({ actions: fixture.actions });
    const player = createTestPlayer();

    const first = harness.invoke(player, "shop.buy", undefined, { idempotencyKey: "k1" });
    // Arrives while the first is still in flight: attaches to it.
    const second = harness.invoke(player, "shop.buy", undefined, { idempotencyKey: "k1" });
    fixture.releaseAll();

    const firstOutput = await first;
    const secondOutput = await second;
    expect(fixture.calls.count).toBe(1);
    expect(secondOutput).toBe(firstOutput);

    // Arrives after it settled: gets the remembered result.
    const third = await harness.invoke(player, "shop.buy", undefined, { idempotencyKey: "k1" });
    expect(third).toBe(firstOutput);
    expect(fixture.calls.count).toBe(1);
    harness.dispose();
  });

  it("runs again once the remembered result expires", async () => {
    const fixture = counterActions();
    fixture.releaseAll();
    const harness = createTestServerApp({ actions: fixture.actions });
    const player = createTestPlayer();

    await harness.invoke(player, "shop.buy", undefined, { idempotencyKey: "k1" });
    harness.advance(IDEMPOTENCY_TTL_MS + 1);
    await harness.invoke(player, "shop.buy", undefined, { idempotencyKey: "k1" });

    expect(fixture.calls.count).toBe(2);
    harness.dispose();
  });

  it("keeps keys apart per player and per action, and without a key", async () => {
    const fixture = counterActions();
    fixture.releaseAll();
    const harness = createTestServerApp({ actions: fixture.actions });
    const ada = createTestPlayer({ name: "Ada" });
    const bo = createTestPlayer({ name: "Bo" });

    await harness.invoke(ada, "shop.buy", undefined, { idempotencyKey: "k1" });
    await harness.invoke(bo, "shop.buy", undefined, { idempotencyKey: "k1" });
    await harness.invoke(ada, "shop.limited", undefined, { idempotencyKey: "k1" });
    await harness.invoke(ada, "shop.buy");
    await harness.invoke(ada, "shop.buy");

    expect(fixture.calls.count).toBe(5);
    harness.dispose();
  });

  it("does not remember a call refused before it ran", async () => {
    const fixture = counterActions();
    const harness = createTestServerApp({ actions: fixture.actions });
    const player = createTestPlayer();

    await harness.invoke(player, "shop.limited");
    // Rate limited: the action did not run, so the retry after the window must.
    const refused = await rejectionOf(
      harness.invoke(player, "shop.limited", undefined, { idempotencyKey: "k1" }),
    );
    expect(refused.name).toBe("ActionRateLimitError");
    harness.advance(1000);
    const output = await harness.invoke(player, "shop.limited", undefined, {
      idempotencyKey: "k1",
    });
    expect(output).toEqual({ order: 2 });
    expect(fixture.calls.count).toBe(2);
    harness.dispose();
  });

  it("forgets a player's keys when they leave", async () => {
    const fixture = counterActions();
    fixture.releaseAll();
    const harness = createTestServerApp({ actions: fixture.actions });
    const player = createTestPlayer();
    harness.join(player);

    await harness.invoke(player, "shop.buy", undefined, { idempotencyKey: "k1" });
    harness.leave(player);
    await harness.invoke(player, "shop.buy", undefined, { idempotencyKey: "k1" });

    expect(fixture.calls.count).toBe(2);
    harness.dispose();
  });

  it("evicts the oldest key past the per-player bound", async () => {
    const fixture = counterActions();
    fixture.releaseAll();
    const harness = createTestServerApp({ actions: fixture.actions });
    const player = createTestPlayer();

    for (let index = 0; index <= IDEMPOTENCY_MAX_ENTRIES_PER_PLAYER; index += 1) {
      await harness.invoke(player, "shop.buy", undefined, { idempotencyKey: `k${index}` });
    }
    const runs = fixture.calls.count;
    // The newest is still remembered; the first was evicted.
    await harness.invoke(player, "shop.buy", undefined, {
      idempotencyKey: `k${IDEMPOTENCY_MAX_ENTRIES_PER_PLAYER}`,
    });
    expect(fixture.calls.count).toBe(runs);
    await harness.invoke(player, "shop.buy", undefined, { idempotencyKey: "k0" });
    expect(fixture.calls.count).toBe(runs + 1);
    harness.dispose();
  });

  it("reads the key from the wire envelope and ignores an invalid one", async () => {
    const fixture = counterActions();
    fixture.releaseAll();
    const app = createServerApp({ actions: fixture.actions, transport: robloxRemoteEvent() });
    const wire = wireRemote();

    await wire.send("r1", "shop.buy", undefined, "k1");
    await wire.send("r2", "shop.buy", undefined, "k1");
    expect(fixture.calls.count).toBe(1);
    // Each attempt is answered under its own request id, with the same output.
    expect(wire.responses()).toEqual([
      { requestId: "r1", result: { ok: true, output: { order: 1 } } },
      { requestId: "r2", result: { ok: true, output: { order: 1 } } },
    ]);

    // Too long, or not a string: dispatched as if there were no key.
    await wire.send("r3", "shop.buy", undefined, "x".rep(65));
    await wire.send("r4", "shop.buy", undefined, "x".rep(65));
    await wire.send("r5", "shop.buy", undefined, 42);
    await wire.send("r6", "shop.buy", undefined, 42);
    expect(fixture.calls.count).toBe(5);
    wire.dispose();
    app.dispose();
  });
});
