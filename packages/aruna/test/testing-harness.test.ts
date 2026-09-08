// The consumer-facing test surface (`aruna/testing`): the harness must exercise
// the *real* dispatch path — validation, rate limiting, middleware, sessions,
// signal publication — rather than a simplified stand-in, because a spec written
// against it is only worth as much as its fidelity to production.
import { afterEach, describe, expect, it } from "vitest";
import { createActionDefiner, defineAction, defineSignal } from "../src/server.js";
import { schema } from "../src/schema.js";
import {
  createTestPlayer,
  createTestServerApp,
  type TestPlayer,
} from "../src/testing.js";
import { clearActionInvoker } from "../src/client.js";

afterEach(() => {
  clearActionInvoker();
});

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
  it("dispatches through validation and returns the action output", async () => {
    const harness = createTestServerApp<TestPlayer, typeof actions>({ actions });
    const player = createTestPlayer({ name: "Ada" });

    await expect(
      harness.invoke(player, "shop.buy", { item: "sword", quantity: 1 }),
    ).resolves.toEqual({ ok: true });

    harness.dispose();
  });

  it("rejects input the schema does not accept", async () => {
    const harness = createTestServerApp<TestPlayer, typeof actions>({ actions });
    const player = createTestPlayer();

    await expect(
      harness.invoke(player, "shop.buy", { item: "sword", quantity: "many" }),
    ).rejects.toThrow(/invalid action input|quantity/i);

    harness.dispose();
  });

  it("records every signal the action publishes, with its recipient", async () => {
    const harness = createTestServerApp<TestPlayer, typeof actions, typeof signals>({
      actions,
      signals,
    });
    const player = createTestPlayer({ name: "Grace" });

    await harness.invoke(player, "shop.buy", { item: "shield", quantity: 2 });

    expect(harness.published).toEqual([
      { signalId: "shop.purchased", payload: { item: "shield" }, player },
    ]);
    // takePublished drains, so the next assertion starts from empty.
    expect(harness.takePublished()).toHaveLength(1);
    expect(harness.published).toHaveLength(0);

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
    await expect(harness.invoke(createTestPlayer(), "shop.broken", undefined)).rejects.toThrow(
      /shop\.purchased.*item: expected string/,
    );

    harness.dispose();
  });

  it("drives the player lifecycle: sessions, hooks, and boot state", async () => {
    const joined: string[] = [];
    const left: string[] = [];
    const definer = createActionDefiner<typeof signals, TestPlayer, { visits: number }>();
    const whoami = definer({
      id: "session.whoami",
      run(ctx) {
        return { visits: ctx.session.visits, name: ctx.player.Name };
      },
    });

    const harness = createTestServerApp<
      TestPlayer,
      { "session.whoami": typeof whoami },
      typeof signals,
      { visits: number }
    >({
      actions: { "session.whoami": whoami },
      signals,
      createSession: () => ({ visits: 1 }),
      onPlayerAdded: (player) => joined.push(player.Name),
      onPlayerRemoving: (player) => left.push(player.Name),
    });

    const player = createTestPlayer({ name: "Linus" });
    harness.join(player);
    expect(joined).toEqual(["Linus"]);
    expect(harness.players).toEqual([player]);

    await expect(harness.invoke(player, "session.whoami", undefined)).resolves.toEqual({
      visits: 1,
      name: "Linus",
    });

    harness.leave(player);
    expect(left).toEqual(["Linus"]);
    expect(harness.players).toEqual([]);

    harness.dispose();
  });

  it("enforces the app's rate limit", async () => {
    const ping = defineAction({
      id: "ping",
      rateLimit: { key: "player", windowMs: 60_000, max: 1 },
      run: () => "pong",
    });
    const harness = createTestServerApp({ actions: { ping } });
    const player = createTestPlayer();

    await expect(harness.invoke(player, "ping", undefined)).resolves.toBe("pong");
    await expect(harness.invoke(player, "ping", undefined)).rejects.toThrow(/rate limited/i);

    harness.dispose();
  });

  it("crosses a rate-limit window when the spec advances the clock", async () => {
    const ping = defineAction({
      id: "ping",
      rateLimit: { key: "player", windowMs: 60_000, max: 1 },
      run: () => "pong",
    });
    const harness = createTestServerApp({ actions: { ping } });
    const player = createTestPlayer();

    await expect(harness.invoke(player, "ping", undefined)).resolves.toBe("pong");
    await expect(harness.invoke(player, "ping", undefined)).rejects.toThrow(/rate limited/i);

    // The clock is frozen, so the window elapses only here — no real waiting.
    harness.advance(60_000);
    await expect(harness.invoke(player, "ping", undefined)).resolves.toBe("pong");

    harness.dispose();
  });

  it("refuses to advance a clock the caller owns", () => {
    const harness = createTestServerApp({
      actions: { ping: defineAction({ id: "ping", run: () => "pong" }) },
      nowMs: () => 1_000,
    });

    expect(() => harness.advance(1_000)).toThrow(/given its own nowMs/);

    harness.dispose();
  });

  it("runs middleware around the action", async () => {
    const seen: string[] = [];
    const ping = defineAction({ id: "ping", run: () => "pong" });
    const harness = createTestServerApp({
      actions: { ping },
      middleware: [
        async (info, next) => {
          seen.push(`before:${info.actionId}`);
          const output = await next();
          seen.push("after");
          return output;
        },
      ],
    });

    await harness.invoke(createTestPlayer(), "ping", undefined);
    expect(seen).toEqual(["before:ping", "after"]);

    harness.dispose();
  });
});

describe("TestServerApp.client", () => {
  it("invokes actions through a client app bound to the server", async () => {
    const harness = createTestServerApp<TestPlayer, typeof actions>({ actions });
    const player = createTestPlayer();
    const client = harness.client(player);

    await expect(client.invoke("shop.buy", { item: "potion", quantity: 3 })).resolves.toEqual({
      ok: true,
    });

    harness.dispose();
  });

  it("delivers signals published to that player to the client subscriber", async () => {
    const harness = createTestServerApp<TestPlayer, typeof actions, typeof signals>({
      actions,
      signals,
    });
    const player = createTestPlayer();
    const other = createTestPlayer();
    const client = harness.client(player);

    const received: unknown[] = [];
    client.subscriber?.on("shop.purchased", (payload) => {
      received.push(payload);
    });

    await harness.invoke(player, "shop.buy", { item: "rope", quantity: 1 });
    expect(received).toEqual([{ item: "rope" }]);

    // A signal aimed at someone else must not reach this client.
    await harness.invoke(other, "shop.buy", { item: "lamp", quantity: 1 });
    expect(received).toEqual([{ item: "rope" }]);

    harness.dispose();
  });
});
