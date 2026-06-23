import { describe, expect, it, vi } from "vitest";
import { schema } from "../src/schema.js";
import { defineSignal } from "../src/server.js";
import {
  createRemoteSignalPublisher,
  createRemoteSignalSubscriber,
  type RemoteSignalClientLike,
  type RemoteSignalMessage,
  type RemoteSignalServerLike,
} from "../src/roblox-runtime.js";
import type { RemoteEventSignalLike } from "../src/roblox-runtime.js";

type FakeSignal<TArgs extends readonly unknown[]> = {
  readonly signal: RemoteEventSignalLike<TArgs>;
  readonly emit: (...args: TArgs) => void;
  readonly listenerCount: () => number;
};

function createFakeSignal<TArgs extends readonly unknown[]>(): FakeSignal<TArgs> {
  const listeners = new Set<(...args: TArgs) => void>();

  return {
    signal: {
      Connect(callback) {
        listeners.add(callback);
        let disconnected = false;

        return {
          Disconnect() {
            if (disconnected) {
              return;
            }

            disconnected = true;
            listeners.delete(callback);
          },
        };
      },
    },
    emit(...args) {
      for (const listener of listeners) {
        listener(...args);
      }
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

type FakeRemote<TPlayer> = RemoteSignalServerLike<TPlayer> &
  RemoteSignalClientLike & {
    readonly clientSignal: FakeSignal<[RemoteSignalMessage]>;
    readonly sent: Array<
      { readonly target: "client"; readonly player: TPlayer; readonly message: RemoteSignalMessage }
      | { readonly target: "all"; readonly message: RemoteSignalMessage }
    >;
  };

function createFakeRemote<TPlayer>(): FakeRemote<TPlayer> {
  const clientSignal = createFakeSignal<[RemoteSignalMessage]>();
  const sent: FakeRemote<TPlayer>["sent"] = [];

  return {
    clientSignal,
    sent,
    OnClientEvent: clientSignal.signal,
    FireClient(player, message) {
      sent.push({ target: "client", player, message });
      clientSignal.emit(message);
    },
    FireAllClients(message) {
      sent.push({ target: "all", message });
      clientSignal.emit(message);
    },
  };
}

const signals = {
  "combat.damaged": defineSignal({
    id: "combat.damaged",
    payload: schema.object({
      amount: schema.number(),
      source: schema.string(),
    }),
  }),
  "world.tick": defineSignal({ id: "world.tick" }),
} as const;

describe("createRemoteSignalPublisher", () => {
  it("validates and fires a payload to a single player", () => {
    const remote = createFakeRemote<{ name: string }>();
    const publisher = createRemoteSignalPublisher(remote, signals);

    publisher.to({ name: "Ada" }, "combat.damaged", { amount: 12, source: "trap" });

    expect(remote.sent).toEqual([
      {
        target: "client",
        player: { name: "Ada" },
        message: { signalId: "combat.damaged", payload: { amount: 12, source: "trap" } },
      },
    ]);
  });

  it("broadcasts to all clients", () => {
    const remote = createFakeRemote<{ name: string }>();
    const publisher = createRemoteSignalPublisher(remote, signals);

    publisher.toAll("world.tick", undefined);

    expect(remote.sent).toEqual([
      { target: "all", message: { signalId: "world.tick", payload: undefined } },
    ]);
  });

  it("fans a payload out to many players", () => {
    const remote = createFakeRemote<string>();
    const publisher = createRemoteSignalPublisher(remote, signals);

    publisher.toMany(["Ada", "Lin"], "combat.damaged", { amount: 5, source: "fall" });

    expect(remote.sent.map((entry) => entry.target)).toEqual(["client", "client"]);
  });

  it("throws on an unknown signal id", () => {
    const remote = createFakeRemote<string>();
    const publisher = createRemoteSignalPublisher(remote, signals);

    expect(() =>
      (publisher.to as (player: string, id: string, payload: unknown) => void)(
        "Ada",
        "combat.unknown",
        {},
      ),
    ).toThrowError("Aruna signal not found: combat.unknown");
  });

  it("rejects a payload that violates the schema before it reaches the wire", () => {
    const remote = createFakeRemote<string>();
    const publisher = createRemoteSignalPublisher(remote, signals);

    expect(() =>
      publisher.to("Ada", "combat.damaged", {
        amount: "lots",
        source: "trap",
      } as unknown as { amount: number; source: string }),
    ).toThrowError(/amount: expected finite number/);
    expect(remote.sent).toEqual([]);
  });

  it("rejects a non-serializable payload before it reaches the wire", () => {
    const remote = createFakeRemote<string>();
    const publisher = createRemoteSignalPublisher(remote, signals);

    expect(() =>
      publisher.to("Ada", "combat.damaged", {
        amount: 1,
        source: "trap",
        // Roblox Instance-like value smuggled past the type.
        culprit: {
          ClassName: "Player",
          IsA: () => true,
        },
      } as unknown as { amount: number; source: string }),
    ).toThrowError(/not serializable/);
    expect(remote.sent).toEqual([]);
  });
});

describe("createRemoteSignalSubscriber", () => {
  it("delivers messages to dynamic .on() subscribers", () => {
    const remote = createFakeRemote<string>();
    const subscriber = createRemoteSignalSubscriber(remote, signals);
    const received: Array<{ amount: number; source: string }> = [];

    const connection = subscriber.on("combat.damaged", (payload) => {
      received.push(payload);
    });

    remote.clientSignal.emit({
      signalId: "combat.damaged",
      payload: { amount: 7, source: "spike" },
    });

    expect(received).toEqual([{ amount: 7, source: "spike" }]);

    connection.disconnect();
    remote.clientSignal.emit({
      signalId: "combat.damaged",
      payload: { amount: 9, source: "spike" },
    });

    expect(received).toHaveLength(1);
    subscriber.dispose();
  });

  it("connects static handlers immediately", () => {
    const remote = createFakeRemote<string>();
    const handler = vi.fn();
    const subscriber = createRemoteSignalSubscriber(remote, signals, {
      handlers: {
        "combat.damaged": handler,
      },
    });

    remote.clientSignal.emit({
      signalId: "combat.damaged",
      payload: { amount: 3, source: "lava" },
    });

    expect(handler).toHaveBeenCalledWith({ amount: 3, source: "lava" });
    subscriber.dispose();
  });

  it("drops payloads that violate the declared schema", () => {
    const remote = createFakeRemote<string>();
    const handler = vi.fn();
    const subscriber = createRemoteSignalSubscriber(remote, signals);
    subscriber.on("combat.damaged", handler);

    remote.clientSignal.emit({
      signalId: "combat.damaged",
      payload: { amount: "nope", source: "lava" },
    });

    expect(handler).not.toHaveBeenCalled();
    subscriber.dispose();
  });

  it("ignores malformed envelopes and signals with no handlers", () => {
    const remote = createFakeRemote<string>();
    const handler = vi.fn();
    const subscriber = createRemoteSignalSubscriber(remote, signals);
    subscriber.on("combat.damaged", handler);

    remote.clientSignal.emit(null as unknown as RemoteSignalMessage);
    remote.clientSignal.emit({ signalId: "world.tick", payload: undefined });

    expect(handler).not.toHaveBeenCalled();
    subscriber.dispose();
  });

  it("dispose disconnects from the client signal and rejects further subscriptions", () => {
    const remote = createFakeRemote<string>();
    const subscriber = createRemoteSignalSubscriber(remote, signals);

    expect(remote.clientSignal.listenerCount()).toBe(1);

    subscriber.dispose();
    subscriber.dispose();

    expect(remote.clientSignal.listenerCount()).toBe(0);
    expect(() => subscriber.on("world.tick", () => {})).toThrowError("disposed");
  });

  it("round-trips publisher to subscriber over one remote", () => {
    const remote = createFakeRemote<string>();
    const publisher = createRemoteSignalPublisher(remote, signals);
    const subscriber = createRemoteSignalSubscriber(remote, signals);
    const received: Array<{ amount: number; source: string }> = [];

    subscriber.on("combat.damaged", (payload) => received.push(payload));
    publisher.toAll("combat.damaged", { amount: 42, source: "boss" });

    expect(received).toEqual([{ amount: 42, source: "boss" }]);
    subscriber.dispose();
  });
});
