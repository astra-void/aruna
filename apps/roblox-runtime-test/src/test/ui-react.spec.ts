// `createReactBindings` over a one-component stand-in for React: hooks are slots
// in call order, effects run after a render, and a state change marks the
// component for another render. react-lua itself is not loaded; the real
// `@rbxts/react` declarations are checked against the hooks the bindings take.
import type React from "@rbxts/react";
import { describe, expect, it } from "aruna/testing";
import { createReactBindings, type ActionState, type ReactHooks, type ResourceView } from "aruna/ui";
import { waitUntil } from "./support";
import { controlledStub, questWorld, type Progress } from "./ui-support";

// Fails to compile, rather than to run, when @rbxts/react's hooks stop fitting.
type ReactFits = typeof React extends ReactHooks ? true : false;

interface Slot {
  value: unknown;
  deps: ReadonlyArray<unknown> | undefined;
  cleanup: (() => void) | undefined;
}

function fakeReact() {
  const slots = new Map<number, Slot>();
  let cursor = 0;
  let effects = new Array<() => void>();
  let dirty = false;

  const depsChanged = (before: ReadonlyArray<unknown> | undefined, after: ReadonlyArray<unknown> | undefined) => {
    if (before === undefined || after === undefined || before.size() !== after.size()) {
      return true;
    }
    for (let index = 0; index < after.size(); index += 1) {
      if (before[index] !== after[index]) {
        return true;
      }
    }
    return false;
  };

  const hooks: ReactHooks = {
    useState: <S>(initialState: S | (() => S)) => {
      const index = cursor;
      cursor += 1;
      let slot = slots.get(index);
      if (slot === undefined) {
        const value = typeIs(initialState, "function") ? (initialState as () => S)() : initialState;
        slot = { value, deps: undefined, cleanup: undefined };
        slots.set(index, slot);
      }
      const held = slot;
      return $tuple(held.value as S, (value: S) => {
        if (value !== held.value) {
          held.value = value;
          dirty = true;
        }
      });
    },
    useEffect: (effect, deps) => {
      const index = cursor;
      cursor += 1;
      const slot = slots.get(index);
      if (slot !== undefined && !depsChanged(slot.deps, deps)) {
        return;
      }
      effects.push(() => {
        if (slot !== undefined && slot.cleanup !== undefined) {
          slot.cleanup();
        }
        const cleanup = effect();
        slots.set(index, { value: undefined, deps, cleanup: typeIs(cleanup, "function") ? cleanup : undefined });
      });
    },
    useMemo: <T>(factory: () => T, deps: ReadonlyArray<unknown> | undefined) => {
      const index = cursor;
      cursor += 1;
      const slot = slots.get(index);
      if (slot !== undefined && !depsChanged(slot.deps, deps)) {
        return slot.value as T;
      }
      const value = factory();
      slots.set(index, { value, deps, cleanup: undefined });
      return value;
    },
  };

  return {
    hooks,
    // Renders until nothing is dirty, running each pass's effects after it.
    render: <T>(component: () => T): T => {
      let output: T | undefined;
      let passes = 0;
      do {
        dirty = false;
        cursor = 0;
        output = component();
        const queued = effects;
        effects = new Array();
        for (const run of queued) {
          run();
        }
        passes += 1;
      } while (dirty && passes < 20);
      return output as T;
    },
    dirty: () => dirty,
    unmount: () => {
      for (const [, slot] of slots) {
        if (slot.cleanup !== undefined) {
          slot.cleanup();
        }
      }
      slots.clear();
    },
  };
}

describe("aruna/ui: React bindings", () => {
  it("accepts @rbxts/react's own hooks", () => {
    const fits: ReactFits = true;
    expect(fits).toBe(true);
  });

  it("renders a resource from loading to ready, follows it, and releases on unmount", async () => {
    const world = questWorld();
    const react = fakeReact();
    const { useResource } = createReactBindings(react.hooks);
    const views = new Array<ResourceView<Progress>>();
    const component = () => {
      const view = useResource(world.binding);
      views.push(view);
      return view;
    };

    let view = react.render(component);
    // The first render holds nothing; the effect subscribes and re-renders.
    expect(views[0]!.status).toBe("loading");
    expect(view.status).toBe("ready");
    expect(view.value!.step).toBe(0);

    await world.advance();
    expect(react.dirty()).toBe(true);
    view = react.render(component);
    expect(view.value!.step).toBe(1);

    react.unmount();
    await waitUntil(() => !world.subscribed());
    expect(world.subscribed()).toBe(false);
    world.harness.dispose();
  });

  it("re-renders a call's state and writes nothing after unmount", async () => {
    const control = controlledStub();
    const react = fakeReact();
    const { useAction } = createReactBindings(react.hooks);
    const component = () => useAction(control.stub);

    let state: ActionState<typeof control.stub> = react.render(component);
    expect(state.status).toBe("idle");

    state.invoke(1);
    state = react.render(component);
    expect(state.status).toBe("pending");

    control.resolve(0, 10);
    await waitUntil(() => react.dirty());
    state = react.render(component);
    expect(state.status).toBe("success");
    expect(state.data).toBe(10);

    state.invoke(2);
    react.render(component);
    react.unmount();
    control.resolve(1, 20);
    await waitUntil(() => false, 2);
    expect(react.dirty()).toBe(false);
  });
});
