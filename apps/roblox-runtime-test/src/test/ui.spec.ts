// The renderer-agnostic core of `aruna/ui` (docs/rfcs/ui-bindings.md): one
// shared, retained subscription behind every reader of a resource, immutable
// views of it, and the state of the calls one component makes.
import { describe, expect, it } from "aruna/testing";
import { observeAction, observeResource, peekResource } from "aruna/ui";
import { waitUntil } from "./support";
import { controlledStub, questWorld } from "./ui-support";

describe("aruna/ui: observeResource", () => {
  it("shares one subscription and one view between readers", () => {
    const world = questWorld();
    const first = observeResource(world.binding);
    const second = observeResource(world.binding);
    expect(world.loads()).toBe(1);
    expect(first.current()).toBe(second.current());
    expect(first.current().status).toBe("ready");
    expect(first.current().value!.step).toBe(0);
    first.release();
    second.release();
    world.harness.dispose();
  });

  it("replaces the view on a change and keeps it otherwise", async () => {
    const world = questWorld();
    const observation = observeResource(world.binding);
    const before = observation.current();
    let changes = 0;
    observation.onChange(() => {
      changes += 1;
    });
    expect(observation.current()).toBe(before);
    await world.advance();
    const after = observation.current();
    expect(after).not.toBe(before);
    expect(after.value!.step).toBe(1);
    expect(after.serverValue).toBe(after.value);
    expect(after.revision > before.revision).toBe(true);
    expect(changes).toBe(1);
    observation.release();
    world.harness.dispose();
  });

  it("keeps the last value when a load fails", async () => {
    const world = questWorld();
    const observation = observeResource(world.binding);
    world.fail(true);
    await world.advance();
    expect(observation.current().status).toBe("error");
    expect(observation.current().error).toBe("ResourceLoadError");
    expect(observation.current().value!.step).toBe(0);
    observation.release();
    world.harness.dispose();
  });

  it("starts a late reader on the error, not on the next error item", async () => {
    // The resource is already in error through a subscriber outside the core,
    // so the core's first view comes from that subscription's state.
    const world = questWorld();
    const direct = world.client.resources!.subscribe("quests.progress");
    world.fail(true);
    await world.advance();
    const late = observeResource(world.binding);
    expect(late.current().status).toBe("error");
    expect(late.current().error).toBe("ResourceLoadError");
    late.release();
    direct.disconnect();
    world.harness.dispose();
  });

  it("keeps the subscription across a release and a new reader in one cycle", async () => {
    const world = questWorld();
    const first = observeResource(world.binding);
    first.release();
    const second = observeResource(world.binding);
    await waitUntil(() => false, 2);
    expect(world.subscribed()).toBe(true);
    expect(world.loads()).toBe(1);
    second.release();
    await waitUntil(() => !world.subscribed());
    expect(world.subscribed()).toBe(false);
    world.harness.dispose();
  });

  it("holds the subscription for keepAliveMs after the last reader", async () => {
    const world = questWorld();
    observeResource(world.binding, { keepAliveMs: 100 }).release();
    await waitUntil(() => false, 2);
    expect(world.subscribed()).toBe(true);
    await waitUntil(() => !world.subscribed(), 5000);
    expect(world.subscribed()).toBe(false);
    world.harness.dispose();
  });

  it("peeks without holding anything", () => {
    const world = questWorld();
    expect(peekResource(world.binding).status).toBe("loading");
    expect(world.subscribed()).toBe(false);
    const observation = observeResource(world.binding);
    expect(peekResource(world.binding)).toBe(observation.current());
    observation.release();
    world.harness.dispose();
  });

  it("starts over through a replaced client app", () => {
    const stale = questWorld();
    const old = observeResource(stale.binding);
    stale.harness.dispose();
    const world = questWorld();
    const fresh = observeResource(world.binding);
    expect(world.loads()).toBe(1);
    expect(fresh.current().status).toBe("ready");
    old.release();
    fresh.release();
    world.harness.dispose();
  });
});

describe("aruna/ui: observeAction", () => {
  it("reports pending, then success, and the latest call wins", async () => {
    const control = controlledStub();
    const action = observeAction(control.stub);
    expect(action.current().status).toBe("idle");
    action.invoke(1);
    expect(action.current().status).toBe("pending");
    action.invoke(2);
    control.resolve(1, 20);
    await waitUntil(() => action.current().status === "success");
    expect(action.current().data).toBe(20);
    control.resolve(0, 10);
    await waitUntil(() => false, 2);
    expect(action.current().data).toBe(20);
  });

  it("drops a repeat while a call is pending when exclusive", () => {
    const control = controlledStub();
    const action = observeAction(control.stub, { exclusive: true });
    const first = action.invokeAsync(1);
    const second = action.invokeAsync(2);
    action.invoke(3);
    expect(second).toBe(first);
    expect(control.calls()).toBe(1);
  });

  it("runs the callbacks for every call that settles", async () => {
    const control = controlledStub();
    const seen = new Array<string>();
    const action = observeAction(control.stub, {
      onSuccess: (data, input) => seen.push(`ok ${input} ${data}`),
      onError: (_reason, input) => seen.push(`failed ${input}`),
    });
    action.invoke(1);
    action.invoke(2);
    control.resolve(0, 10);
    control.reject(1, "sold out");
    await waitUntil(() => seen.size() === 2);
    expect(seen).toEqual(["ok 1 10", "failed 2"]);
    expect(action.current().status).toBe("error");
    expect(action.current().error).toBe("sold out");
  });

  it("writes nothing and runs no callback after dispose, without cancelling the call", async () => {
    const control = controlledStub();
    const seen = new Array<number>();
    const action = observeAction(control.stub, { onSuccess: (data) => seen.push(data) });
    action.invoke(1);
    action.dispose();
    control.resolve(0, 10);
    await waitUntil(() => false, 2);
    expect(action.current().status).toBe("pending");
    expect(seen).toEqual([]);
    action.invoke(2);
    expect(control.calls()).toBe(1);
    await expect(action.invokeAsync(2)).rejects.toThrow("disposed");
  });

  it("forgets a running call on reset", async () => {
    const control = controlledStub();
    const action = observeAction(control.stub);
    action.invoke(1);
    action.reset();
    expect(action.current().status).toBe("idle");
    control.resolve(0, 10);
    await waitUntil(() => false, 2);
    expect(action.current().status).toBe("idle");
  });

  it("turns a stub that throws into a rejection", async () => {
    const throwing = (_input?: number): Promise<number> => {
      throw "no invoker installed";
    };
    const action = observeAction(throwing);
    action.invoke();
    await waitUntil(() => action.current().status === "error");
    expect(action.current().status).toBe("error");
  });
});
