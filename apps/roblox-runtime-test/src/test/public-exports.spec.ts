// The public subpaths wired together the way a game uses them: a client app whose
// transport dispatches into a server app, the schema builders, and the Roblox
// remote helpers. Ported from packages/aruna/test/public-exports.test.ts, which
// exercised the same contract through the (now retired) Node runtime.
import { clearActionInvoker, createClientApp, invokeAction } from "aruna/client";
import {
  REMOTE_NAME,
  SIGNAL_UNRELIABLE_REMOTE_NAME,
  bindActions,
  createActionInvoker,
  defineAction as defineActionRoblox,
  robloxRemoteEvent,
} from "aruna/roblox";
import { decodeBinary, encodeBinary, schema, schemaFingerprint } from "aruna/schema";
import { createServerApp, defineAction } from "aruna/server";
import { afterEach, describe, expect, it } from "aruna/testing";

const player = { Name: "Ada", UserId: 1 } as unknown as Player;

describe("public exports", () => {
  afterEach(() => {
    clearActionInvoker();
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
    expect(REMOTE_NAME).toBe("ArunaRemoteEvent");
    expect(SIGNAL_UNRELIABLE_REMOTE_NAME).toBe("ArunaSignalUnreliableRemoteEvent");
    expect(typeIs(robloxRemoteEvent, "function")).toBe(true);
    expect(typeIs(createActionInvoker, "function")).toBe(true);
    expect(typeIs(bindActions, "function")).toBe(true);
  });
});
