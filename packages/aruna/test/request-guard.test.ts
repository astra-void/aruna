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
import type { RequestAbuseReason } from "../src/runtime/request-guard.js";

type Player = { readonly UserId: number };

function createFakePlayers() {
  const removing = new Set<(player: Player) => void>();
  return {
    source: {
      PlayerRemoving: {
        Connect(callback: (player: Player) => void) {
          removing.add(callback);
          return { Disconnect: () => removing.delete(callback) };
        },
      },
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
    send(player: Player, input: unknown = undefined) {
      sent += 1;
      return listener?.(player, { requestId: `r${sent}`, actionId: "shop.buy", input });
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
    void harness.send(ada);
    await Promise.resolve();
    expect(harness.runs()).toBe(2);
    harness.app.dispose();
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
