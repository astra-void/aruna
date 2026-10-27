// The per-player limits in front of dispatch: an envelope budget charged
// before the payload is read, a cap on dispatches in flight, and the node
// budget on the wire-safety walk. The native runtime has the same behavior,
// covered by apps/roblox-runtime-test/lune/specs/transport.luau.
import { describe, expect, it } from "vitest";
import { createServerApp, defineAction } from "../src/server.js";
import {
  bindRemoteEventActions,
  type RemoteEventActionRequest,
  type RemoteEventActionResponse,
} from "../src/runtime/remote-event.js";
import { validateSerializableActionValue } from "../src/runtime/serialization.js";
import { createIdempotencyCache } from "../src/runtime/idempotency.js";
import {
  DEPARTED_PLAYER_TTL_MS,
  createDepartedPlayers,
  createRequestGuard,
  type RequestAbuseReason,
} from "../src/runtime/request-guard.js";

type Player = { readonly UserId: number };

function createFakePlayers() {
  const added = new Set<(player: Player) => void>();
  const removing = new Set<(player: Player) => void>();
  return {
    source: {
      PlayerAdded: {
        Connect(callback: (player: Player) => void) {
          added.add(callback);
          return { Disconnect: () => added.delete(callback) };
        },
      },
      PlayerRemoving: {
        Connect(callback: (player: Player) => void) {
          removing.add(callback);
          return { Disconnect: () => removing.delete(callback) };
        },
      },
    },
    join(player: Player) {
      for (const callback of added) {
        callback(player);
      }
    },
    leave(player: Player) {
      for (const callback of removing) {
        callback(player);
      }
    },
  };
}

function setup(options: {
  readonly run?: () => unknown;
  readonly requestBudget?: { burst?: number; perSecond?: number; maxInFlight?: number };
}) {
  let listener: ((player: Player, request: RemoteEventActionRequest) => unknown) | undefined;
  const responses: RemoteEventActionResponse[] = [];
  const abuse: RequestAbuseReason[] = [];
  const players = createFakePlayers();
  let clockMs = 0;
  let runs = 0;
  const app = createServerApp<Player>({
    actions: {
      "shop.buy": defineAction({
        id: "shop.buy",
        run() {
          runs += 1;
          return options.run?.() ?? "ok";
        },
      }),
    },
    players: players.source,
    nowMs: () => clockMs,
    ...(options.requestBudget !== undefined ? { requestBudget: options.requestBudget } : {}),
    onAbuse: (_player, info) => abuse.push(info.reason),
    transport: ({ registry, dispatch }) =>
      bindRemoteEventActions(
        {
          FireClient(_player: Player, response: RemoteEventActionResponse) {
            responses.push(response);
          },
          OnServerEvent: {
            Connect(callback: (player: Player, request: RemoteEventActionRequest) => unknown) {
              listener = callback;
              return { Disconnect() {} };
            },
          },
        },
        registry,
        dispatch,
      ),
  });
  let sent = 0;
  return {
    app,
    responses,
    abuse,
    players,
    runs: () => runs,
    advance(ms: number) {
      clockMs += ms;
    },
    send(player: Player, input: unknown = undefined, idempotencyKey?: string) {
      sent += 1;
      return listener?.(player, {
        requestId: `r${sent}`,
        actionId: "shop.buy",
        input,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      });
    },
  };
}

describe("request budget", () => {
  it("drops envelopes past the burst, silently, and refills over time", async () => {
    const harness = setup({ requestBudget: { burst: 3, perSecond: 1 } });
    const ada = { UserId: 1 };

    await Promise.all([1, 2, 3, 4, 5].map(() => harness.send(ada)));
    expect(harness.runs()).toBe(3);
    expect(harness.responses).toHaveLength(3);
    expect(harness.abuse).toEqual(["budget-exhausted", "budget-exhausted"]);

    harness.advance(1000);
    await harness.send(ada);
    expect(harness.runs()).toBe(4);
    harness.app.dispose();
  });

  it("charges invalid payloads too, before validation runs", async () => {
    const harness = setup({ requestBudget: { burst: 2, perSecond: 1 } });
    const ada = { UserId: 1 };

    // Not wire-safe: rejected, but each one still spent a token.
    await harness.send(ada, { callback: () => undefined });
    await harness.send(ada, { callback: () => undefined });
    await harness.send(ada);
    expect(harness.responses.map((response) => response.ok)).toEqual([false, false]);
    expect(harness.runs()).toBe(0);
    harness.app.dispose();
  });

  it("keeps each player's budget separate and drops it on leave", async () => {
    const harness = setup({ requestBudget: { burst: 1, perSecond: 1 } });
    const ada = { UserId: 1 };
    const bo = { UserId: 2 };

    await harness.send(ada);
    await harness.send(ada);
    await harness.send(bo);
    expect(harness.runs()).toBe(2);

    // A fresh budget after leaving and coming back.
    harness.players.leave(ada);
    harness.players.join(ada);
    await harness.send(ada);
    expect(harness.runs()).toBe(3);
    harness.app.dispose();
  });

  it("refuses calls past the in-flight cap with ActionRateLimitError", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = setup({ run: () => gate.then(() => "late"), requestBudget: { maxInFlight: 2 } });
    const ada = { UserId: 1 };

    const pending = [harness.send(ada), harness.send(ada)];
    await harness.send(ada);
    expect(harness.responses).toEqual([
      expect.objectContaining({
        requestId: "r3",
        ok: false,
        error: expect.objectContaining({ name: "ActionRateLimitError", retryAfterMs: 100 }),
      }),
    ]);
    expect(harness.abuse).toEqual(["too-many-in-flight"]);

    release?.();
    await Promise.all(pending);
    // The slots are free again.
    await harness.send(ada);
    expect(harness.runs()).toBe(3);
    harness.app.dispose();
  });

  it("frees a player's in-flight slots on leave", async () => {
    const harness = setup({ run: () => new Promise(() => undefined), requestBudget: { maxInFlight: 1 } });
    const ada = { UserId: 1 };

    void harness.send(ada);
    await Promise.resolve();
    harness.players.leave(ada);
    harness.players.join(ada);
    void harness.send(ada);
    await Promise.resolve();
    expect(harness.runs()).toBe(2);
    harness.app.dispose();
  });
});

describe("in-process dispatch", () => {
  it("is not held to the in-flight cap, while the transport still is", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = setup({ run: () => gate.then(() => "late") });
    const ada = { UserId: 1 };

    // 100 at once from trusted server code: none refused.
    const local = Array.from({ length: 100 }, () =>
      harness.app.dispatch("shop.buy", { player: ada }, undefined),
    );
    // The wire's 33rd concurrent call is refused (default maxInFlight 32). The
    // in-process calls above took no slots from it.
    const wire = Array.from({ length: 33 }, () => harness.send(ada));
    await Promise.resolve();
    expect(harness.responses).toEqual([
      expect.objectContaining({
        requestId: "r33",
        ok: false,
        error: expect.objectContaining({ name: "ActionRateLimitError" }),
      }),
    ]);
    expect(harness.abuse).toEqual(["too-many-in-flight"]);

    release?.();
    await expect(Promise.all(local)).resolves.toEqual(Array.from({ length: 100 }, () => "late"));
    await Promise.all(wire);
    expect(harness.runs()).toBe(132);
    harness.app.dispose();
  });

  it("still de-duplicates by idempotency key", async () => {
    const harness = setup({});
    const ada = { UserId: 1 };

    await harness.app.dispatch("shop.buy", { player: ada }, undefined, { idempotencyKey: "k" });
    await harness.app.dispatch("shop.buy", { player: ada }, undefined, { idempotencyKey: "k" });
    expect(harness.runs()).toBe(1);
    harness.app.dispose();
  });
});

describe("after leave", () => {
  it("drops an envelope that arrives after the player left, and creates no state for it", async () => {
    const harness = setup({ requestBudget: { burst: 1, perSecond: 1 } });
    const ada = { UserId: 1 };

    harness.players.leave(ada);
    await harness.send(ada);
    expect(harness.runs()).toBe(0);
    expect(harness.responses).toEqual([]);
    // Late, not abusive: nothing is reported.
    expect(harness.abuse).toEqual([]);

    // Had the late envelope created a budget, it would have spent the only
    // token, and this one would be dropped.
    harness.players.join(ada);
    await harness.send(ada);
    expect(harness.runs()).toBe(1);
    harness.app.dispose();
  });

  it("does not remember a late call's idempotency key", async () => {
    const harness = setup({});
    const ada = { UserId: 1 };

    await harness.send(ada, undefined, "key-1");
    expect(harness.runs()).toBe(1);
    harness.players.leave(ada);
    await harness.send(ada, undefined, "key-1");
    expect(harness.runs()).toBe(1);

    // Leave dropped the key, and the late envelope did not put it back: the
    // same key runs again for the returning player.
    harness.players.join(ada);
    await harness.send(ada, undefined, "key-1");
    expect(harness.runs()).toBe(2);
    harness.app.dispose();
  });

  it("forgets the departed mark after DEPARTED_PLAYER_TTL_MS, so it does not pin the player", async () => {
    const harness = setup({});
    const ada = { UserId: 1 };

    harness.players.leave(ada);
    harness.advance(DEPARTED_PLAYER_TTL_MS);
    await harness.send(ada);
    expect(harness.runs()).toBe(0);
    harness.advance(1);
    await harness.send(ada);
    expect(harness.runs()).toBe(1);
    harness.app.dispose();
  });

  it("sweeps expired departures when another player leaves", () => {
    let clockMs = 0;
    const departed = createDepartedPlayers<string>(() => clockMs);
    const remembered: string[] = [];
    const guard = createRequestGuard<string>({ departed, nowMs: () => clockMs });
    const cache = createIdempotencyCache<string, string>({ departed, nowMs: () => clockMs });

    departed.add("ada");
    expect(guard.admit("ada")).toBe(false);
    expect(guard.begin("ada")).toBe(true);
    void cache.run("ada", "shop.buy", "k", () => {
      remembered.push("ran");
      return Promise.resolve("ok");
    });
    void cache.run("ada", "shop.buy", "k", () => {
      remembered.push("ran");
      return Promise.resolve("ok");
    });
    // Not de-duplicated: nothing was remembered for a departed player.
    expect(remembered).toEqual(["ran", "ran"]);

    clockMs = DEPARTED_PLAYER_TTL_MS + 1;
    departed.add("bo");
    expect(departed.has("ada")).toBe(false);
    expect(departed.has("bo")).toBe(true);
    departed.remove("bo");
    expect(departed.has("bo")).toBe(false);
  });
});

describe("wire node budget", () => {
  it("rejects a value with more than 2048 values in it, however shallow", () => {
    const result = validateSerializableActionValue(new Array(2048).fill(0));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.violations).toEqual([
      expect.objectContaining({ reason: "more than 2048 values cannot cross action boundaries" }),
    ]);
    expect(validateSerializableActionValue(new Array(2047).fill(0)).ok).toBe(true);
  });

  it("does not hold an action's own output to it", async () => {
    const app = createServerApp({
      actions: {
        "board.top": defineAction({ id: "board.top", run: () => new Array(5000).fill(1) }),
      },
    });
    await expect(app.dispatch("board.top", { player: { UserId: 1 } }, undefined)).resolves.toHaveLength(
      5000,
    );
    app.dispose();
  });
});
