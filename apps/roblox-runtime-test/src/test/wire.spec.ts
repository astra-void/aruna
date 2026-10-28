// Wire protocol v1 (docs/wire-protocol.md): one versioned frame per remote fire,
// batched once per frame. Every case runs over the real action RemoteEvent the
// transport binds, or the real publisher and subscriber over a loopback remote.
// The runner fires RunService.Heartbeat once per scheduler frame, which is where
// a batching side flushes; cases that need to step frames by hand pass their own
// frame scheduler instead.
import {
  bindActions,
  createActionInvoker,
  createActionDefiner,
  createRemoteEventChannel,
  createSignalPublisher,
  createSignalSubscriber,
  defineAction,
  robloxRemoteEvent,
} from "aruna/roblox";
import { clearActionInvoker, createClientApp } from "aruna/client";
import { createActionRegistry, createServerApp, defineSignal, type ActionMap } from "aruna/server";
import { schema } from "aruna/schema";
import { afterEach, describe, expect, it } from "aruna/testing";
import {
  createRemoteSignalPublisher,
  createRemoteSignalSubscriber,
} from "aruna/internal/signal-runtime";
import {
  WIRE_MAX_FRAME_ITEMS,
  WIRE_PROTOCOL_VERSION,
  createClientChannel,
  createServerChannel,
  readWireFrame,
  type WireFrame,
  type WireFrameRejection,
  type WireFrameScheduler,
} from "aruna/internal/wire";
import type { RequestAbuseReason } from "aruna/internal/request-guard";
import { rejectionOf, waitUntil, wireCall, wireRemote } from "./support";

const cleanups = new Array<() => void>();
function track(cleanup: () => void): void {
  cleanups.push(cleanup);
}
function runCleanups(): void {
  while (cleanups.size() > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) {
      cleanup();
    }
  }
}

// A frame scheduler stepped by the case: `step()` is one frame's flush.
function manualFrames(): WireFrameScheduler & { readonly step: () => void } {
  const listeners = new Array<() => void>();
  return {
    connect: (onFrame) => {
      listeners.push(onFrame);
      return {
        Disconnect: () => {
          const at = listeners.indexOf(onFrame);
          if (at !== -1) {
            listeners.remove(at);
          }
        },
      };
    },
    step: () => {
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
}

function shopActions(runs: { count: number; last?: unknown }): ActionMap<Player> {
  return {
    "shop.buy": defineAction({
      id: "shop.buy",
      input: schema.object({ item: schema.string() }),
      run(_ctx, input) {
        runs.count += 1;
        return { bought: input.item, order: runs.count };
      },
    }),
    "shop.wave": defineAction({
      id: "shop.wave",
      fireAndForget: true,
      run(_ctx, input) {
        runs.count += 1;
        runs.last = input;
        return undefined;
      },
    }),
  } as unknown as ActionMap<Player>;
}

// A server bound over the shared action remote, with the abuse it reports.
function bindServer(options?: {
  readonly batching?: boolean;
  readonly burst?: number;
  readonly frameScheduler?: WireFrameScheduler;
}) {
  const runs = { count: 0 } as { count: number; last?: unknown };
  const abuse = new Array<RequestAbuseReason>();
  const registry = createActionRegistry<Player>(shopActions(runs), {
    ...(options?.burst !== undefined ? { requestBudget: { burst: options.burst, perSecond: 0.001 } } : {}),
    onAbuse: (_player, info) => {
      abuse.push(info.reason);
    },
  });
  const channel = createRemoteEventChannel({
    ...(options?.batching !== undefined ? { batching: options.batching } : {}),
    ...(options?.frameScheduler !== undefined ? { frameScheduler: options.frameScheduler } : {}),
  });
  track(() => channel.dispose());
  const binding = bindActions(registry, { channel });
  track(() => binding.disconnect());
  const wire = wireRemote();
  track(() => wire.dispose());
  return { runs, abuse, wire };
}

// Every frame the client fires on the action remote, seen from the server end.
function spyOnCalls(remote: RemoteEvent) {
  const frames = new Array<WireFrame>();
  const connection = remote.OnServerEvent.Connect((_player: Player, frame: unknown) => {
    frames.push(frame as WireFrame);
  });
  track(() => connection.Disconnect());
  return frames;
}

type Outcome = { readonly ok: boolean; readonly value: unknown };

function settle(promise: Promise<unknown>): Promise<Outcome> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (reason) => ({ ok: false, value: (reason as { name?: string }).name }),
  );
}

describe("wire frames", () => {
  afterEach(runCleanups);

  it("carries the protocol version first and bounds the item count", () => {
    expect(WIRE_PROTOCOL_VERSION).toBe(1);
    expect(readWireFrame([1, { t: 3, s: "a" }])).toEqual({ ok: true, items: [{ t: 3, s: "a" }] });
    expect(readWireFrame(undefined)).toEqual({ ok: false, reason: "malformed-frame" });
    expect(readWireFrame("text")).toEqual({ ok: false, reason: "malformed-frame" });
    expect(readWireFrame([1])).toEqual({ ok: false, reason: "malformed-frame" });
    expect(readWireFrame([2, { s: "a" }])).toEqual({ ok: false, reason: "unknown-protocol-version" });
    expect(readWireFrame(["1", { s: "a" }])).toEqual({ ok: false, reason: "unknown-protocol-version" });

    const full: WireFrame = [1];
    for (let index = 0; index < WIRE_MAX_FRAME_ITEMS; index += 1) {
      full.push({ s: "a" });
    }
    expect(readWireFrame(full).ok).toBe(true);
    full.push({ s: "a" });
    expect(readWireFrame(full)).toEqual({ ok: false, reason: "oversize-batch" });
  });

  it("sends a frame's calls in one fire, and splits past the item bound", async () => {
    const { runs, wire } = bindServer({ burst: 200 });
    const calls = spyOnCalls(wire.remote);
    const frames = manualFrames();
    const invoke = createActionInvoker({ frameScheduler: frames });

    const pending = new Array<Promise<unknown>>();
    for (let index = 0; index < WIRE_MAX_FRAME_ITEMS + 6; index += 1) {
      pending.push(invoke("shop.buy", { item: `i${index}` }));
    }
    expect(calls).toEqual([]);

    frames.step();
    // One flush, two fires: 64 calls, then the 6 past the bound.
    expect(calls.size()).toBe(2);
    expect(calls[0]!.size()).toBe(WIRE_MAX_FRAME_ITEMS + 1);
    expect(calls[1]!.size()).toBe(7);

    await Promise.all(pending);
    expect(runs.count).toBe(WIRE_MAX_FRAME_ITEMS + 6);
  });

  it("gives identical results batched and unbatched", async () => {
    const scenario = async (batching: boolean) => {
      const { runs, wire } = bindServer({ batching });
      const calls = spyOnCalls(wire.remote);
      let counter = 0;
      const invoke = createActionInvoker({
        batching,
        createRequestId: () => {
          counter += 1;
          return `${batching ? "b" : "u"}-${counter}`;
        },
      });
      const outcomes = await Promise.all([
        settle(invoke("shop.buy", { item: "sword" })),
        settle(invoke("shop.buy", { item: 42 })),
        settle(invoke("shop.missing", {})),
        settle(invoke("shop.wave", { hi: true }, { fireAndForget: true })),
        settle(invoke("shop.buy", { item: "shield" }, { idempotencyKey: `${batching}-key` })),
        settle(invoke("shop.buy", { item: "shield" }, { idempotencyKey: `${batching}-key` })),
      ]);
      await waitUntil(() => runs.last !== undefined);
      runCleanups();
      return { outcomes, runs: runs.count, wave: runs.last, fires: calls.size() };
    };

    const unbatched = await scenario(false);
    const batched = await scenario(true);

    expect(batched.outcomes).toEqual(unbatched.outcomes);
    expect(batched.runs).toBe(unbatched.runs);
    expect(batched.wave).toEqual(unbatched.wave);
    expect(unbatched.outcomes).toEqual([
      { ok: true, value: { bought: "sword", order: 1 } },
      { ok: false, value: "ActionValidationError" },
      { ok: false, value: "ActionNotFoundError" },
      { ok: true, value: undefined },
      { ok: true, value: { bought: "shield", order: 3 } },
      { ok: true, value: { bought: "shield", order: 3 } },
    ]);
    // Six calls: six fires one at a time, one fire batched.
    expect(unbatched.fires).toBe(6);
    expect(batched.fires).toBe(1);
  });

  it("delivers batched and unbatched signals identically, in publish order", () => {
    const signals = {
      "fx.hit": defineSignal({ id: "fx.hit", payload: schema.object({ hp: schema.u8() }) }),
      "fx.note": defineSignal({ id: "fx.note", payload: schema.string() }),
    };
    const scenario = (batching: boolean) => {
      const frames = manualFrames();
      const fired = new Array<WireFrame>();
      const handlers = new Array<(frame: unknown) => void>();
      const remote = {
        FireClient: (_player: string, frame: WireFrame) => {
          fired.push(frame);
          for (const handler of handlers) {
            handler(frame);
          }
        },
        FireAllClients: (frame: WireFrame) => {
          fired.push(frame);
          for (const handler of handlers) {
            handler(frame);
          }
        },
        OnClientEvent: {
          Connect: (handler: (frame: unknown) => void) => {
            handlers.push(handler);
            return { Disconnect: () => undefined };
          },
        },
      };
      const received = new Array<string>();
      const subscriber = createRemoteSignalSubscriber(createClientChannel(remote, "signals"), signals);
      subscriber.on("fx.hit", (payload) => received.push(`hit ${payload.hp}`));
      subscriber.on("fx.note", (payload) => received.push(`note ${payload}`));
      const publisher = createRemoteSignalPublisher<typeof signals, string>(
        createServerChannel(remote, { batching, frameScheduler: frames }),
        signals,
      );

      publisher.to("ada", "fx.hit", { hp: 1 });
      publisher.toAll("fx.note", "everyone");
      publisher.to("ada", "fx.hit", { hp: 2 });
      publisher.toMany(["ada", "lin"], "fx.note", "both");
      frames.step();
      subscriber.dispose();
      return { received, fires: fired.size() };
    };

    const unbatched = scenario(false);
    const batched = scenario(true);
    expect(batched.received).toEqual(unbatched.received);
    expect(unbatched.received).toEqual([
      "hit 1",
      "note everyone",
      "hit 2",
      "note both",
      "note both",
    ]);
    // Batched, a broadcast closes the targeted run before it: ada's first hit,
    // the broadcast, then ada's second hit with both notes (ada, lin).
    expect(unbatched.fires).toBe(5);
    expect(batched.fires).toBe(4);
  });

  it("drops an oversize batch whole, before reading a call, and reports it", async () => {
    const { runs, abuse, wire } = bindServer({ burst: 200 });
    const frame: Array<defined> = [1];
    for (let index = 0; index <= WIRE_MAX_FRAME_ITEMS; index += 1) {
      frame.push(wireCall(`r${index}`, "shop.buy", { item: "sword" }));
    }

    await wire.sendFrame(frame);
    expect(runs.count).toBe(0);
    expect(wire.responses()).toEqual([]);
    expect(abuse).toEqual(["oversize-batch"]);

    // At the bound it goes through.
    frame.pop();
    await wire.sendFrame(frame);
    await waitUntil(() => wire.responses().size() >= WIRE_MAX_FRAME_ITEMS);
    expect(runs.count).toBe(WIRE_MAX_FRAME_ITEMS);
  });

  it("drops a frame with an unknown protocol version and reports it", async () => {
    const { runs, abuse, wire } = bindServer();
    await wire.sendFrame([2, wireCall("r1", "shop.buy", { item: "sword" })]);
    await wire.sendFrame({ version: 1, calls: [] });
    expect(runs.count).toBe(0);
    expect(wire.responses()).toEqual([]);
    expect(abuse).toEqual(["unknown-protocol-version", "malformed-envelope"]);
  });

  it("drops a response or signal frame of an unknown version on the client, with a dev warning", async () => {
    const { wire } = bindServer();
    const reported = new Array<string>();
    const invoke = createActionInvoker({
      requestTimeoutMs: 50,
      createRequestId: () => "r-unknown",
      onProtocolError: (channel, reason: WireFrameRejection) => {
        reported.push(`${channel} ${reason}`);
      },
    });
    // A response in a future protocol arrives before the server's real one.
    const pending = settle(invoke("shop.missing", {}));
    wire.remote.FireClient(game.GetService("Players").LocalPlayer, [
      2,
      { t: 2, i: "r-unknown", r: { ok: true, output: "from the future" } },
    ]);
    expect(reported).toEqual(["ArunaRemoteEvent unknown-protocol-version"]);
    // The future frame resolved nothing; the real (v1) answer still does.
    expect(await pending).toEqual({ ok: false, value: "ActionNotFoundError" });

    const signals = { "fx.note": defineSignal({ id: "fx.note", payload: schema.string() }) };
    let deliver: ((frame: unknown) => void) | undefined;
    const client = {
      OnClientEvent: {
        Connect: (handler: (frame: unknown) => void) => {
          deliver = handler;
          return { Disconnect: () => undefined };
        },
      },
    };
    const subscriber = createRemoteSignalSubscriber(createClientChannel(client, "signals"), signals, undefined, {
      onProtocolError: (channel, reason) => {
        reported.push(`${channel} ${reason}`);
      },
    });
    const notes = new Array<string>();
    subscriber.on("fx.note", (payload) => notes.push(payload));
    deliver?.([2, { t: 3, s: "fx.note", d: "future" }]);
    deliver?.([1, { t: 3, s: "fx.note", d: "now" }]);
    expect(notes).toEqual(["now"]);
    expect(reported[1]).toBe("signals unknown-protocol-version");
    subscriber.dispose();
  });

  it("charges the request budget per call inside a batch", async () => {
    const { runs, abuse, wire } = bindServer({ burst: 3 });
    await wire.sendFrame([
      1,
      wireCall("r1", "shop.buy", { item: "a" }),
      wireCall("r2", 42, { item: "b" }),
      wireCall("r3", "shop.buy", { item: "c" }),
      wireCall("r4", "shop.buy", { item: "d" }),
      wireCall("r5", "shop.buy", { item: "e" }),
    ]);
    await waitUntil(() => wire.responses().size() >= 2);

    // Three tokens: two calls and the malformed one. The last two are dropped.
    expect(runs.count).toBe(2);
    expect(wire.responses().map((response) => response.requestId)).toEqual(["r1", "r3"]);
    expect(abuse).toEqual(["malformed-envelope", "budget-exhausted", "budget-exhausted"]);
  });

  it("runs an idempotent retry once and skips a fire-and-forget response inside a batch", async () => {
    const { runs, wire } = bindServer();
    await wire.sendFrame([
      1,
      wireCall("r1", "shop.buy", { item: "sword" }, "key-1"),
      wireCall("r2", "shop.wave", { hi: 1 }),
      wireCall("r3", "shop.buy", { item: "sword" }, "key-1"),
    ]);
    await waitUntil(() => wire.responses().size() >= 2);

    // shop.buy ran once for both attempts; shop.wave ran and answered nothing.
    expect(runs.count).toBe(2);
    expect(runs.last).toEqual({ hi: 1 });
    expect(wire.responses().map((response) => response.requestId)).toEqual(["r1", "r3"]);
    expect(wire.responses()[0]!.result).toEqual(wire.responses()[1]!.result);
    // Both answers left in one frame.
    expect(wire.frames().size()).toBe(1);
  });

  it("carries binary signals inside a batch", () => {
    const signals = {
      "fx.hit": defineSignal({
        id: "fx.hit",
        wire: "binary",
        payload: schema.object({ hp: schema.u16(), crit: schema.boolean() }),
      }),
    };
    const frames = manualFrames();
    const fired = new Array<WireFrame>();
    let deliver: ((frame: unknown) => void) | undefined;
    const remote = {
      FireClient: (_player: string, frame: WireFrame) => {
        fired.push(frame);
        deliver?.(frame);
      },
      FireAllClients: (frame: WireFrame) => {
        fired.push(frame);
        deliver?.(frame);
      },
      OnClientEvent: {
        Connect: (handler: (frame: unknown) => void) => {
          deliver = handler;
          return { Disconnect: () => undefined };
        },
      },
    };
    const received = new Array<defined>();
    const subscriber = createRemoteSignalSubscriber(createClientChannel(remote, "signals"), signals);
    subscriber.on("fx.hit", (payload) => received.push(payload as defined));
    const publisher = createRemoteSignalPublisher<typeof signals, string>(
      createServerChannel(remote, { frameScheduler: frames }),
      signals,
    );

    publisher.to("ada", "fx.hit", { hp: 300, crit: true });
    publisher.to("ada", "fx.hit", { hp: 7, crit: false });
    expect(fired).toEqual([]);
    frames.step();

    expect(fired.size()).toBe(1);
    expect(fired[0]!.size()).toBe(3);
    expect(typeOf((fired[0]![1] as { d: unknown }).d)).toBe("buffer");
    expect(received).toEqual([
      { hp: 300, crit: true },
      { hp: 7, crit: false },
    ]);
    subscriber.dispose();
  });

  it("never batches an unreliable signal", () => {
    const signals = {
      "fx.move": defineSignal({ id: "fx.move", unreliable: true, payload: schema.f32() }),
    };
    const frames = manualFrames();
    const fired = new Array<WireFrame>();
    const remote = {
      FireClient: (_player: string, frame: WireFrame) => fired.push(frame),
      FireAllClients: (frame: WireFrame) => fired.push(frame),
    };
    const publisher = createRemoteSignalPublisher<typeof signals, string>(
      createServerChannel(remote, { frameScheduler: frames }),
      signals,
      remote,
    );
    publisher.to("ada", "fx.move", 1);
    publisher.to("ada", "fx.move", 2);
    // Out at once, one signal per frame, without waiting for the flush.
    expect(fired).toEqual([
      [1, { t: 3, s: "fx.move", d: 1 }],
      [1, { t: 3, s: "fx.move", d: 2 }],
    ]);
  });

  it("rejects a call whose frame the server never answers", async () => {
    bindServer();
    const invoke = createActionInvoker({ requestTimeoutMs: 30, frameScheduler: manualFrames() });
    // The frame is never flushed (the scheduler is never stepped).
    const reason = await rejectionOf(invoke("shop.buy", { item: "sword" }));
    expect(reason.name).toBe("ActionTimeoutError");
  });
});

describe("one ordered reliable channel", () => {
  afterEach(() => {
    runCleanups();
    clearActionInvoker();
  });

  const signals = {
    "shop.sold": defineSignal({ id: "shop.sold", payload: schema.string() }),
  };
  const define = createActionDefiner<typeof signals>();
  const actions = {
    "shop.sell": define({
      id: "shop.sell",
      input: schema.string(),
      run(ctx, input) {
        ctx.publisher.to(ctx.player, "shop.sold", `to ${input}`);
        ctx.publisher.toAll("shop.sold", `all ${input}`);
        return input;
      },
    }),
  } as unknown as ActionMap<Player>;

  it("delivers what run() published before the response, over the default wiring at Heartbeat", async () => {
    // The generated entries' wiring: the transport and the publisher share the
    // remote's server channel, the invoker and the subscriber its client channel.
    const serverApp = createServerApp<Player, typeof signals>({
      actions,
      signals,
      transport: robloxRemoteEvent(),
      createPublisher: createSignalPublisher,
    });
    track(() => serverApp.dispose());
    const clientApp = createClientApp({
      transport: createActionInvoker(),
      signals,
      createSubscriber: createSignalSubscriber,
    });
    track(() => clientApp.dispose());

    const log = new Array<string>();
    clientApp.subscriber?.on("shop.sold", (payload) => log.push(`signal ${payload}`));
    const sold = Promise.all(
      ["a", "b"].map((item) => clientApp.invoke("shop.sell", item).then(() => log.push(`response ${item}`))),
    );
    await sold;

    // Each action's signals (targeted, then broadcast) ahead of its response,
    // and the two actions in the order they were called.
    expect(log).toEqual([
      "signal to a",
      "signal all a",
      "response a",
      "signal to b",
      "signal all b",
      "response b",
    ]);
  });
});
