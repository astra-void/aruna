// Regression coverage for the createServerApp <-> transport binding seam: a
// config-level `defaultRateLimit` must reach the RemoteEvent dispatch path even
// when no per-action `rateLimit` is declared. Port of
// packages/aruna/test/default-rate-limit-app.test.ts: the Node suite wired a
// structural fake remote; here the real action RemoteEvent carries every call,
// from `createActionInvoker` through `robloxRemoteEvent()` and back.
import { defineAction, createActionInvoker, robloxRemoteEvent } from "aruna/roblox";
import { createServerApp, type ActionMap } from "aruna/server";
import { createClientApp, invokeAction } from "aruna/client";
import { clearActionInvoker } from "aruna/internal/client-runtime";
import { afterEach, describe, expect, it } from "aruna/testing";
import { rejectionOf } from "./support";

let actionCounter = 0;
function uniqueActionId(): string {
  actionCounter += 1;
  return `regression.defaultRateLimit.${actionCounter}`;
}

function pingRegistry(actionId: string): ActionMap<Player> {
  return {
    [actionId]: defineAction({
      id: actionId,
      run() {
        return "pong";
      },
    }),
  };
}

describe("createServerApp defaultRateLimit reaches the RemoteEvent dispatch path", () => {
  afterEach(() => {
    clearActionInvoker();
  });

  it("blocks an action that only inherits the app-wide defaultRateLimit", async () => {
    const actionId = uniqueActionId();
    const actions = pingRegistry(actionId);

    const serverApp = createServerApp({
      actions,
      defaultRateLimit: { key: "player", windowMs: 60_000, max: 1 },
      // A fixed window is aligned to the clock: on the real one, two calls can
      // straddle a boundary and both pass. Frozen, they share one window.
      nowMs: () => 1_000,
      transport: robloxRemoteEvent(),
    });
    const clientApp = createClientApp({ transport: createActionInvoker() });

    expect(await invokeAction(actionId, {})).toBe("pong");
    const refused = await rejectionOf(invokeAction(actionId, {}));
    expect(refused.message).toContain("rate limited");

    clientApp.dispose();
    serverApp.dispose();
  });

  it("blocks via the owned `transport` API and recovers after the window", async () => {
    const actionId = uniqueActionId();
    const actions = pingRegistry(actionId);

    let clock = 0;
    const serverApp = createServerApp({
      actions,
      defaultRateLimit: { key: "player", windowMs: 1_000, max: 2 },
      nowMs: () => clock,
      transport: robloxRemoteEvent(),
    });
    const clientApp = createClientApp({ transport: createActionInvoker() });

    expect(await invokeAction(actionId, {})).toBe("pong");
    expect(await invokeAction(actionId, {})).toBe("pong");
    const refused = await rejectionOf(invokeAction(actionId, {}));
    expect(refused.message).toContain("rate limited");

    // Advance past the window: the bucket resets and the action flows again.
    clock = 1_000;
    expect(await invokeAction(actionId, {})).toBe("pong");

    clientApp.dispose();
    serverApp.dispose();
  });

  it("accepts the first `max` calls and rejects the rest under the owned transport", async () => {
    const actionId = uniqueActionId();
    const actions = pingRegistry(actionId);
    const clock = 0;
    const serverApp = createServerApp({
      actions,
      defaultRateLimit: { key: "player", windowMs: 1_000, max: 2 },
      nowMs: () => clock,
      transport: robloxRemoteEvent(),
    });
    const clientApp = createClientApp({ transport: createActionInvoker() });

    const accepted = new Array<boolean>();
    for (let i = 0; i < 4; i += 1) {
      accepted.push(
        await invokeAction(actionId, {}).then(
          () => true,
          () => false,
        ),
      );
    }

    expect(accepted).toEqual([true, true, false, false]);

    clientApp.dispose();
    serverApp.dispose();
  });

  it("exposes robloxRemoteEvent() as a transport factory", () => {
    // Calling the factory only builds the closure; it does not touch the
    // RemoteEvent (that happens when the returned transport is invoked).
    expect(typeIs(robloxRemoteEvent, "function")).toBe(true);
    expect(typeIs(robloxRemoteEvent(), "function")).toBe(true);
  });
});
