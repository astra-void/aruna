// `createVideBindings` against the real Vide, loaded under Lune the way a game
// loads it: through the `aruna test` loader's init modules and string requires.
import Vide from "@rbxts/vide";
import type { ActionInvokeOptions } from "aruna/client";
import { describe, expect, it } from "aruna/testing";
import { createVideBindings, type ActionSources, type ResourceSources } from "aruna/ui";
import { waitUntil } from "./support";
import { controlledStub, questWorld, type Progress } from "./ui-support";

// Passing Vide's own functions is also the type check: they must fit.
const { resourceState, actionState } = createVideBindings({
  source: Vide.source,
  cleanup: Vide.cleanup,
  batch: Vide.batch,
});

describe("aruna/ui: Vide bindings", () => {
  // Run counts are compared, never fixed: Vide's strict mode, on by default
  // outside -O2 builds (Studio, and Lune here), runs every update twice.
  it("follows a resource through accessors, writing only the fields that changed", async () => {
    const world = questWorld();
    const steps = new Array<number>();
    let valueRuns = 0;
    let statusRuns = 0;
    const [destroy] = Vide.root(() => {
      const quest = resourceState(world.binding);
      Vide.effect(() => {
        const progress = quest.value();
        valueRuns += 1;
        if (progress !== undefined) {
          steps.push(progress.step);
        }
      });
      Vide.effect(() => {
        quest.status();
        statusRuns += 1;
      });
    });
    expect(steps[steps.size() - 1]).toBe(0);

    // A new value with the status unchanged: what reads `status` stays put.
    const statusRunsBeforeAdvance = statusRuns;
    await world.advance();
    expect(steps[steps.size() - 1]).toBe(1);
    expect(statusRuns).toBe(statusRunsBeforeAdvance);

    // An error changes the status and keeps the value: what reads `value`
    // stays put.
    const valueRunsBeforeError = valueRuns;
    world.fail(true);
    await world.advance();
    expect(statusRuns > statusRunsBeforeAdvance).toBe(true);
    expect(valueRuns).toBe(valueRunsBeforeError);

    destroy();
    await waitUntil(() => !world.subscribed());
    expect(world.subscribed()).toBe(false);
    world.harness.dispose();
  });

  it("throws outside a scope and holds nothing", async () => {
    const world = questWorld();
    expect(() => resourceState(world.binding)).toThrow("cannot cleanup outside a stable or reactive scope");
    await waitUntil(() => false, 2);
    expect(world.subscribed()).toBe(false);
    expect(world.loads()).toBe(0);
    world.harness.dispose();
  });

  it("lives as a module-level store in a root that is never destroyed", () => {
    // The form docs/rfcs/ui-bindings.md gives for a store outside any component.
    const world = questWorld();
    const [, walletState] = Vide.root(() => resourceState(world.binding));
    expect(walletState.status()).toBe("ready");
    expect(walletState.value()!.step).toBe(0);
    world.harness.dispose();
  });

  it("keeps the subscription when one scope ends as the next begins", async () => {
    // What a Show or Switch branch swap does: the old branch's scope is
    // destroyed and the new one created in the same update.
    const world = questWorld();
    const [destroyFirst] = Vide.root(() => {
      resourceState(world.binding);
    });
    destroyFirst();
    const [destroySecond] = Vide.root(() => {
      resourceState(world.binding);
    });
    await waitUntil(() => false, 2);
    expect(world.subscribed()).toBe(true);
    expect(world.loads()).toBe(1);
    destroySecond();
    await waitUntil(() => !world.subscribed());
    expect(world.subscribed()).toBe(false);
    world.harness.dispose();
  });

  it("follows a call through accessors and writes nothing once the scope is gone", async () => {
    const control = controlledStub();
    const statuses = new Array<string>();
    let purchase: ActionSources<typeof control.stub> | undefined;
    const [destroy] = Vide.root(() => {
      const state = actionState(control.stub);
      purchase = state;
      Vide.effect(() => {
        // Each status once, however many times strict mode runs the update.
        const status = state.status();
        if (statuses[statuses.size() - 1] !== status) {
          statuses.push(status);
        }
      });
    });
    purchase!.invoke(1);
    control.resolve(0, 10);
    await waitUntil(() => purchase!.status() === "success");
    expect(statuses).toEqual(["idle", "pending", "success"]);
    expect(purchase!.data()).toBe(10);

    purchase!.invoke(2);
    destroy();
    control.resolve(1, 20);
    await waitUntil(() => false, 2);
    expect(purchase!.status()).toBe("pending");
    expect(purchase!.data()).toBeUndefined();
  });

  it("shows a call's optimistic update through the accessors, applied once", async () => {
    const world = questWorld();
    const advanceStub = (_input?: undefined, options?: ActionInvokeOptions) =>
      world.client.invoke("quests.advance", undefined, options) as Promise<number>;
    const steps = new Array<number>();
    let quest: ResourceSources<Progress> | undefined;
    let advance: ActionSources<typeof advanceStub> | undefined;
    const [destroy] = Vide.root(() => {
      const progress = resourceState(world.binding);
      quest = progress;
      advance = actionState(advanceStub, {
        optimistic: (_input, update) => update(world.binding, (current) => ({ step: current.step + 1 })),
      });
      Vide.effect(() => {
        const value = progress.value();
        if (value !== undefined && steps[steps.size() - 1] !== value.step) {
          steps.push(value.step);
        }
      });
    });
    advance!.invoke();
    await waitUntil(() => advance!.status() === "success");
    expect(steps).toEqual([0, 1]);
    expect(quest!.pending()).toBe(false);
    destroy();
    world.harness.dispose();
  });

  it("sends a call twice from a strict-mode effect, and once with exclusive", () => {
    // Documented, not prevented: call `invoke` from event handlers. Strict mode
    // is Vide's default in Studio, so this is what a game sees there.
    const strictByDefault = Vide.strict;
    const control = controlledStub();
    const trigger = Vide.source(0);
    const [destroy] = Vide.root(() => {
      const plain = actionState(control.stub);
      const guarded = actionState(control.stub, { exclusive: true });
      Vide.effect(() => {
        if (trigger() === 1) {
          plain.invoke(1);
        } else if (trigger() === 2) {
          guarded.invoke(2);
        }
      });
    });
    Vide.strict = true;
    trigger(1);
    trigger(2);
    Vide.strict = strictByDefault;
    expect(control.inputs).toEqual([1, 1, 2]);
    destroy();
  });
});
