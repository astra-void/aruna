// Opt-in network metrics: what they count, what they refuse to keep, and what
// they cost.
import { defineAction, defineResource } from "aruna/roblox";
import { schema } from "aruna/schema";
import {
  createNetworkMetrics,
  defineSignal,
  estimateWireBytes,
  formatNetworkReport,
  type ActionRejectionInfo,
} from "aruna/server";
import { createTestNetwork, createTestPlayer, createTestServerApp, describe, expect, it } from "aruna/testing";
import { createWireFrame } from "aruna/internal/wire";

function fixtures() {
  let coins = 0;
  const wallet = defineResource({
    id: "economy.wallet",
    schema: schema.object({ coins: schema.u32() }),
    load() {
      return { coins };
    },
  });
  const earn = defineAction({
    id: "economy.earn",
    input: schema.object({ amount: schema.u16(), memo: schema.optional(schema.string().maxLength(16)) }),
    errors: { Closed: {} },
    rateLimit: { key: "player", windowMs: 1000, max: 3 },
    run(ctx, input) {
      if (input.amount === 0) {
        throw ctx.fail("Closed");
      }
      coins += input.amount;
      ctx.resources?.invalidate(wallet);
      ctx.publisher?.toAll("economy.paid", { coins });
      return coins;
    },
  });
  const crash = defineAction({
    id: "debug.crash",
    run() {
      throw "boom";
    },
  });
  const signals = { "economy.paid": defineSignal({ id: "economy.paid", payload: schema.object({ coins: schema.u32() }) }) };
  return { wallet, earn, crash, signals };
}

describe("network metrics", () => {
  it("counts requests, rejections by name, and server time per action, and tells onReject", () => {
    const f = fixtures();
    const metrics = createNetworkMetrics();
    const rejections = new Array<ActionRejectionInfo<Player>>();
    const harness = createTestServerApp({
      actions: { [f.earn.id]: f.earn, [f.crash.id]: f.crash },
      metrics,
      exposeInternalErrors: false,
      onReject: (info) => rejections.push(info),
    });
    const player = createTestPlayer();
    harness.join(player);
    void harness.invoke(player, "economy.earn", { amount: 5 });
    void harness.invoke(player, "economy.earn", { amount: 0 }).catch(() => {});
    void harness.invoke(player, "economy.earn", { amount: -1 }).catch(() => {});
    void harness.invoke(player, "economy.earn", { amount: 1 });
    void harness.invoke(player, "economy.earn", { amount: 1 }).catch(() => {});
    void harness.invoke(player, "debug.crash").catch(() => {});

    const report = metrics.report();
    const earn = report.actions["economy.earn"]!;
    expect(earn.requests).toBe(5);
    expect(earn.ok).toBe(2);
    expect(earn.rejected).toBe(3);
    expect(earn.rejections).toEqual({ ActionRateLimitError: 1, ActionValidationError: 1, Closed: 1 });
    expect(earn.server.samples).toBe(5);
    expect(earn.checks.samples).toBe(3);
    expect(report.actions["debug.crash"]!.rejections).toEqual({ ActionInternalError: 1 });
    const kinds = new Array<string>();
    for (const info of rejections) {
      kinds.push(`${info.actionId}:${info.kind}:${info.errorName}`);
    }
    expect(kinds).toEqual([
      "economy.earn:declared:Closed",
      "economy.earn:validation:ActionValidationError",
      "economy.earn:rate-limit:ActionRateLimitError",
      "debug.crash:internal:ActionInternalError",
    ]);
    harness.dispose();
  });

  it("measures the client's round trip separately from server time, on the network's clock", async () => {
    const f = fixtures();
    let now = 0;
    const metrics = createNetworkMetrics({ nowMs: () => now });
    const net = createTestNetwork({
      actions: { [f.earn.id]: f.earn },
      players: [1],
      latencyMs: 40,
      metrics,
      clientMiddleware: [metrics.clientMiddleware()],
    });
    const call = net.client(1).invoke("economy.earn", { amount: 2 });
    for (let frame = 0; frame < 20; frame += 1) {
      net.advance(16);
      now = net.now();
    }
    await call;
    const earn = metrics.report().actions["economy.earn"]!;
    expect(earn.client.samples).toBe(1);
    // Two 40 ms legs, rounded up to the 16 ms frames they leave on.
    expect(earn.client.p50! >= 80 && earn.client.p50! <= 112).toBe(true);
    expect(earn.server.p50).toBe(0);
    net.dispose();
  });

  it("counts resource snapshots, invalidations, resyncs, and live subscribers", () => {
    const f = fixtures();
    const metrics = createNetworkMetrics();
    const harness = createTestServerApp({
      actions: { [f.earn.id]: f.earn },
      resources: { [f.wallet.id]: f.wallet },
      signals: f.signals,
      metrics,
    });
    const a = createTestPlayer();
    const b = createTestPlayer();
    harness.join(a);
    harness.join(b);
    const subscription = harness.client(a).resources!.subscribe("economy.wallet");
    harness.client(b).resources!.subscribe("economy.wallet");
    void harness.invoke(a, "economy.earn", { amount: 4 });
    subscription.refresh();
    const resource = metrics.report().resources["economy.wallet"]!;
    expect(resource.subscribes).toBe(2);
    expect(resource.resyncs).toBe(1);
    expect(resource.invalidations).toBe(1);
    expect(resource.snapshots).toBe(4);
    expect(resource.subscribers).toBe(2);
    expect(resource.estimatedBytes > 0).toBe(true);
    const report = metrics.report();
    expect(report.signals["economy.paid"]!.items).toBe(1);
    expect(report.wire.items.resourceStates).toBe(4);
    harness.dispose();
  });

  it("counts envelopes refused before dispatch by reason", () => {
    const f = fixtures();
    const metrics = createNetworkMetrics();
    const net = createTestNetwork({ actions: { [f.earn.id]: f.earn }, players: [1], metrics });
    net.link(1).up.inject("garbage");
    net.link(1).up.inject(createWireFrame([{ t: 1, i: "r", a: "nope" }]));
    net.flush();
    expect(metrics.report().abuse).toEqual({ "malformed-envelope": 1, "unknown-action": 1 });
    net.dispose();
  });

  it("estimates frame sizes by the documented accounting", () => {
    // [1, { t = 3, s = "x", d = 5 }]: the 75-byte signal frame overhead plus the
    // id's one byte (docs/wire-protocol.md).
    expect(estimateWireBytes(createWireFrame([{ t: 3, s: "x", d: 5 }]))).toBe(76);
    expect(estimateWireBytes("abc")).toBe(11);
    expect(estimateWireBytes([1, 2])).toBe(24);
  });

  it("stays bounded: a capped sample ring and an (other) bucket past maxKeys", () => {
    const metrics = createNetworkMetrics({ samples: 4, maxKeys: 2 });
    for (let index = 0; index < 10; index += 1) {
      metrics.dispatchObserver.onSettled({ actionId: "a", player: 1, ok: true, durationMs: index, fromClient: true });
    }
    for (const actionId of ["b", "c", "d"]) {
      metrics.dispatchObserver.onSettled({ actionId, player: 1, ok: true, durationMs: 1, fromClient: true });
    }
    const report = metrics.report();
    expect(report.actions["a"]!.server.samples).toBe(4);
    expect(report.actions["a"]!.server.max).toBe(9);
    expect(report.actions["(other)"]!.requests).toBe(2);
    expect(report.actions["d"]).toBe(undefined);
    metrics.reset();
    expect(metrics.report().actions["a"]).toBe(undefined);
  });

  it("never keeps a payload, and formats a readable report", () => {
    const f = fixtures();
    const metrics = createNetworkMetrics();
    const harness = createTestServerApp({ actions: { [f.earn.id]: f.earn }, metrics });
    const player = createTestPlayer();
    harness.join(player);
    void harness.invoke(player, "economy.earn", { amount: 3, memo: "hunter2" });
    void harness.invoke(player, "economy.earn", { amount: 1, memo: "x".rep(40) }).catch(() => {});
    const text = formatNetworkReport(metrics.report());
    expect(text.find("hunter2", 1, true)[0]).toBe(undefined);
    expect(text.find("Action: economy.earn", 1, true)[0] !== undefined).toBe(true);
    expect(text.find("Rejected:       1", 1, true)[0] !== undefined).toBe(true);
    expect(text.find("not measured traffic", 1, true)[0] !== undefined).toBe(true);
    harness.dispose();
  });

  it("costs little when on, and nothing when off", () => {
    const f = fixtures();
    const calls = 3000;
    const time = (withMetrics: boolean): number => {
      const harness = createTestServerApp({
        actions: {
          "bench.ping": defineAction({
            id: "bench.ping",
            input: schema.object({ n: schema.u16() }),
            run(_ctx, input) {
              return input.n;
            },
          }),
        },
        ...(withMetrics ? { metrics: createNetworkMetrics() } : {}),
      });
      const player = createTestPlayer();
      harness.join(player);
      const started = os.clock();
      for (let index = 0; index < calls; index += 1) {
        void harness.invoke(player, "bench.ping", { n: index % 100 });
      }
      const elapsed = os.clock() - started;
      harness.dispose();
      return elapsed;
    };
    time(false);
    const off = time(false);
    const on = time(true);
    print(
      `metrics overhead: ${calls} in-process dispatches, off ${string.format("%.1f", off * 1000)}ms, on ${string.format(
        "%.1f",
        on * 1000,
      )}ms (${string.format("%.2f", on / math.max(off, 1e-6))}x)`,
    );
    expect(on < off * 3 + 0.05).toBe(true);
    void f;
  });
});
