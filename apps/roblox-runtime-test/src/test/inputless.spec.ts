// Inputless actions: a stub generated for an action with no input schema takes
// `input?`, so `ready()` and `ready(undefined)` are the same call. Both reach the
// server as a call with no `d` field, and an action whose input is required still
// refuses a missing one.
import { createRemoteActionInvoker, defineAction } from "aruna/roblox";
import { schema } from "aruna/schema";
import { createTestPlayer, createTestServerApp, describe, expect, it } from "aruna/testing";
import { createClientChannel, readWireFrame, WIRE_ITEM_CALL, type WireFrame } from "aruna/internal/wire";
import { rejectionOf } from "./support";

function lobbyActions(seen: Array<{ input: unknown }>) {
  return {
    "lobby.ready": defineAction({
      id: "lobby.ready",
      run(_ctx, input) {
        seen.push({ input });
        return true;
      },
    }),
    "lobby.join": defineAction({
      id: "lobby.join",
      input: schema.object({ room: schema.string().maxLength(16) }),
      run(_ctx, input) {
        return input.room;
      },
    }),
  };
}

describe("inputless actions", () => {
  it("runs the same call whether the input is omitted or undefined", async () => {
    const seen = new Array<{ input: unknown }>();
    const harness = createTestServerApp({ actions: lobbyActions(seen) });
    const player = createTestPlayer();
    harness.join(player);
    const client = harness.client(player);

    expect(await client.invoke("lobby.ready")).toBe(true);
    expect(await client.invoke("lobby.ready", undefined)).toBe(true);
    expect(await harness.invoke(player, "lobby.ready")).toBe(true);
    expect(seen.size()).toBe(3);
    for (const call of seen) {
      expect(call.input).toBe(undefined);
    }
    harness.dispose();
  });

  it("sends a call with no input as an item with no payload field", () => {
    const frames = new Array<WireFrame>();
    const channel = createClientChannel(
      { OnClientEvent: { Connect: () => ({ Disconnect: () => {} }) } },
      "inputless",
    );
    const invoke = createRemoteActionInvoker(
      {
        FireServer: (frame) => {
          frames.push(frame);
        },
      },
      channel,
      { batching: false, requestTimeoutMs: 0 },
    );

    void invoke("lobby.ready", undefined);
    expect(frames.size()).toBe(1);
    const read = readWireFrame(frames[0]);
    expect(read.ok).toBe(true);
    if (read.ok) {
      const item = read.items[0] as { readonly t: number; readonly a: string; readonly d?: unknown };
      expect(item.t).toBe(WIRE_ITEM_CALL);
      expect(item.a).toBe("lobby.ready");
      expect(item.d).toBe(undefined);
    }
    channel.dispose();
  });

  it("still refuses a missing input when the action requires one", async () => {
    const harness = createTestServerApp({ actions: lobbyActions([]) });
    const player = createTestPlayer();
    harness.join(player);

    const rejection = (await rejectionOf(harness.client(player).invoke("lobby.join"))) as {
      readonly name?: string;
    };
    expect(rejection.name).toBe("ActionValidationError");
    harness.dispose();
  });
});
