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
  type TestServerApp,
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

// Batched, the harness runs the wire as a game does: a client's calls travel the
// action binding, and its responses come back through the one server channel
// that signals use, flushed by `step()`. These cases assert what a client
// actually reads, and in what order, across kinds.
const announce = defineAction({
  id: "shop.announce",
  input: schema.object({ item: schema.string() }),
  run(ctx, input) {
    ctx.publisher?.toAll("shop.purchased", { item: input.item });
    return { announced: input.item };
  },
});

describe("createTestServerApp batched", () => {
  afterEach(() => {
    clearActionInvoker();
  });

  // A client of `harness` that logs, in the order they happen, the signals its
  // subscriber gets and the responses its invokes settle with.
  function loggingClient(harness: TestServerApp<Player, typeof signals>, player: Player) {
    const log = new Array<string>();
    const client = harness.client(player);
    client.subscriber?.on("shop.purchased", (payload) => {
      log.push(`signal ${payload.item}`);
    });
    const invoke = (actionId: string, input: unknown, label: string) =>
      client.invoke(actionId, input).then(() => {
        log.push(`response ${label}`);
      });
    return { log, invoke };
  }

  it("sends nothing until a step, then answers a call in the step that sends it", () => {
    const harness = createTestServerApp({ actions, signals, batching: true });
    const player = createTestPlayer();
    const { log, invoke } = loggingClient(harness, player);

    void invoke("shop.buy", { item: "rope", quantity: 1 }, "rope");
    expect(log).toEqual([]);
    expect(harness.published()).toEqual([]);

    harness.step();
    expect(log).toEqual(["signal rope", "response rope"]);
    expect(harness.takePublished()).toEqual([{ signalId: "shop.purchased", payload: { item: "rope" }, player }]);
    harness.dispose();
  });

  it("delivers a signal published inside run() before that action's response", () => {
    const harness = createTestServerApp({ actions, signals, batching: true });
    const player = createTestPlayer();
    const { log, invoke } = loggingClient(harness, player);

    void invoke("shop.buy", { item: "lamp", quantity: 1 }, "lamp");
    harness.step();

    expect(log).toEqual(["signal lamp", "response lamp"]);
    harness.dispose();
  });

  it("delivers a toAll broadcast published inside run() before that action's response", () => {
    const harness = createTestServerApp({
      actions: { ...actions, "shop.announce": announce },
      signals,
      batching: true,
    });
    const player = createTestPlayer();
    const bystander = createTestPlayer();
    const { log, invoke } = loggingClient(harness, player);
    const watching = loggingClient(harness, bystander);

    void invoke("shop.announce", { item: "sale" }, "announce");
    harness.step();

    expect(log).toEqual(["signal sale", "response announce"]);
    // Everyone gets the broadcast; only the caller gets the response.
    expect(watching.log).toEqual(["signal sale"]);
    expect(harness.takePublished()).toEqual([{ signalId: "shop.purchased", payload: { item: "sale" } }]);
    harness.dispose();
  });

  it("keeps every action's signal ahead of its response across actions dispatched in one frame", () => {
    const harness = createTestServerApp({
      actions: { ...actions, "shop.announce": announce },
      signals,
      batching: true,
    });
    const player = createTestPlayer();
    const { log, invoke } = loggingClient(harness, player);

    void invoke("shop.buy", { item: "a", quantity: 1 }, "a");
    void invoke("shop.announce", { item: "b" }, "b");
    void invoke("shop.buy", { item: "c", quantity: 1 }, "c");
    harness.step();

    expect(log).toEqual(["signal a", "response a", "signal b", "response b", "signal c", "response c"]);
    harness.dispose();
  });

  it("answers an action that settles later in the step after it settles", async () => {
    let release: (() => void) | undefined;
    const slow = defineAction({
      id: "shop.slow",
      run(ctx) {
        return new Promise<string>((resolve) => {
          release = () => {
            ctx.publisher?.to(ctx.player, "shop.purchased", { item: "late" });
            resolve("done");
          };
        });
      },
    });
    const harness = createTestServerApp({ actions: { "shop.slow": slow }, signals, batching: true });
    const player = createTestPlayer();
    const { log, invoke } = loggingClient(harness, player);

    const settled = invoke("shop.slow", undefined, "slow");
    harness.step();
    expect(log).toEqual([]);
    release?.();
    expect(log).toEqual([]);
    harness.step();
    await settled;
    expect(log).toEqual(["signal late", "response slow"]);
    harness.dispose();
  });
});

describe("createTestServerApp unbatched (the default)", () => {
  afterEach(() => {
    clearActionInvoker();
  });

  it("delivers as things happen, with no step needed", async () => {
    const harness = createTestServerApp({ actions, signals });
    const player = createTestPlayer();
    const client = harness.client(player);
    const log = new Array<string>();
    client.subscriber?.on("shop.purchased", (payload) => log.push(`signal ${payload.item}`));

    const output = await client.invoke("shop.buy", { item: "rope", quantity: 1 });
    log.push("response rope");
    expect(output).toEqual({ ok: true });
    expect(log).toEqual(["signal rope", "response rope"]);
    expect(harness.takePublished()).toEqual([{ signalId: "shop.purchased", payload: { item: "rope" }, player }]);
    // Nothing is queued, so a step sends nothing.
    harness.step();
    expect(harness.published()).toEqual([]);
    harness.dispose();
  });
});
