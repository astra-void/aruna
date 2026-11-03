// Per-action fixed-window rate limits: the limiter itself, how dispatch picks
// the limit (per-action wins over `defaultRateLimit`), how calls are bucketed
// (per player, per action, per custom key), what a refusal carries, and that a
// call refused before it ran does not spend quota. Port of
// packages/aruna/test/rate-limit.test.ts.
//
// Time: the Node suite froze `Date.now()` at 1000 ms. Here the harness clock
// (frozen at 0) is stepped to 1000 ms with `advance`, or an app is given its own
// `nowMs`, so every window boundary lands where the Node suite expects it.
import { defineAction, robloxRemoteEvent } from "aruna/roblox";
import { createServerApp, type ActionMap } from "aruna/server";
import { schema } from "aruna/schema";
import {
  createTestPlayer,
  createTestServerApp,
  describe,
  expect,
  it,
} from "aruna/testing";
import { deepEquals } from "aruna/internal/testing-framework";
import { createActionRateLimiter } from "aruna/internal/rate-limit";
import { rejectionOf, waitUntil, wireRemote } from "./support";

type Fields = { [key: string]: unknown };

// The native `toMatchObject`: every expected field must be present and deeply
// equal on `actual`. All mismatches are listed at once, so a failure names every
// field that is missing or wrong rather than just the first.
function expectMatch(actual: unknown, expected: Fields): void {
  const record = (typeIs(actual, "table") ? actual : {}) as Fields;
  const mismatches = new Array<string>();
  for (const [key, value] of pairs(expected)) {
    if (!deepEquals(record[key as string], value)) {
      mismatches.push(
        `${key}: expected ${tostring(value)}, got ${tostring(record[key as string])}`,
      );
    }
  }
  mismatches.sort();
  expect(mismatches.join("; ")).toBe("");
}

// Asserts each named field is absent (nil) on `actual`.
function expectAbsent(actual: unknown, keys: ReadonlyArray<string>): void {
  const record = (typeIs(actual, "table") ? actual : {}) as Fields;
  for (const key of keys) {
    expect(`${key} = ${tostring(record[key])}`).toBe(`${key} = nil`);
  }
}

const RATE_LIMITED_MESSAGE = "Aruna action shop.purchaseItem is rate limited. Retry after 1000ms.";

// The native rate-limit rejection at the harness clock (1000 ms, 1 s window):
// exactly name, message, and the backoff metadata.
function expectNativeRateLimitRejection(refused: unknown): void {
  expect(refused).toEqual({
    name: "ActionRateLimitError",
    message: RATE_LIMITED_MESSAGE,
    retryAfterMs: 1000,
    resetAtMs: 2000,
  });
  expectAbsent(refused, ["actionId", "max", "windowMs"]);
}

// A `run` that counts its calls, standing in for `vi.fn(() => ({ ok: true }))`.
function counter() {
  const calls = { count: 0 };
  return {
    calls,
    action(
      id: string,
      rateLimit?: {
        key: "player" | "global";
        windowMs: number;
        max: number;
        strategy?: "fixedWindow" | "tokenBucket";
      },
    ) {
      return defineAction({
        id,
        ...(rateLimit !== undefined ? { rateLimit } : {}),
        run() {
          calls.count += 1;
          return { ok: true };
        },
      });
    },
  };
}

// A harness whose clock reads 1000 ms, where the Node suite pinned the system
// time.
function harnessAt1000(
  actions: ActionMap<Player>,
  defaultRateLimit?: { key: "player"; windowMs: number; max: number },
) {
  const harness = createTestServerApp({
    actions,
    ...(defaultRateLimit !== undefined ? { defaultRateLimit } : {}),
  });
  harness.advance(1000);
  return harness;
}

describe("action rate limits", () => {
  it("allows unlimited calls when no rate limit is declared", async () => {
    const fixture = counter();
    const harness = harnessAt1000({ "shop.purchaseItem": fixture.action("shop.purchaseItem") });
    const player = createTestPlayer();

    expect(await harness.invoke(player, "shop.purchaseItem", {})).toEqual({ ok: true });
    expect(await harness.invoke(player, "shop.purchaseItem", {})).toEqual({ ok: true });
    expect(await harness.invoke(player, "shop.purchaseItem", {})).toEqual({ ok: true });

    expect(fixture.calls.count).toBe(3);
    harness.dispose();
  });

  it("applies defaultRateLimit to actions that do not declare their own", async () => {
    const fixture = counter();
    const harness = harnessAt1000(
      { "shop.purchaseItem": fixture.action("shop.purchaseItem") },
      { key: "player", windowMs: 1000, max: 2 },
    );
    const player = createTestPlayer();

    expect(await harness.invoke(player, "shop.purchaseItem", {})).toEqual({ ok: true });
    expect(await harness.invoke(player, "shop.purchaseItem", {})).toEqual({ ok: true });
    const refused = await rejectionOf(harness.invoke(player, "shop.purchaseItem", {}));

    expect(fixture.calls.count).toBe(2);
    // The retired Node runtime's ActionRateLimitError also carried actionId, max: 2, windowMs: 1000.
    expectNativeRateLimitRejection(refused);
    harness.dispose();
  });

  it("lets a per-action rateLimit override the defaultRateLimit", async () => {
    const fixture = counter();
    const harness = harnessAt1000(
      {
        "shop.purchaseItem": fixture.action("shop.purchaseItem", {
          key: "player",
          windowMs: 1000,
          max: 3,
        }),
      },
      // A stricter default must NOT clamp an action that declares a looser limit.
      { key: "player", windowMs: 1000, max: 1 },
    );
    const player = createTestPlayer();

    for (let call = 0; call < 3; call += 1) {
      expect(await harness.invoke(player, "shop.purchaseItem", {})).toEqual({ ok: true });
    }
    const refused = await rejectionOf(harness.invoke(player, "shop.purchaseItem", {}));

    expect(fixture.calls.count).toBe(3);
    // The retired Node runtime's ActionRateLimitError also carried max: 3.
    expectNativeRateLimitRejection(refused);
    harness.dispose();
  });

  it("createServerApp forwards defaultRateLimit to dispatch", async () => {
    const fixture = counter();
    const app = createServerApp({
      actions: { "shop.purchaseItem": fixture.action("shop.purchaseItem") },
      defaultRateLimit: { key: "player", windowMs: 1000, max: 1 },
    });
    const player = createTestPlayer();

    expect(await app.dispatch("shop.purchaseItem", { player }, {})).toEqual({ ok: true });
    const refused = await rejectionOf(app.dispatch("shop.purchaseItem", { player }, {}));

    expect(fixture.calls.count).toBe(1);
    // The retired Node runtime's ActionRateLimitError also carried max: 1.
    // No `nowMs` here, so the backoff metadata reads os.clock(): numbers, not fixed values.
    const retryAfterMs = (refused as unknown as Fields)["retryAfterMs"];
    expect(typeIs(retryAfterMs, "number")).toBe(true);
    expect(typeIs((refused as unknown as Fields)["resetAtMs"], "number")).toBe(true);
    expectMatch(refused, {
      name: "ActionRateLimitError",
      message: `Aruna action shop.purchaseItem is rate limited. Retry after ${retryAfterMs}ms.`,
    });
    expectAbsent(refused, ["actionId", "max", "windowMs", "errorId"]);
    app.dispose();
  });

  it("buckets by a per-action custom key function", async () => {
    const seen = new Array<{ readonly actionId: string; readonly targetId: string }>();
    const harness = harnessAt1000({
      "trade.offer": defineAction({
        id: "trade.offer",
        rateLimit: {
          key: (info) => {
            const targetId = (info.input as { readonly targetId: string }).targetId;
            seen.push({ actionId: info.actionId, targetId });
            return `target:${targetId}`;
          },
          windowMs: 1000,
          max: 1,
        },
        run() {
          return { ok: true };
        },
      }),
    });
    const player = createTestPlayer();

    // Different targets fall in different buckets, so both are allowed even at
    // max 1.
    expect(await harness.invoke(player, "trade.offer", { targetId: "a" })).toEqual({ ok: true });
    expect(await harness.invoke(player, "trade.offer", { targetId: "b" })).toEqual({ ok: true });
    // A second call to target "a" shares its bucket and is throttled.
    const refused = await rejectionOf(harness.invoke(player, "trade.offer", { targetId: "a" }));
    expect(refused.name).toBe("ActionRateLimitError");

    // The key function saw the action id and each input.
    expect(seen).toEqual([
      { actionId: "trade.offer", targetId: "a" },
      { actionId: "trade.offer", targetId: "b" },
      { actionId: "trade.offer", targetId: "a" },
    ]);
    harness.dispose();
  });

  it("enforces a fixed window and resets after the window expires", async () => {
    const calls = { count: 0 };
    const limit = { key: "player" as const, windowMs: 1000, max: 2 };
    const harness = harnessAt1000({
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        rateLimit: limit,
        input: schema.object({ itemId: schema.string() }),
        run() {
          calls.count += 1;
          return { ok: true };
        },
      }),
    });
    const player = createTestPlayer();

    expect(await harness.invoke(player, "shop.purchaseItem", { itemId: "sword" })).toEqual({
      ok: true,
    });
    expect(await harness.invoke(player, "shop.purchaseItem", { itemId: "sword" })).toEqual({
      ok: true,
    });
    const refused = await rejectionOf(
      harness.invoke(player, "shop.purchaseItem", { itemId: "sword" }),
    );

    // Now at 2000 ms: the next window.
    harness.advance(1000);

    expect(await harness.invoke(player, "shop.purchaseItem", { itemId: "shield" })).toEqual({
      ok: true,
    });
    expect(calls.count).toBe(3);
    // The retired Node runtime's ActionRateLimitError also carried actionId, max: 2, windowMs: 1000.
    expectNativeRateLimitRejection(refused);
    harness.dispose();
  });

  it("does not consume quota for invalid input", async () => {
    const calls = { count: 0 };
    const harness = harnessAt1000({
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        rateLimit: { key: "player", windowMs: 1000, max: 1 },
        input: schema.object({ itemId: schema.string() }),
        run() {
          calls.count += 1;
          return { ok: true };
        },
      }),
    });
    const player = createTestPlayer();

    await expect(harness.invoke(player, "shop.purchaseItem", { itemId: 123 })).rejects.toThrow(
      "Aruna action shop.purchaseItem input validation failed: itemId: expected string",
    );

    expect(await harness.invoke(player, "shop.purchaseItem", { itemId: "sword" })).toEqual({
      ok: true,
    });
    expect(calls.count).toBe(1);
    harness.dispose();
  });

  it("does not consume quota for unsafe serialization input", async () => {
    const fixture = counter();
    const harness = harnessAt1000({
      "shop.purchaseItem": fixture.action("shop.purchaseItem", {
        key: "player",
        windowMs: 1000,
        max: 1,
      }),
    });
    const player = createTestPlayer();

    // The same Player look-alike the Node suite sends. Natively it is refused
    // because it carries a function (`IsA`), which no RemoteEvent can carry.
    const refused = await rejectionOf(
      harness.invoke(player, "shop.purchaseItem", {
        itemId: {
          ClassName: "Player",
          IsA(className: string) {
            return className === "Instance" || className === "Player";
          },
        },
      }),
    );

    expect(await harness.invoke(player, "shop.purchaseItem", { itemId: "sword" })).toEqual({
      ok: true,
    });
    expect(fixture.calls.count).toBe(1);
    // The retired Node runtime's ActionSerializationError also carried actionId and role: "input".
    expect(refused).toEqual({
      name: "ActionSerializationError",
      message: "non-serializable action input",
    });
    expectAbsent(refused, ["actionId", "role"]);
    harness.dispose();
  });

  it("does not call run when the action is rate limited", async () => {
    const fixture = counter();
    const harness = harnessAt1000({
      "shop.purchaseItem": fixture.action("shop.purchaseItem", {
        key: "player",
        windowMs: 1000,
        max: 1,
      }),
    });
    const player = createTestPlayer();

    expect(await harness.invoke(player, "shop.purchaseItem", { itemId: "sword" })).toEqual({
      ok: true,
    });
    const refused = await rejectionOf(
      harness.invoke(player, "shop.purchaseItem", { itemId: "shield" }),
    );
    expect(refused.name).toBe("ActionRateLimitError");

    expect(fixture.calls.count).toBe(1);
    harness.dispose();
  });

  it("keeps separate action buckets isolated", async () => {
    const fixture = counter();
    const limit = { key: "player" as const, windowMs: 1000, max: 1 };
    const harness = harnessAt1000({
      "shop.purchaseItem": fixture.action("shop.purchaseItem", limit),
      "inventory.restockItem": fixture.action("inventory.restockItem", limit),
    });
    const player = createTestPlayer();

    expect(await harness.invoke(player, "shop.purchaseItem", { itemId: "sword" })).toEqual({
      ok: true,
    });
    const refused = await rejectionOf(
      harness.invoke(player, "shop.purchaseItem", { itemId: "shield" }),
    );
    expect(refused.name).toBe("ActionRateLimitError");

    expect(await harness.invoke(player, "inventory.restockItem", {})).toEqual({ ok: true });
    expect(fixture.calls.count).toBe(2);
    harness.dispose();
  });

  it("keeps separate player keys isolated", async () => {
    const fixture = counter();
    const harness = harnessAt1000({
      "shop.purchaseItem": fixture.action("shop.purchaseItem", {
        key: "player",
        windowMs: 1000,
        max: 1,
      }),
    });
    // The Node suite bucketed through a dispatch-level `rateLimitKey` override;
    // natively the "player" key buckets on the player's UserId.
    const alpha = createTestPlayer({ name: "alpha" });
    const beta = createTestPlayer({ name: "beta" });

    expect(await harness.invoke(alpha, "shop.purchaseItem", {})).toEqual({ ok: true });
    expect(await harness.invoke(beta, "shop.purchaseItem", {})).toEqual({ ok: true });
    const refused = await rejectionOf(harness.invoke(alpha, "shop.purchaseItem", {}));
    expect(refused.name).toBe("ActionRateLimitError");

    expect(fixture.calls.count).toBe(2);
    harness.dispose();
  });

  it("includes the expected fields on ActionRateLimitError", async () => {
    const fixture = counter();
    const harness = harnessAt1000({
      "shop.purchaseItem": fixture.action("shop.purchaseItem", {
        key: "player",
        windowMs: 1000,
        max: 1,
      }),
    });
    const player = createTestPlayer();

    expect(await harness.invoke(player, "shop.purchaseItem", { itemId: "sword" })).toEqual({
      ok: true,
    });
    const refused = await rejectionOf(
      harness.invoke(player, "shop.purchaseItem", { itemId: "shield" }),
    );

    // The retired Node runtime's ActionRateLimitError also carried actionId, max: 1, windowMs: 1000.
    expectNativeRateLimitRejection(refused);
    harness.dispose();
  });

  it("surfaces a readable error response through RemoteEvent binding", async () => {
    const app = createServerApp({
      actions: {
        "shop.purchaseItem": defineAction({
          id: "shop.purchaseItem",
          rateLimit: { key: "player", windowMs: 1000, max: 1 },
          run() {
            return { ok: true };
          },
        }),
      },
      transport: robloxRemoteEvent(),
      nowMs: () => 1000,
    });
    const wire = wireRemote();

    await wire.send("request-1", "shop.purchaseItem", { itemId: "sword" });
    await wire.send("request-2", "shop.purchaseItem", { itemId: "shield" });
    await waitUntil(() => wire.responses().size() >= 2);

    const errorEntry = wire
      .responses()
      .find((entry) => (entry.result as { readonly ok?: unknown }).ok === false);
    const errorResponse = errorEntry !== undefined ? (errorEntry.result as Fields) : undefined;

    // The native wire result carries the error as flat fields: `error` is the
    // message and `errorName` the name, beside the backoff metadata.
    expectMatch(errorResponse, {
      ok: false,
      errorName: "ActionRateLimitError",
      error: "Aruna action shop.purchaseItem is rate limited. Retry after 1000ms.",
      // Structured backoff metadata crosses the wire.
      retryAfterMs: 1000,
    });
    expect(
      typeIs(errorResponse !== undefined ? errorResponse["resetAtMs"] : undefined, "number"),
    ).toBe(true);
    wire.dispose();
    app.dispose();
  });

  it("purges only fully-elapsed buckets and reports the count", () => {
    // The native limiter's clock is in seconds: 1000 ms is 1, and so on.
    const config = { key: "player" as const, windowMs: 1000, max: 2 };
    const limiter = createActionRateLimiter();

    // Two keys in the same window [1, 2); the second check is within the
    // window so it does not trigger the lazy sweep.
    limiter.check("shop.purchaseItem", "alpha", config, 1);
    limiter.check("shop.purchaseItem", "beta", config, 1.5);

    expect(limiter.purge(1.999)).toBe(0);
    expect(limiter.purge(2)).toBe(2);
    expect(limiter.purge(2)).toBe(0);
  });

  it("lazily purges abandoned keys on check while keeping the active window", () => {
    const config = { key: "player" as const, windowMs: 1000, max: 2 };
    const limiter = createActionRateLimiter();

    limiter.check("shop.purchaseItem", "abandoned", config, 1);
    // A later check (new window) triggers the lazy sweep of "abandoned"; without
    // it this purge would report 1.
    limiter.check("shop.purchaseItem", "active", config, 2.5);
    expect(limiter.purge(2.999)).toBe(0);

    // The active bucket survived: its earlier count still applies.
    const second = limiter.check("shop.purchaseItem", "active", config, 2.6);
    const third = limiter.check("shop.purchaseItem", "active", config, 2.7);
    expect(third.ok).toBe(false);
    // The retired Node runtime's check result also carried remaining: 0.
    expect(second).toEqual({ ok: true });
    expectAbsent(second, ["remaining"]);
  });

  it("lets a token bucket burst to max, then refill continuously", async () => {
    const fixture = counter();
    const harness = harnessAt1000({
      "shop.purchaseItem": fixture.action("shop.purchaseItem", {
        key: "player",
        windowMs: 1000,
        max: 2,
        strategy: "tokenBucket",
      }),
    });
    const player = createTestPlayer();

    expect(await harness.invoke(player, "shop.purchaseItem", {})).toEqual({ ok: true });
    expect(await harness.invoke(player, "shop.purchaseItem", {})).toEqual({ ok: true });
    // Empty: the next token is half a window away (2 per 1000 ms).
    expect(await rejectionOf(harness.invoke(player, "shop.purchaseItem", {}))).toEqual({
      name: "ActionRateLimitError",
      message: "Aruna action shop.purchaseItem is rate limited. Retry after 500ms.",
      retryAfterMs: 500,
      resetAtMs: 1500,
    });

    harness.advance(500);
    expect(await harness.invoke(player, "shop.purchaseItem", {})).toEqual({ ok: true });
    harness.advance(250);
    const early = await rejectionOf(harness.invoke(player, "shop.purchaseItem", {}));
    expect((early as unknown as Fields)["retryAfterMs"]).toBe(250);
    expect(fixture.calls.count).toBe(3);
    harness.dispose();
  });

  it("never lets a token bucket through twice max at a window boundary", async () => {
    const limit = { key: "player" as const, windowMs: 1000, max: 2 };
    const fixed = counter();
    const bucket = counter();
    const harness = createTestServerApp({
      actions: {
        "fixed.call": fixed.action("fixed.call", limit),
        "bucket.call": bucket.action("bucket.call", { ...limit, strategy: "tokenBucket" }),
      },
    });
    const player = createTestPlayer();

    // 1900 ms, the end of the window [1000, 2000): spend both calls of each.
    harness.advance(1900);
    for (const actionId of ["fixed.call", "bucket.call", "fixed.call", "bucket.call"]) {
      expect(await harness.invoke(player, actionId, {})).toEqual({ ok: true });
    }
    // 100 ms later a fixed window has reset; the bucket has 0.2 of a token.
    harness.advance(100);
    expect(await harness.invoke(player, "fixed.call", {})).toEqual({ ok: true });
    expect(await harness.invoke(player, "fixed.call", {})).toEqual({ ok: true });
    expect((await rejectionOf(harness.invoke(player, "bucket.call", {}))).name).toBe(
      "ActionRateLimitError",
    );
    expect([fixed.calls.count, bucket.calls.count]).toEqual([4, 2]);
    harness.dispose();
  });

  it("applies a token-bucket defaultRateLimit", async () => {
    const fixture = counter();
    const harness = createTestServerApp({
      actions: { "shop.purchaseItem": fixture.action("shop.purchaseItem") },
      defaultRateLimit: { key: "player", windowMs: 1000, max: 1, strategy: "tokenBucket" },
    });
    harness.advance(1000);
    const player = createTestPlayer();

    expect(await harness.invoke(player, "shop.purchaseItem", {})).toEqual({ ok: true });
    const refused = await rejectionOf(harness.invoke(player, "shop.purchaseItem", {}));
    expect((refused as unknown as Fields)["retryAfterMs"]).toBe(1000);
    harness.advance(1000);
    expect(await harness.invoke(player, "shop.purchaseItem", {})).toEqual({ ok: true });
    harness.dispose();
  });

  it("purges a token bucket once it has refilled", () => {
    const config = { key: "player" as const, windowMs: 1000, max: 2, strategy: "tokenBucket" as const };
    const limiter = createActionRateLimiter();

    // One token spent at 1 s comes back half a second later.
    limiter.check("shop.purchaseItem", "alpha", config, 1);
    expect(limiter.purge(1.49)).toBe(0);
    expect(limiter.purge(1.5)).toBe(1);
  });

  it("lets createServerApp share limiter state across dispatch calls", async () => {
    const fixture = counter();
    // The Node app took an injected `rateLimiter`; the native app owns one per
    // registry, shared by every dispatch through it.
    const app = createServerApp({
      actions: {
        "shop.purchaseItem": fixture.action("shop.purchaseItem", {
          key: "player",
          windowMs: 1000,
          max: 1,
        }),
      },
      nowMs: () => 1000,
    });
    const player = createTestPlayer();

    expect(await app.dispatch("shop.purchaseItem", { player }, { itemId: "sword" })).toEqual({
      ok: true,
    });
    const refused = await rejectionOf(
      app.dispatch("shop.purchaseItem", { player }, { itemId: "shield" }),
    );
    expect(refused.name).toBe("ActionRateLimitError");
    app.dispose();
  });
});
