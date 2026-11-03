// The public subpaths wired together the way a game uses them: a client app whose
// transport dispatches into a server app, the schema builders, and the Roblox
// remote helpers. Ported from packages/aruna/test/public-exports.test.ts, which
// exercised the same contract through the (now retired) Node runtime.
import { createClientApp, createNetworkMetrics, invokeAction } from "aruna/client";
import { clearActionInvoker } from "aruna/internal/client-runtime";
import {
  bindActions,
  createActionInvoker,
  defineAction as defineActionRoblox,
  robloxRemoteEvent,
} from "aruna/roblox";
import { REMOTE_NAME, SIGNAL_UNRELIABLE_REMOTE_NAME } from "aruna/internal/roblox-constants";
import { decodeBinary, encodeBinary, schema } from "aruna/schema";
import { schemaFingerprint } from "aruna/internal/binary";
import { createServerApp, defineAction } from "aruna/server";
import { afterEach, describe, expect, it } from "aruna/testing";

const player = { Name: "Ada", UserId: 1 } as unknown as Player;

describe("public exports", () => {
  afterEach(() => {
    clearActionInvoker();
  });

  it("lets a client collect its own round trips from aruna/client alone", async () => {
    const actions = {
      "debug.ping": defineAction({
        id: "debug.ping",
        run() {
          return "pong";
        },
      }),
    };
    const serverApp = createServerApp({ actions });
    const metrics = createNetworkMetrics();
    createClientApp({
      transport: (actionId, input) => serverApp.dispatch(actionId, { player }, input),
      middleware: [metrics.clientMiddleware()],
    });
    expect(await invokeAction("debug.ping")).toBe("pong");
    expect(metrics.report().actions["debug.ping"]?.client.samples).toBe(1);
  });

  it("keeps the stable entrypoints wired together", async () => {
    const actions = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run(_ctx, input) {
          return { input };
        },
      }),
    };

    const serverApp = createServerApp({ actions });
    const clientApp = createClientApp({
      transport: (actionId, input) => serverApp.dispatch(actionId, { player }, input),
    });

    expect(await invokeAction("shop.purchaseItem", { itemId: "sword" })).toEqual({
      input: { itemId: "sword" },
    });
    expect(await serverApp.dispatch("shop.purchaseItem", { player }, { itemId: "shield" })).toEqual(
      {
        input: { itemId: "shield" },
      },
    );

    expect(schema.string().typeName).toBe("string");
    expect(schema.boolean().typeName).toBe("boolean");
    expect(
      defineActionRoblox({
        id: "shop.purchaseItem",
        run() {
          return undefined;
        },
      }).id,
    ).toBe("shop.purchaseItem");

    clientApp.dispose();
    serverApp.dispose();
  });

  it("exposes the binary codec from aruna/schema", () => {
    // It used to be exported from the root `aruna` entry, as a Node codec.
    const hit = schema.object({ amount: schema.u16(), crit: schema.boolean() });
    const frame = encodeBinary(hit, { amount: 1200, crit: true });
    expect(buffer.len(frame)).toBe(7);
    expect(buffer.readu32(frame, 0)).toBe(schemaFingerprint(hit));
    expect(decodeBinary(hit, frame)).toEqual({ amount: 1200, crit: true });
  });

  it("exposes the default Roblox action remote helpers", () => {
    // The remote names are internal constants, but a game sees them in the
    // DataModel, so they must not change by accident.
    expect(REMOTE_NAME).toBe("ArunaRemoteEvent");
    expect(SIGNAL_UNRELIABLE_REMOTE_NAME).toBe("ArunaSignalUnreliableRemoteEvent");
    expect(typeIs(robloxRemoteEvent, "function")).toBe(true);
    expect(typeIs(createActionInvoker, "function")).toBe(true);
    expect(typeIs(bindActions, "function")).toBe(true);
  });
});
