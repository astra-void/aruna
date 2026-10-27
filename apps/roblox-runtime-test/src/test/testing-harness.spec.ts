// The consumer-facing test surface (`aruna/testing`): the harness must exercise
// the *real* dispatch path — validation, rate limiting, middleware, sessions,
// signal publication — rather than a simplified stand-in, because a spec written
// against it is only worth as much as its fidelity to production.
//
// Port of packages/aruna/test/testing-harness.test.ts. The native harness exposes
// `published` / `players` as functions rather than properties.
import { clearActionInvoker } from "aruna/client";
import { defineAction, defineSignal } from "aruna/roblox";
import { schema } from "aruna/schema";
import { createActionDefiner, type ActionMiddleware } from "aruna/server";
import {
  afterEach,
  createTestPlayer,
  createTestServerApp,
  describe,
  expect,
  it,
} from "aruna/testing";

const signals = {
  "shop.purchased": defineSignal({
    id: "shop.purchased",
    payload: schema.object({ item: schema.string() }),
  }),
} as const;

const buy = defineAction({
  id: "shop.buy",
  input: schema.object({ item: schema.string(), quantity: schema.u8() }),
  output: schema.object({ ok: schema.boolean() }),
  run(ctx, input) {
    ctx.publisher?.to(ctx.player, "shop.purchased", { item: input.item });
    return { ok: input.quantity > 0 };
  },
});

const actions = { "shop.buy": buy };

describe("createTestServerApp", () => {
  afterEach(() => {
    clearActionInvoker();
  });

  it("dispatches through validation and returns the action output", async () => {
    const harness = createTestServerApp({ actions });
    const player = createTestPlayer({ name: "Ada" });

    expect(await harness.invoke(player, "shop.buy", { item: "sword", quantity: 1 })).toEqual({
      ok: true,
    });

    harness.dispose();
  });

  it("rejects input the schema does not accept", async () => {
    const harness = createTestServerApp({ actions });
    const player = createTestPlayer();

    await expect(
      harness.invoke(player, "shop.buy", { item: "sword", quantity: "many" }),
    ).rejects.toThrow("quantity");
    await expect(
      harness.invoke(player, "shop.buy", { item: "sword", quantity: "many" }),
    ).rejects.toThrow("input validation failed");

    harness.dispose();
  });

  it("shows a spec the real failure rather than the masked one", async () => {
    const harness = createTestServerApp({
      actions: {
        "shop.boom": defineAction({
          id: "shop.boom",
          run() {
            throw "kaboom";
          },
        }),
      },
    });

    await expect(harness.invoke(createTestPlayer(), "shop.boom")).rejects.toThrow("kaboom");

    harness.dispose();
  });

  it("records every signal the action publishes, with its recipient", async () => {
    const harness = createTestServerApp({ actions, signals });
    const player = createTestPlayer({ name: "Grace" });

    await harness.invoke(player, "shop.buy", { item: "shield", quantity: 2 });

    expect(harness.published()).toEqual([
      { signalId: "shop.purchased", payload: { item: "shield" }, player },
    ]);
    // The recipient is the very player double, not a structural copy.
    expect(harness.published()[0]?.player).toBe(player);
    // takePublished drains, so the next assertion starts from empty.
    expect(harness.takePublished()).toHaveLength(1);
    expect(harness.published()).toHaveLength(0);

    harness.dispose();
  });

  it("validates published payloads the way the real publisher does", async () => {
    const broken = defineAction({
      id: "shop.broken",
      run(ctx) {
        // The payload schema wants { item: string }.
        (ctx.publisher as unknown as { toAll: (id: string, payload: unknown) => void }).toAll(
          "shop.purchased",
          { item: 42 },
        );
        return undefined;
      },
    });
    const harness = createTestServerApp({
      actions: { "shop.broken": broken },
      signals,
    });

    // The publisher validates the payload against the signal schema before it
    // would touch the wire, so the action's own dispatch rejects.
    const pending = harness.invoke(createTestPlayer(), "shop.broken", undefined);
    await expect(pending).rejects.toThrow("shop.purchased");
    await expect(pending).rejects.toThrow("item: expected string");

    harness.dispose();
  });

  it("drives the player lifecycle: sessions, hooks, and boot state", async () => {
    const joined = new Array<string>();
    const left = new Array<string>();
    const definer = createActionDefiner<typeof signals, Player, { visits: number }>();
    const whoami = definer({
      id: "session.whoami",
      run(ctx) {
        return { visits: ctx.session.visits, name: ctx.player.Name };
      },
    });

    const harness = createTestServerApp<Player, typeof signals, { visits: number }>({
      actions: { "session.whoami": whoami },
      signals,
      createSession: () => ({ visits: 1 }),
      onPlayerAdded: (player) => {
        joined.push(player.Name);
      },
      onPlayerRemoving: (player) => {
        left.push(player.Name);
      },
    });

    const player = createTestPlayer({ name: "Linus" });
    harness.join(player);
    expect(joined).toEqual(["Linus"]);
    expect(harness.players()).toEqual([player]);

    expect(await harness.invoke(player, "session.whoami", undefined)).toEqual({
      visits: 1,
      name: "Linus",
    });

    harness.leave(player);
    expect(left).toEqual(["Linus"]);
    expect(harness.players()).toEqual([]);

    harness.dispose();
  });

  it("enforces the app's rate limit", async () => {
    const ping = defineAction({
      id: "ping",
      rateLimit: { key: "player", windowMs: 60_000, max: 1 },
      run() {
        return "pong";
      },
    });
    const harness = createTestServerApp({ actions: { ping } });
    const player = createTestPlayer();

    expect(await harness.invoke(player, "ping", undefined)).toBe("pong");
    await expect(harness.invoke(player, "ping", undefined)).rejects.toThrow("rate limited");

    harness.dispose();
  });

  it("crosses a rate-limit window when the spec advances the clock", async () => {
    const ping = defineAction({
      id: "ping",
      rateLimit: { key: "player", windowMs: 60_000, max: 1 },
      run() {
        return "pong";
      },
    });
    const harness = createTestServerApp({ actions: { ping } });
    const player = createTestPlayer();

    expect(await harness.invoke(player, "ping", undefined)).toBe("pong");
    await expect(harness.invoke(player, "ping", undefined)).rejects.toThrow("rate limited");

    // The clock is frozen, so the window elapses only here — no real waiting.
    harness.advance(60_000);
    expect(await harness.invoke(player, "ping", undefined)).toBe("pong");

    harness.dispose();
  });

  it("refuses to advance a clock the caller owns", () => {
    const harness = createTestServerApp({
      actions: {
        ping: defineAction({
          id: "ping",
          run() {
            return "pong";
          },
        }),
      },
      nowMs: () => 1_000,
    });

    expect(() => harness.advance(1_000)).toThrow("given its own nowMs");

    harness.dispose();
  });

  it("runs middleware around the action", async () => {
    const seen = new Array<string>();
    const ping = defineAction({
      id: "ping",
      run() {
        return "pong";
      },
    });
    const around: ActionMiddleware<Player> = async (info, proceed) => {
      seen.push(`before:${info.actionId}`);
      const output = await proceed();
      seen.push("after");
      return output;
    };
    const harness = createTestServerApp({
      actions: { ping },
      middleware: [around],
    });

    await harness.invoke(createTestPlayer(), "ping", undefined);
    expect(seen).toEqual(["before:ping", "after"]);

    harness.dispose();
  });
});

describe("TestServerApp.client", () => {
  afterEach(() => {
    clearActionInvoker();
  });

  it("invokes actions through a client app bound to the server", async () => {
    const harness = createTestServerApp({ actions });
    const player = createTestPlayer();
    const client = harness.client(player);

    expect(await client.invoke("shop.buy", { item: "potion", quantity: 3 })).toEqual({
      ok: true,
    });

    harness.dispose();
  });

  it("delivers signals published to that player to the client subscriber", async () => {
    const harness = createTestServerApp({ actions, signals });
    const player = createTestPlayer();
    const other = createTestPlayer();
    const client = harness.client(player);

    const received = new Array<defined>();
    client.subscriber?.on("shop.purchased", (payload) => {
      received.push(payload as defined);
    });

    await harness.invoke(player, "shop.buy", { item: "rope", quantity: 1 });
    expect(received).toEqual([{ item: "rope" }]);

    // A signal aimed at someone else must not reach this client.
    await harness.invoke(other, "shop.buy", { item: "lamp", quantity: 1 });
    expect(received).toEqual([{ item: "rope" }]);

    harness.dispose();
  });
});
