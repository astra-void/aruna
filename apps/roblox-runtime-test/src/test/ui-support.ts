// The world the `aruna/ui` specs share: a server app with a player-scoped
// resource and an action that changes it, the joined player, and the client
// app whose resource client the bindings subscribe through. Not a spec itself.
import { resourceBinding } from "aruna/client";
import { defineAction, defineResource } from "aruna/roblox";
import { schema } from "aruna/schema";
import { createTestPlayer, createTestServerApp } from "aruna/testing";

export type Progress = { readonly step: number };

export function questWorld() {
  let step = 0;
  let loads = 0;
  let failing = false;
  const progress = defineResource({
    id: "quests.progress",
    schema: schema.object({ step: schema.u16() }),
    load() {
      loads += 1;
      if (failing) {
        throw "the quest store is down";
      }
      return { step };
    },
  });
  const advance = defineAction({
    id: "quests.advance",
    run(ctx) {
      step += 1;
      ctx.resources?.invalidate(progress);
      return step;
    },
  });
  const harness = createTestServerApp({
    actions: { "quests.advance": advance },
    resources: { [progress.id]: progress },
  });
  const player = createTestPlayer({ userId: 1 });
  harness.join(player);
  const client = harness.client(player);
  return {
    harness,
    client,
    binding: resourceBinding<Progress>("quests.progress"),
    loads: () => loads,
    fail: (on: boolean) => {
      failing = on;
    },
    advance: () => client.invoke("quests.advance"),
    subscribed: () => harness.app.resources!.isSubscribed("quests.progress", player),
  };
}

// A stub whose calls settle when the spec says so.
export function controlledStub() {
  const settlers = new Array<{ readonly resolve: (value: number) => void; readonly reject: (reason: unknown) => void }>();
  // Inputs as called; an omitted one is 0 (a Luau array cannot hold nil).
  const inputs = new Array<number>();
  const stub = (input?: number) => {
    inputs.push(input ?? 0);
    return new Promise<number>((resolve, reject) => {
      settlers.push({ resolve, reject });
    });
  };
  return {
    stub,
    inputs,
    calls: () => settlers.size(),
    resolve: (call: number, value: number) => settlers[call]!.resolve(value),
    reject: (call: number, reason: unknown) => settlers[call]!.reject(reason),
  };
}
