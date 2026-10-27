// Port of packages/aruna/test/request-guard.test.ts: the per-player limits in
// front of dispatch — an envelope budget charged before the payload is read, a
// cap on dispatches in flight, and the node budget on the wire-safety walk.
//
// Envelopes travel the real action RemoteEvent the app's transport binds. The
// fake game's FireServer always arrives as its LocalPlayer, so a second player is
// driven through the same registry calls the transport makes (`admitEnvelope`,
// then `dispatch`).
import { defineAction, robloxRemoteEvent } from "aruna/roblox";
import {
  createServerApp,
  defineAction as defineServerAction,
  type ActionRegistry,
} from "aruna/server";
import { afterEach, createTestPlayer, describe, expect, it } from "aruna/testing";
import { createIdempotencyCache } from "aruna/internal/idempotency";
import {
  DEPARTED_PLAYER_TTL_MS,
  createDepartedPlayers,
  createRequestGuard,
  type RequestAbuseReason,
  type RequestBudgetOptions,
} from "aruna/internal/request-guard";
import { DEFAULT_MAX_WIRE_NODES, isWireSafe } from "aruna/internal/serialization";
import { waitUntil, wireRemote } from "./support";

const Players = game.GetService("Players");

function createFakePlayers() {
  const removing = new Set<(player: Player) => void>();
  const added = new Set<(player: Player) => void>();
  return {
    source: {
      PlayerAdded: {
        Connect: (callback: (player: Player) => void) => {
          added.add(callback);
          return {
            Disconnect: () => {
              added.delete(callback);
            },
          };
        },
      },
      PlayerRemoving: {
        Connect: (callback: (player: Player) => void) => {
          removing.add(callback);
          return {
            Disconnect: () => {
              removing.delete(callback);
            },
          };
        },
      },
    },
    leave(player: Player) {
      const snapshot = new Array<(player: Player) => void>();
      for (const callback of removing) {
        snapshot.push(callback);
      }
      for (const callback of snapshot) {
        callback(player);
      }
    },
    // Rejoining clears the departed mark leave set, which would otherwise drop
    // the player's envelopes.
    join(player: Player) {
      const snapshot = new Array<(player: Player) => void>();
      for (const callback of added) {
        snapshot.push(callback);
      }
      for (const callback of snapshot) {
        callback(player);
      }
    },
  };
}

interface WireResult {
  readonly ok: boolean;
  readonly errorName?: string;
  readonly retryAfterMs?: number;
}

const cleanups = new Array<() => void>();

// Hooks attach to a describe block; both blocks below call this first.
function disposeAfterEach(): void {
  afterEach(() => {
    for (const cleanup of cleanups) {
      cleanup();
    }
    cleanups.clear();
  });
}

function setup(options: {
  readonly run?: () => unknown;
  readonly requestBudget?: RequestBudgetOptions;
}) {
  const abuse = new Array<RequestAbuseReason>();
  const players = createFakePlayers();
  let clockMs = 0;
  let runs = 0;
  let registry: ActionRegistry<Player> | undefined;
  const app = createServerApp<Player>({
    actions: {
      "shop.buy": defineAction({
        id: "shop.buy",
        run() {
          runs += 1;
          const produced = options.run !== undefined ? options.run() : undefined;
          return produced !== undefined ? produced : "ok";
        },
      }),
    },
    players: players.source,
    nowMs: () => clockMs,
    ...(options.requestBudget !== undefined ? { requestBudget: options.requestBudget } : {}),
    onAbuse: (_player, info) => {
      abuse.push(info.reason);
    },
    transport: (bound) => {
      registry = bound;
      return robloxRemoteEvent()(bound);
    },
  });
  const wire = wireRemote();
  let sent = 0;
  const dispose = () => {
    wire.dispose();
    app.dispose();
  };
  cleanups.push(dispose);
  return {
    app,
    abuse,
    players,
    dispose,
    runs: () => runs,
    responses: () => wire.responses(),
    results: () => wire.responses().map((response) => response.result as WireResult),
    advance(ms: number) {
      clockMs += ms;
    },
    // One envelope from the LocalPlayer over the action RemoteEvent; resolves
    // on its response, or after a few frames for one the server drops.
    send(input: unknown = undefined): Promise<void> {
      sent += 1;
      return wire.send(`r${sent}`, "shop.buy", input);
    },
    // One envelope from another player, through the calls the transport makes.
    sendAs(player: Player, input: unknown = undefined): Promise<void> {
      sent += 1;
      const bound = registry;
      if (bound === undefined || !bound.admitEnvelope(player, `r${sent}`, "shop.buy")) {
        return Promise.resolve();
      }
      return bound.dispatch(player, "shop.buy", input).then(() => undefined);
    },
  };
}

describe("request budget", () => {
  disposeAfterEach();

  it("drops envelopes past the burst, silently, and refills over time", async () => {
    const harness = setup({ requestBudget: { burst: 3, perSecond: 1 } });

    await Promise.all([1, 2, 3, 4, 5].map(() => harness.send()));
    expect(harness.runs()).toBe(3);
    expect(harness.responses()).toHaveLength(3);
    expect(harness.abuse).toEqual(["budget-exhausted", "budget-exhausted"]);

    harness.advance(1000);
    await harness.send();
    expect(harness.runs()).toBe(4);
    harness.dispose();
  });

  it("charges invalid payloads too, before validation runs", async () => {
    const harness = setup({ requestBudget: { burst: 2, perSecond: 1 } });

    // Not wire-safe: rejected, but each one still spent a token.
    await harness.send({ callback: () => undefined });
    await harness.send({ callback: () => undefined });
    await harness.send();
    expect(harness.results().map((result) => result.ok)).toEqual([false, false]);
    expect(harness.runs()).toBe(0);
    harness.dispose();
  });

  it("keeps each player's budget separate and drops it on leave", async () => {
    const harness = setup({ requestBudget: { burst: 1, perSecond: 1 } });
    const ada = Players.LocalPlayer;
    const bo = createTestPlayer({ name: "Bo", userId: 2 });

    await harness.send();
    await harness.send();
    await harness.sendAs(bo);
    expect(harness.runs()).toBe(2);

    // A fresh budget after leaving and coming back.
    harness.players.leave(ada);
    harness.players.join(ada);
    await harness.send();
    expect(harness.runs()).toBe(3);
    harness.dispose();
  });

  it("refuses calls past the in-flight cap with ActionRateLimitError", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = setup({
      run: () => gate.then(() => "late"),
      requestBudget: { maxInFlight: 2 },
    });

    const pending = [harness.send(), harness.send()];
    await harness.send();
    expect(harness.responses()).toHaveLength(1);
    const refused = harness.responses()[0];
    expect(refused?.requestId).toBe("r3");
    const result = refused?.result as WireResult | undefined;
    expect(result?.ok).toBe(false);
    expect(result?.errorName).toBe("ActionRateLimitError");
    expect(result?.retryAfterMs).toBe(100);
    expect(harness.abuse).toEqual(["too-many-in-flight"]);

    release?.();
    await Promise.all(pending);
    // The slots are free again.
    await harness.send();
    expect(harness.runs()).toBe(3);
    harness.dispose();
  });

  it("frees a player's in-flight slots on leave", async () => {
    const harness = setup({
      run: () => new Promise(() => undefined),
      requestBudget: { maxInFlight: 1 },
    });

    void harness.send();
    await Promise.resolve();
    harness.players.leave(Players.LocalPlayer);
    harness.players.join(Players.LocalPlayer);
    void harness.send();
    await Promise.resolve();
    expect(harness.runs()).toBe(2);
    harness.dispose();
  });
});

function filledArray(size: number, value: number): Array<number> {
  const values = new Array<number>();
  for (let index = 0; index < size; index += 1) {
    values.push(value);
  }
  return values;
}

describe("wire node budget", () => {
  disposeAfterEach();

  it("rejects a value with more than 2048 values in it, however shallow", async () => {
    // The native walk answers a boolean, with no violation list: the reason is
    // pinned instead by the same value passing once the budget is raised.
    expect(DEFAULT_MAX_WIRE_NODES).toBe(2048);
    expect(isWireSafe(filledArray(2048, 0))).toBe(false);
    expect(isWireSafe(filledArray(2048, 0), 2049)).toBe(true);
    expect(isWireSafe(filledArray(2047, 0))).toBe(true);

    // And at the action boundary: such an input is refused as unserializable.
    let runs = 0;
    const app = createServerApp({
      actions: {
        "board.load": defineServerAction({
          id: "board.load",
          run() {
            runs += 1;
            return true;
          },
        }),
      },
      players: createFakePlayers().source,
    });
    cleanups.push(() => app.dispose());
    const player = createTestPlayer();
    const refused = await app.dispatch("board.load", { player }, filledArray(2048, 0)).then(
      () => undefined,
      (reason) => reason as { name?: string },
    );
    expect(refused?.name).toBe("ActionSerializationError");
    expect(await app.dispatch("board.load", { player }, filledArray(2047, 0))).toBe(true);
    expect(runs).toBe(1);
    app.dispose();
  });

  it("does not hold an action's own output to it", async () => {
    const app = createServerApp({
      actions: {
        "board.top": defineServerAction({
          id: "board.top",
          run() {
            return filledArray(5000, 1);
          },
        }),
      },
    });
    cleanups.push(() => app.dispose());
    const output = await app.dispatch("board.top", { player: { UserId: 1 } }, undefined);
    expect(output).toHaveLength(5000);
    app.dispose();
  });
});

describe("after leave", () => {
  // The rest of this block's cases (a late envelope creates no state, a late
  // key is not remembered, the mark's TTL, rejoin) run over the wire in
  // lune/specs/transport.luau and server-app.luau.
  it("sweeps expired departures when another player leaves", () => {
    let clockMs = 0;
    const departed = createDepartedPlayers<string>(() => clockMs);
    const guard = createRequestGuard<string>({ departed, nowMs: () => clockMs });
    const cache = createIdempotencyCache<string, string>(() => clockMs, departed);
    const remembered = new Array<string>();

    departed.add("ada");
    expect(guard.admit("ada")).toBe(false);
    expect(guard.begin("ada")).toBe(true);
    void cache.run("ada", "shop.buy", "k", (progress) => {
      progress.ran = true;
      remembered.push("ran");
      return Promise.resolve("ok");
    });
    void cache.run("ada", "shop.buy", "k", (progress) => {
      progress.ran = true;
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
