// Server-owned resources (docs/rfcs/resources.md): every case runs through the
// real host, the real admission in front of it, and the real client, over the
// test harness's channel — batched where the order a client reads things in is
// the point.
import { bindRemoteActions, createRemoteResourceClient, defineAction, defineResource } from "aruna/roblox";
import { createActionRegistry } from "aruna/server";
import { createResourceHost } from "aruna/internal/resource";
import { schema } from "aruna/schema";
import { createTestPlayer, createTestServerApp, describe, expect, it } from "aruna/testing";
import {
  createClientChannel,
  createServerChannel,
  createWireFrame,
  readWireFrame,
  WIRE_ITEM_RESOURCE,
  WIRE_ITEM_RESOURCE_SUBSCRIPTION,
  type WireFrame,
} from "aruna/internal/wire";

const progressSchema = schema.object({ quest: schema.string().maxLength(32), step: schema.u16() });

// Per-player progress the server owns, and a load counter per player.
function questWorld() {
  const steps = new Map<number, number>();
  const loads = new Map<number, number>();
  const stepOf = (player: Player) => steps.get(player.UserId) ?? 0;
  return {
    steps,
    loads,
    stepOf,
    loadsOf: (player: Player) => loads.get(player.UserId) ?? 0,
    progress: defineResource({
      id: "quests.progress",
      schema: progressSchema,
      load(ctx) {
        loads.set(ctx.player.UserId, (loads.get(ctx.player.UserId) ?? 0) + 1);
        return { quest: "intro", step: stepOf(ctx.player) };
      },
    }),
  };
}

function advanceAction(world: ReturnType<typeof questWorld>) {
  return defineAction({
    id: "quests.advance",
    run(ctx) {
      world.steps.set(ctx.player.UserId, world.stepOf(ctx.player) + 1);
      ctx.resources?.invalidate(world.progress);
      return world.stepOf(ctx.player);
    },
  });
}

type Progress = { readonly quest: string; readonly step: number };

describe("resources: snapshots and updates", () => {
  it("sends an initial snapshot to a subscriber", () => {
    const world = questWorld();
    world.steps.set(1, 3);
    const harness = createTestServerApp({ actions: {}, resources: { [world.progress.id]: world.progress } });
    const player = createTestPlayer({ userId: 1 });
    harness.join(player);

    const seen = new Array<Progress>();
    const subscription = harness.client(player).resources!.subscribe("quests.progress", (value) => {
      seen.push(value as Progress);
    });
    expect(subscription.status()).toBe("ready");
    expect((subscription.get() as Progress).step).toBe(3);
    expect(subscription.revision() >= 1).toBe(true);
    expect(seen.size()).toBe(1);
    expect(harness.app.resources!.isSubscribed("quests.progress", player)).toBe(true);
    harness.dispose();
  });

  it("delivers an invalidation from inside an action before that action's response", async () => {
    const world = questWorld();
    const harness = createTestServerApp({
      batching: true,
      actions: { "quests.advance": advanceAction(world) },
      resources: { [world.progress.id]: world.progress },
    });
    const player = createTestPlayer({ userId: 1 });
    harness.join(player);
    const client = harness.client(player);
    const order = new Array<string>();
    client.resources!.subscribe("quests.progress", (value) => {
      order.push(`state:${(value as Progress).step}`);
    });
    harness.step();
    harness.step();
    expect(order).toEqual(["state:0"]);

    const answered = client.invoke("quests.advance").then((step) => {
      order.push(`response:${step}`);
    });
    harness.step();
    await answered;
    expect(order).toEqual(["state:0", "state:1", "response:1"]);
    harness.dispose();
  });

  it("keeps the newest value when an update overtakes a slow snapshot", () => {
    // The first load is held open; an invalidation arrives meanwhile, so the
    // server marks the key dirty and loads again when the first load finishes.
    const pending = new Array<(value: Progress) => void>();
    let step = 0;
    let loads = 0;
    const slow = defineResource({
      id: "quests.slow",
      schema: progressSchema,
      load() {
        loads += 1;
        const read = step;
        if (loads === 1) {
          return new Promise<Progress>((resolve) => {
            pending.push(() => resolve({ quest: "intro", step: read }));
          });
        }
        return { quest: "intro", step: read };
      },
    });
    const harness = createTestServerApp({ actions: {}, resources: { [slow.id]: slow } });
    const player = createTestPlayer();
    harness.join(player);
    const seen = new Array<number>();
    const subscription = harness.client(player).resources!.subscribe("quests.slow", (value) => {
      seen.push((value as Progress).step);
    });
    expect(subscription.status()).toBe("loading");

    step = 1;
    harness.app.resources!.invalidate("quests.slow", player);
    expect(loads).toBe(1);
    pending[0]!({ quest: "intro", step: 0 });

    // The stale snapshot (step 0, taken before the change) went out first, then
    // the reload the invalidation queued; the client ends on the newest value.
    expect(loads).toBe(2);
    expect(seen).toEqual([0, 1]);
    expect((subscription.get() as Progress).step).toBe(1);
    harness.dispose();
  });

  it("refreshes on request, and a resync is idempotent", () => {
    const world = questWorld();
    const harness = createTestServerApp({ actions: {}, resources: { [world.progress.id]: world.progress } });
    const player = createTestPlayer({ userId: 4 });
    harness.join(player);
    const client = harness.client(player);
    const subscription = client.resources!.subscribe("quests.progress");
    const first = subscription.revision();
    subscription.refresh();
    client.resources!.resync();
    client.resources!.resync();
    expect(subscription.revision() > first).toBe(true);
    expect(world.loadsOf(player)).toBe(4);
    expect((subscription.get() as Progress).step).toBe(0);
    expect(harness.app.resources!.subscriberCount("quests.progress")).toBe(1);
    harness.dispose();
  });
});

describe("resources: revisions on the client", () => {
  // A resource client fed hand-made state items, as a hostile or broken
  // network would deliver them.
  function fedClient() {
    let deliver: ((frame: unknown) => void) | undefined;
    const channel = createClientChannel(
      {
        OnClientEvent: {
          Connect: (callback) => {
            deliver = callback;
            return { Disconnect: () => {} };
          },
        },
      },
      "resources",
    );
    const sent = new Array<WireFrame>();
    const client = createRemoteResourceClient(channel, { FireServer: (frame) => sent.push(frame) }, {
      batching: false,
    });
    const push = (item: object) => deliver!(createWireFrame([item as defined]));
    return { client, push, sent, channel };
  }

  it("drops stale, duplicate, and malformed revisions", () => {
    const fed = fedClient();
    const seen = new Array<defined>();
    const subscription = fed.client.subscribe("r", (value) => seen.push(value as defined));
    fed.push({ t: WIRE_ITEM_RESOURCE, r: "r", v: 5, d: "five" });
    fed.push({ t: WIRE_ITEM_RESOURCE, r: "r", v: 5, d: "five again" });
    fed.push({ t: WIRE_ITEM_RESOURCE, r: "r", v: 3, d: "three" });
    for (const revision of [0, -1, 1.5, 0 / 0, math.huge, "9"]) {
      fed.push({ t: WIRE_ITEM_RESOURCE, r: "r", v: revision, d: "bad" });
    }
    fed.push({ t: WIRE_ITEM_RESOURCE, r: "r", d: "no revision" });
    expect(seen).toEqual(["five"]);
    expect(subscription.revision()).toBe(5);
    fed.push({ t: WIRE_ITEM_RESOURCE, r: "r", v: 6, d: "six" });
    expect(seen).toEqual(["five", "six"]);
    fed.client.dispose();
    fed.channel.dispose();
  });

  it("keeps the last value through an error, and recovers on the next state", () => {
    const fed = fedClient();
    const errors = new Array<string>();
    const subscription = fed.client.subscribe("r", undefined, {
      onError: (name, info) => errors.push(`${name}:${info.errorId}`),
    });
    fed.push({ t: WIRE_ITEM_RESOURCE, r: "r", v: 1, d: "one" });
    fed.push({ t: WIRE_ITEM_RESOURCE, r: "r", v: 2, e: "ResourceLoadError", i: "abcd" });
    expect(subscription.status()).toBe("error");
    expect(subscription.error()).toBe("ResourceLoadError");
    expect(subscription.get()).toBe("one");
    expect(errors).toEqual(["ResourceLoadError:abcd"]);
    fed.push({ t: WIRE_ITEM_RESOURCE, r: "r", v: 3, d: "three" });
    expect(subscription.status()).toBe("ready");
    expect(subscription.get()).toBe("three");
    fed.client.dispose();
    fed.channel.dispose();
  });

  it("does not roll back to an item from before a resubscription", () => {
    const fed = fedClient();
    const first = fed.client.subscribe("r");
    fed.push({ t: WIRE_ITEM_RESOURCE, r: "r", v: 7, d: "seven" });
    first.disconnect();
    const second = fed.client.subscribe("r");
    // Still in flight from before: refused.
    fed.push({ t: WIRE_ITEM_RESOURCE, r: "r", v: 7, d: "late" });
    expect(second.get()).toBe(undefined);
    fed.push({ t: WIRE_ITEM_RESOURCE, r: "r", v: 8, d: "fresh" });
    expect(second.get()).toBe("fresh");
    fed.client.dispose();
    fed.channel.dispose();
  });

  it("shares one wire subscription between local subscriptions", () => {
    const fed = fedClient();
    const a = fed.client.subscribe("r");
    const b = fed.client.subscribe("r");
    fed.push({ t: WIRE_ITEM_RESOURCE, r: "r", v: 1, d: "x" });
    const late = new Array<defined>();
    // A third subscriber is handed the current value at once.
    const c = fed.client.subscribe("r", (value) => late.push(value as defined));
    expect(late).toEqual(["x"]);
    a.disconnect();
    b.disconnect();
    c.disconnect();
    c.disconnect();
    const operations = new Array<number>();
    for (const frame of fed.sent) {
      const read = readWireFrame(frame);
      if (read.ok) {
        for (const item of read.items) {
          const subscription = item as { readonly t: number; readonly o: number };
          expect(subscription.t).toBe(WIRE_ITEM_RESOURCE_SUBSCRIPTION);
          operations.push(subscription.o);
        }
      }
    }
    expect(operations).toEqual([1, 0]);
    fed.client.dispose();
    fed.channel.dispose();
  });
});

describe("resources: authority and isolation", () => {
  it("gives each player only their own value", () => {
    const world = questWorld();
    world.steps.set(101, 1);
    world.steps.set(202, 9);
    const harness = createTestServerApp({ actions: {}, resources: { [world.progress.id]: world.progress } });
    const alice = createTestPlayer({ userId: 101, name: "Alice" });
    const bob = createTestPlayer({ userId: 202, name: "Bob" });
    harness.join(alice);
    harness.join(bob);
    const aliceSeen = new Array<number>();
    const bobSeen = new Array<number>();
    harness.client(alice).resources!.subscribe("quests.progress", (value) => aliceSeen.push((value as Progress).step));
    harness.client(bob).resources!.subscribe("quests.progress", (value) => bobSeen.push((value as Progress).step));

    world.steps.set(101, 2);
    harness.app.resources!.invalidate("quests.progress", alice);
    expect(aliceSeen).toEqual([1, 2]);
    expect(bobSeen).toEqual([9]);
    expect(world.loadsOf(bob)).toBe(1);
    harness.dispose();
  });

  it("refuses a subscription the resource does not authorize, without loading", () => {
    let loads = 0;
    const admin = defineResource({
      id: "admin.audit",
      scope: "global",
      schema: schema.array(schema.string().maxLength(8)).maxItems(4),
      load() {
        loads += 1;
        return ["ok"];
      },
      authorize: (ctx) => ctx.player.UserId === 1,
    });
    const harness = createTestServerApp({ actions: {}, resources: { [admin.id]: admin } });
    const allowed = createTestPlayer({ userId: 1 });
    const denied = createTestPlayer({ userId: 2 });
    harness.join(allowed);
    harness.join(denied);
    const deniedErrors = new Array<string>();
    const refused = harness.client(denied).resources!.subscribe("admin.audit", undefined, {
      onError: (name) => deniedErrors.push(name),
    });
    expect(refused.status()).toBe("error");
    expect(deniedErrors).toEqual(["ResourceForbiddenError"]);
    expect(loads).toBe(0);
    expect(harness.app.resources!.isSubscribed("admin.audit", denied)).toBe(false);
    const granted = harness.client(allowed).resources!.subscribe("admin.audit");
    expect(granted.get()).toEqual(["ok"]);
    harness.dispose();
  });

  it("admits subscription items like calls: forged scope ignored, unknown and malformed reported, budget charged", () => {
    const world = questWorld();
    world.steps.set(101, 1);
    world.steps.set(202, 9);
    const reports = new Array<string>();
    const registry = createActionRegistry<Player>(
      {},
      {
        requestBudget: { burst: 6, perSecond: 0.001 },
        onAbuse: (player, info) => reports.push(`${player.UserId}:${info.reason}`),
      },
    );
    const host = createResourceHost<Player>({ [world.progress.id]: world.progress });
    const delivered = new Array<{ readonly player: number; readonly step: number }>();
    const channel = createServerChannel<Player>(
      {
        FireClient: (player, frame) => {
          const read = readWireFrame(frame);
          if (read.ok) {
            for (const item of read.items) {
              const state = item as { readonly d?: Progress };
              delivered.push({ player: player.UserId, step: state.d!.step });
            }
          }
        },
        FireAllClients: () => {},
      },
      { batching: false },
    );
    let fire: ((player: Player, frame: unknown) => void) | undefined;
    const binding = bindRemoteActions<Player>(
      registry,
      {
        OnServerEvent: {
          Connect: (callback) => {
            fire = callback;
            return { Disconnect: () => {} };
          },
        },
      },
      channel,
      host,
    );
    const alice = createTestPlayer({ userId: 101 });
    const bob = createTestPlayer({ userId: 202 });
    const send = (player: Player, item: object) => fire!(player, createWireFrame([item as defined]));

    // Alice names Bob in every field a client could: the server reads none.
    send(alice, { t: WIRE_ITEM_RESOURCE_SUBSCRIPTION, r: "quests.progress", o: 1, p: 202, player: bob, userId: 202 });
    expect(delivered).toEqual([{ player: 101, step: 1 }]);
    expect(host.isSubscribed("quests.progress", bob)).toBe(false);
    expect(world.loadsOf(bob)).toBe(0);

    send(alice, { t: WIRE_ITEM_RESOURCE_SUBSCRIPTION, r: "quests.secret", o: 1 });
    send(alice, { t: WIRE_ITEM_RESOURCE_SUBSCRIPTION, r: "quests.progress", o: 2 });
    send(alice, { t: WIRE_ITEM_RESOURCE_SUBSCRIPTION, r: 42, o: 1 });
    send(alice, { t: WIRE_ITEM_RESOURCE_SUBSCRIPTION, r: string.rep("x", 200), o: 1 });
    expect(reports).toEqual([
      "101:unknown-resource",
      "101:malformed-envelope",
      "101:malformed-envelope",
      "101:malformed-envelope",
    ]);
    // Six tokens: the five items above, then one more; the next is over budget.
    send(alice, { t: WIRE_ITEM_RESOURCE_SUBSCRIPTION, r: "quests.progress", o: 0 });
    send(alice, { t: WIRE_ITEM_RESOURCE_SUBSCRIPTION, r: "quests.progress", o: 1 });
    expect(reports[reports.size() - 1]).toBe("101:budget-exhausted");
    expect(host.isSubscribed("quests.progress", alice)).toBe(false);

    // Bob leaves (what the app does on PlayerRemoving), then a subscription of
    // his still arrives: it creates no state, loads nothing, and is not reported.
    const reportsBefore = reports.size();
    registry.forgetPlayer(bob);
    host.forgetPlayer(bob);
    send(bob, { t: WIRE_ITEM_RESOURCE_SUBSCRIPTION, r: "quests.progress", o: 1 });
    send(bob, { t: WIRE_ITEM_RESOURCE_SUBSCRIPTION, r: "quests.progress", o: 0 });
    expect(host.isSubscribed("quests.progress", bob)).toBe(false);
    expect(world.loadsOf(bob)).toBe(0);
    expect(reports.size()).toBe(reportsBefore);
    binding.disconnect();
    host.dispose();
  });
});

describe("resources: lifecycle", () => {
  it("drops a departed player's subscriptions, and a slow load lands nowhere", () => {
    const pending = new Array<() => void>();
    const slow = defineResource({
      id: "quests.slow",
      schema: progressSchema,
      load() {
        return new Promise<Progress>((resolve) => {
          pending.push(() => resolve({ quest: "intro", step: 0 }));
        });
      },
    });
    const sentAfterLeave = new Array<defined>();
    const harness = createTestServerApp({ actions: {}, resources: { [slow.id]: slow } });
    const player = createTestPlayer();
    harness.join(player);
    harness.client(player).resources!.subscribe("quests.slow", (value) => sentAfterLeave.push(value as defined));
    harness.leave(player);
    expect(harness.app.resources!.subscriberCount("quests.slow")).toBe(0);
    pending[0]!();
    expect(sentAfterLeave).toEqual([]);
    harness.dispose();
  });

  it("restores a coherent snapshot on rejoin", () => {
    const world = questWorld();
    const harness = createTestServerApp({
      actions: { "quests.advance": advanceAction(world) },
      resources: { [world.progress.id]: world.progress },
    });
    const player = createTestPlayer({ userId: 9 });
    harness.join(player);
    const before = harness.client(player);
    before.resources!.subscribe("quests.progress");
    world.steps.set(9, 4);
    harness.leave(player);
    before.dispose();

    harness.join(player);
    const after = harness.client(player).resources!.subscribe("quests.progress");
    expect((after.get() as Progress).step).toBe(4);
    expect(after.status()).toBe("ready");
    harness.dispose();
  });

  it("unsubscribes on the last disconnect", () => {
    const world = questWorld();
    const harness = createTestServerApp({ actions: {}, resources: { [world.progress.id]: world.progress } });
    const player = createTestPlayer();
    harness.join(player);
    const resources = harness.client(player).resources!;
    const a = resources.subscribe("quests.progress");
    const b = resources.subscribe("quests.progress");
    a.disconnect();
    expect(harness.app.resources!.isSubscribed("quests.progress", player)).toBe(true);
    b.disconnect();
    expect(harness.app.resources!.isSubscribed("quests.progress", player)).toBe(false);
    harness.app.resources!.invalidate("quests.progress");
    expect(world.loadsOf(player)).toBe(1);
    harness.dispose();
  });

  it("stops sending when the app is disposed", () => {
    const world = questWorld();
    const harness = createTestServerApp({ actions: {}, resources: { [world.progress.id]: world.progress } });
    const player = createTestPlayer();
    harness.join(player);
    const subscription = harness.client(player).resources!.subscribe("quests.progress");
    const revision = subscription.revision();
    const host = harness.app.resources!;
    harness.dispose();
    host.invalidate("quests.progress", player);
    expect(subscription.revision()).toBe(revision);
  });
});

describe("resources: errors and serialization", () => {
  it("never sends a value that fails the schema or the serialization boundary", () => {
    let mode = "ok";
    const failures = new Array<string>();
    const resource = defineResource({
      id: "quests.fragile",
      schema: progressSchema,
      load() {
        if (mode === "schema") {
          return { quest: "intro", step: -1 } as never;
        }
        if (mode === "function") {
          return { quest: "intro", step: 1, extra: () => 1 } as never;
        }
        if (mode === "throw") {
          throw "database on fire";
        }
        return { quest: "intro", step: 1 };
      },
    });
    const harness = createTestServerApp({
      actions: {},
      resources: { [resource.id]: resource },
      onResourceError: (_failure, info) => failures.push(info.errorId),
    });
    const player = createTestPlayer();
    harness.join(player);
    const clientErrors = new Array<string>();
    const subscription = harness.client(player).resources!.subscribe("quests.fragile", undefined, {
      onError: (name, info) => clientErrors.push(`${name}:${info.errorId}`),
    });
    for (const failing of ["schema", "function", "throw"]) {
      mode = failing;
      harness.app.resources!.invalidate("quests.fragile", player);
      expect(subscription.status()).toBe("error");
      expect((subscription.get() as Progress).step).toBe(1);
    }
    expect(failures.size()).toBe(3);
    expect(clientErrors.size()).toBe(3);
    for (let index = 0; index < 3; index += 1) {
      expect(clientErrors[index]).toBe(`ResourceLoadError:${failures[index]}`);
    }
    mode = "ok";
    harness.app.resources!.invalidate("quests.fragile", player);
    expect(subscription.status()).toBe("ready");
    harness.dispose();
  });
});

describe("resources: global scope and backpressure", () => {
  it("loads a global resource once per invalidation and answers new subscribers from it", () => {
    let loads = 0;
    let boss = 100;
    const bossHealth = defineResource({
      id: "encounter.boss",
      scope: "global",
      schema: schema.object({ health: schema.u16() }),
      load() {
        loads += 1;
        return { health: boss };
      },
    });
    const harness = createTestServerApp({ actions: {}, resources: { [bossHealth.id]: bossHealth } });
    const a = createTestPlayer();
    const b = createTestPlayer();
    const c = createTestPlayer();
    harness.join(a);
    harness.join(b);
    harness.join(c);
    const sa = harness.client(a).resources!.subscribe("encounter.boss");
    const sb = harness.client(b).resources!.subscribe("encounter.boss");
    expect(loads).toBe(1);
    boss = 40;
    harness.app.resources!.invalidate(bossHealth);
    expect(loads).toBe(2);
    expect(sa.get()).toEqual({ health: 40 });
    expect(sb.get()).toEqual({ health: 40 });
    expect(sa.revision()).toBe(sb.revision());
    const sc = harness.client(c).resources!.subscribe("encounter.boss");
    expect(loads).toBe(2);
    expect(sc.get()).toEqual({ health: 40 });
    harness.dispose();
  });

  it("coalesces a burst of invalidations into one item per frame and one load in flight", () => {
    const world = questWorld();
    const harness = createTestServerApp({
      batching: true,
      actions: {},
      resources: { [world.progress.id]: world.progress },
    });
    const player = createTestPlayer({ userId: 3 });
    harness.join(player);
    const seen = new Array<number>();
    harness.client(player).resources!.subscribe("quests.progress", (value) => seen.push((value as Progress).step));
    harness.step();
    harness.step();
    for (let step = 1; step <= 10; step += 1) {
      world.steps.set(3, step);
      harness.app.resources!.invalidate("quests.progress", player);
    }
    harness.step();
    expect(seen).toEqual([0, 10]);

    // An async load: ten invalidations while it runs cost one more load.
    let loads = 0;
    const pending = new Array<() => void>();
    const slow = defineResource({
      id: "quests.slow",
      schema: progressSchema,
      load() {
        loads += 1;
        return new Promise<Progress>((resolve) => {
          pending.push(() => resolve({ quest: "intro", step: loads }));
        });
      },
    });
    const slowHarness = createTestServerApp({ actions: {}, resources: { [slow.id]: slow } });
    const other = createTestPlayer();
    slowHarness.join(other);
    slowHarness.client(other).resources!.subscribe("quests.slow");
    for (let index = 0; index < 10; index += 1) {
      slowHarness.app.resources!.invalidate("quests.slow", other);
    }
    expect(loads).toBe(1);
    pending[0]!();
    expect(loads).toBe(2);
    pending[1]!();
    expect(loads).toBe(2);
    slowHarness.dispose();
    harness.dispose();
  });
});

describe("resources: failure paths", () => {
  // docs/resources.md "A load must settle": no timeout is applied, so a load that
  // waits on something outside should reject past its own bound. The rejection
  // must free the key for everyone waiting on it.
  // Unsubscribing used to drop a player-scoped key even while its load ran, so
  // the next subscribe started another load: a client toggling the two could
  // run one load per item it sent, around the one-load-per-key rule.
  it("does not start a load per subscribe and unsubscribe toggle while one is running", () => {
    const pending = new Array<(value: Progress) => void>();
    const slow = defineResource({
      id: "quests.toggled",
      schema: progressSchema,
      load() {
        return new Promise<Progress>((resolve) => {
          pending.push(resolve);
        });
      },
    });
    const host = createResourceHost<Player>({ [slow.id]: slow });
    const received = new Array<defined>();
    host.attach(
      createServerChannel<Player>(
        {
          FireClient: (_player, frame) => {
            const read = readWireFrame(frame);
            if (read.ok) {
              for (const item of read.items) {
                received.push(item);
              }
            }
          },
          FireAllClients: () => {},
        },
        { batching: false },
      ),
    );
    const player = createTestPlayer({ userId: 9 });
    for (let toggle = 0; toggle < 10; toggle += 1) {
      host.receive(player, { t: WIRE_ITEM_RESOURCE_SUBSCRIPTION, r: slow.id, o: 1 });
      host.receive(player, { t: WIRE_ITEM_RESOURCE_SUBSCRIPTION, r: slow.id, o: 0 });
    }
    expect(pending.size()).toBe(1);

    // Subscribed again at the end: the running load answers it.
    host.receive(player, { t: WIRE_ITEM_RESOURCE_SUBSCRIPTION, r: slow.id, o: 1 });
    expect(pending.size()).toBe(1);
    pending[0]!({ quest: "intro", step: 2 });
    expect(received.size()).toBe(1);
    expect(host.isSubscribed(slow.id, player)).toBe(true);

    // Unsubscribed while nothing runs: the key goes, and the next subscribe loads.
    host.receive(player, { t: WIRE_ITEM_RESOURCE_SUBSCRIPTION, r: slow.id, o: 0 });
    host.receive(player, { t: WIRE_ITEM_RESOURCE_SUBSCRIPTION, r: slow.id, o: 1 });
    expect(pending.size()).toBe(2);
    host.dispose();
  });

  it("drops a key whose last subscriber left while its load ran, once the load lands", () => {
    const pending = new Array<(value: Progress) => void>();
    const slow = defineResource({
      id: "quests.abandoned",
      schema: progressSchema,
      load() {
        return new Promise<Progress>((resolve) => {
          pending.push(resolve);
        });
      },
    });
    const host = createResourceHost<Player>({ [slow.id]: slow });
    let sent = 0;
    host.attach(createServerChannel<Player>({ FireClient: () => (sent += 1), FireAllClients: () => {} }, { batching: false }));
    const player = createTestPlayer({ userId: 9 });
    host.receive(player, { t: WIRE_ITEM_RESOURCE_SUBSCRIPTION, r: slow.id, o: 1 });
    host.receive(player, { t: WIRE_ITEM_RESOURCE_SUBSCRIPTION, r: slow.id, o: 0 });
    host.invalidate(slow.id, player);
    pending[0]!({ quest: "intro", step: 1 });
    // Nothing sent, and the invalidation's follow-up does not run for nobody.
    expect(sent).toBe(0);
    expect(pending.size()).toBe(1);
    // The key is gone: a new subscription loads fresh.
    host.receive(player, { t: WIRE_ITEM_RESOURCE_SUBSCRIPTION, r: slow.id, o: 1 });
    expect(pending.size()).toBe(2);
    host.dispose();
  });

  it("frees a global key when a load that bounds itself rejects", () => {
    const loads = new Array<{ resolve: (value: Progress) => void; reject: (reason: unknown) => void }>();
    const board = defineResource({
      id: "arena.bounded",
      scope: "global",
      schema: progressSchema,
      load() {
        return new Promise<Progress>((resolve, reject) => {
          loads.push({ resolve, reject });
        });
      },
    });
    const harness = createTestServerApp({ actions: {}, resources: { [board.id]: board } });
    const first = createTestPlayer({ userId: 1 });
    const second = createTestPlayer({ userId: 2 });
    harness.join(first);
    harness.join(second);
    const early = harness.client(first).resources!.subscribe("arena.bounded");
    const late = harness.client(second).resources!.subscribe("arena.bounded");
    // The second subscriber joined the running load instead of starting one.
    expect(loads.size()).toBe(1);
    expect(late.status()).toBe("loading");

    loads[0]!.reject("timed out");
    expect(early.status()).toBe("error");
    expect(late.status()).toBe("error");

    harness.app.resources!.invalidate("arena.bounded");
    expect(loads.size()).toBe(2);
    loads[1]!.resolve({ quest: "intro", step: 4 });
    expect(early.status()).toBe("ready");
    expect(late.status()).toBe("ready");
    harness.dispose();
  });

  it("answers a returning subscriber of a global resource from its cache, past a revision it already saw", () => {
    let allowed = false;
    let loads = 0;
    const board = defineResource({
      id: "encounter.board",
      scope: "global",
      schema: schema.object({ health: schema.u16() }),
      load() {
        loads += 1;
        return { health: 70 };
      },
      authorize: () => allowed,
    });
    const harness = createTestServerApp({ actions: {}, resources: { [board.id]: board } });
    const holder = createTestPlayer({ userId: 1 });
    const player = createTestPlayer({ userId: 2 });
    harness.join(holder);
    harness.join(player);
    allowed = true;
    harness.client(holder).resources!.subscribe("encounter.board");
    // One client throughout: `harness.client` builds a new one per call, and
    // the point is a client that remembers revisions.
    const resources = harness.client(player).resources!;

    // Refused first: the Forbidden answer raises this client's floor above the
    // cached value's revision.
    allowed = false;
    const refused = resources.subscribe("encounter.board");
    expect(refused.status()).toBe("error");
    refused.disconnect();
    allowed = true;
    const granted = resources.subscribe("encounter.board");
    expect(granted.status()).toBe("ready");
    expect(granted.get()).toEqual({ health: 70 });

    // Unsubscribing and coming back is answered from the same cache.
    granted.disconnect();
    const again = resources.subscribe("encounter.board");
    expect(again.status()).toBe("ready");
    expect(loads).toBe(1);
    harness.dispose();
  });

  it("follows a global load that read stale state with another, when it was invalidated with nobody subscribed", () => {
    let health = 100;
    const pending = new Array<() => void>();
    const boss = defineResource({
      id: "encounter.slowboss",
      scope: "global",
      schema: schema.object({ health: schema.u16() }),
      load() {
        const read = health;
        return new Promise<{ health: number }>((resolve) => {
          pending.push(() => resolve({ health: read }));
        });
      },
    });
    const harness = createTestServerApp({ actions: {}, resources: { [boss.id]: boss } });
    const first = createTestPlayer({ userId: 1 });
    const second = createTestPlayer({ userId: 2 });
    harness.join(first);
    harness.join(second);
    harness.client(first).resources!.subscribe("encounter.slowboss").disconnect();
    health = 10;
    harness.app.resources!.invalidate(boss);
    const late = harness.client(second).resources!.subscribe("encounter.slowboss");
    pending[0]!();
    expect(late.get()).toEqual({ health: 100 });
    expect(pending.size()).toBe(2);
    pending[1]!();
    expect(late.get()).toEqual({ health: 10 });
    harness.dispose();
  });

  it("frees the key when onResourceError or a schema refinement throws", () => {
    let loads = 0;
    let throwInLoad = true;
    const flaky = defineResource({
      id: "quests.flaky",
      schema: schema.object({
        step: schema.number().refine((value) => {
          if (value === 13) {
            throw "refinement exploded";
          }
          return true;
        }, "expected a lucky step"),
      }),
      load() {
        loads += 1;
        if (throwInLoad) {
          throw "load exploded";
        }
        return { step: 13 };
      },
    });
    const harness = createTestServerApp({
      actions: {},
      resources: { [flaky.id]: flaky },
      onResourceError: () => {
        throw "handler exploded";
      },
    });
    const player = createTestPlayer();
    harness.join(player);
    const errors = new Array<string>();
    const subscription = harness.client(player).resources!.subscribe("quests.flaky", undefined, {
      onError: (name) => errors.push(name),
    });
    expect(errors).toEqual(["ResourceLoadError"]);

    throwInLoad = false;
    harness.app.resources!.invalidate(flaky, player);
    expect(loads).toBe(2);
    expect(errors).toEqual(["ResourceLoadError", "ResourceLoadError"]);
    harness.app.resources!.invalidate(flaky, player);
    expect(loads).toBe(3);
    expect(subscription.status()).toBe("error");
    harness.dispose();
  });

  it("ends a subscription whose resync is no longer authorized", () => {
    const world = questWorld();
    let allowed = true;
    const guarded = defineResource({
      id: "quests.guarded",
      schema: progressSchema,
      load(ctx) {
        return world.progress.load(ctx);
      },
      authorize: () => allowed,
    });
    const harness = createTestServerApp({ actions: {}, resources: { [guarded.id]: guarded } });
    const player = createTestPlayer({ userId: 4 });
    harness.join(player);
    const subscription = harness.client(player).resources!.subscribe("quests.guarded");
    expect(subscription.status()).toBe("ready");
    allowed = false;
    subscription.refresh();
    expect(subscription.error()).toBe("ResourceForbiddenError");
    expect(harness.app.resources!.isSubscribed("quests.guarded", player)).toBe(false);
    harness.app.resources!.invalidate(guarded, player);
    expect(world.loadsOf(player)).toBe(1);
    harness.dispose();
  });

  it("unsubscribes everything when the client is disposed", () => {
    const world = questWorld();
    const harness = createTestServerApp({ actions: {}, resources: { [world.progress.id]: world.progress } });
    const player = createTestPlayer({ userId: 5 });
    harness.join(player);
    const client = harness.client(player).resources!;
    client.subscribe("quests.progress");
    expect(harness.app.resources!.isSubscribed("quests.progress", player)).toBe(true);
    client.dispose();
    expect(harness.app.resources!.isSubscribed("quests.progress", player)).toBe(false);
    harness.dispose();
  });
});
