// Port of packages/aruna/test/remote-signal-runtime.test.ts: the signal
// publisher/subscriber over structural remotes, batching, and the unreliable
// channel. The native `createRemoteSignalPublisher` / `createRemoteSignalSubscriber`
// take the same structural remote shapes as the Node runtime, so the fake remote
// below records exactly what reaches the wire.
import { defineSignal } from "aruna/server";
import { schema } from "aruna/schema";
import { describe, expect, it } from "aruna/testing";
import {
  createRemoteSignalPublisher,
  createRemoteSignalSubscriber,
  type RemoteSignalMessage,
  type SignalClientLike,
  type SignalServerLike,
} from "aruna/internal/signal-runtime";

interface FakeSignal {
  readonly signal: SignalClientLike["OnClientEvent"];
  readonly emit: (message: RemoteSignalMessage) => void;
  readonly listenerCount: () => number;
}

function createFakeSignal(): FakeSignal {
  const listeners = new Set<(message: RemoteSignalMessage) => void>();
  return {
    signal: {
      Connect: (callback) => {
        listeners.add(callback);
        let disconnected = false;
        return {
          Disconnect: () => {
            if (disconnected) {
              return;
            }
            disconnected = true;
            listeners.delete(callback);
          },
        };
      },
    },
    emit: (message) => {
      const snapshot = new Array<(message: RemoteSignalMessage) => void>();
      for (const listener of listeners) {
        snapshot.push(listener);
      }
      for (const listener of snapshot) {
        listener(message);
      }
    },
    listenerCount: () => listeners.size(),
  };
}

interface SentEntry<TPlayer> {
  readonly target: "client" | "all";
  readonly player?: TPlayer;
  readonly message: RemoteSignalMessage;
}

type FakeRemote<TPlayer> = SignalServerLike<TPlayer> &
  SignalClientLike & {
    readonly clientSignal: FakeSignal;
    readonly sent: Array<SentEntry<TPlayer>>;
  };

function createFakeRemote<TPlayer>(): FakeRemote<TPlayer> {
  const clientSignal = createFakeSignal();
  const sent = new Array<SentEntry<TPlayer>>();
  return {
    clientSignal,
    sent,
    OnClientEvent: clientSignal.signal,
    FireClient: (player, message) => {
      sent.push({ target: "client", player, message });
      clientSignal.emit(message);
    },
    FireAllClients: (message) => {
      sent.push({ target: "all", message });
      clientSignal.emit(message);
    },
  };
}

function signalIdsOf<TPlayer>(remote: FakeRemote<TPlayer>): Array<string> {
  return remote.sent.map((entry) => entry.message.signalId);
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
  "player.moved": defineSignal({
    id: "player.moved",
    unreliable: true,
    payload: schema.object({ x: schema.f32() }),
  }),
} as const;

interface Named {
  readonly name: string;
}

describe("unreliable signal routing", () => {
  it("routes unreliable signals over the unreliable remote when present", () => {
    const reliable = createFakeRemote<Named>();
    const unreliable = createFakeRemote<Named>();
    const publisher = createRemoteSignalPublisher(reliable, signals, unreliable);

    publisher.toAll("combat.damaged", { amount: 1, source: "trap" });
    publisher.toAll("player.moved", { x: 1.5 });

    expect(signalIdsOf(reliable)).toEqual(["combat.damaged"]);
    expect(signalIdsOf(unreliable)).toEqual(["player.moved"]);
  });

  it("falls back to the reliable remote when no unreliable remote is given", () => {
    const reliable = createFakeRemote<Named>();
    const publisher = createRemoteSignalPublisher(reliable, signals);

    publisher.toAll("player.moved", { x: 1.5 });

    expect(signalIdsOf(reliable)).toEqual(["player.moved"]);
  });

  it("delivers unreliable-channel messages through the subscriber", () => {
    const reliable = createFakeRemote<Named>();
    const unreliable = createFakeRemote<Named>();
    const subscriber = createRemoteSignalSubscriber(reliable, signals, unreliable);
    const calls = new Array<{ x: number }>();
    subscriber.on("player.moved", (payload) => {
      calls.push(payload);
    });

    unreliable.clientSignal.emit({ signalId: "player.moved", payload: { x: 2 } });
    expect(calls).toEqual([{ x: 2 }]);

    subscriber.dispose();
    expect(unreliable.clientSignal.listenerCount()).toBe(0);
  });
});

describe("createRemoteSignalPublisher", () => {
  it("validates and fires a payload to a single player", () => {
    const remote = createFakeRemote<Named>();
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
    const remote = createFakeRemote<Named>();
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
    expect(remote.sent.map((entry) => entry.player)).toEqual(["Ada", "Lin"]);
  });

  it("throws on an unknown signal id", () => {
    const remote = createFakeRemote<string>();
    const publisher = createRemoteSignalPublisher(remote, signals);

    expect(() =>
      (publisher.to as unknown as (player: string, id: string, payload: unknown) => void)(
        "Ada",
        "combat.unknown",
        {},
      ),
    ).toThrow("Aruna signal not found: combat.unknown");
  });

  it("rejects a payload that violates the schema before it reaches the wire", () => {
    const remote = createFakeRemote<string>();
    const publisher = createRemoteSignalPublisher(remote, signals);

    expect(() =>
      publisher.to("Ada", "combat.damaged", {
        amount: "lots",
        source: "trap",
      } as unknown as { amount: number; source: string }),
    ).toThrow("amount: expected finite number");
    expect(remote.sent).toEqual([]);
  });

  it("rejects a non-serializable payload before it reaches the wire", () => {
    const remote = createFakeRemote<string>();
    const publisher = createRemoteSignalPublisher(remote, signals);

    expect(
      () =>
        publisher.to("Ada", "combat.damaged", {
          amount: 1,
          source: "trap",
          // Roblox Instance-like value smuggled past the type.
          culprit: {
            ClassName: "Player",
            IsA: () => true,
          },
        } as unknown as { amount: number; source: string }),
      // The Node runtime says "... is not serializable ..."; the native one
      // says "non-serializable signal payload: <id>". Same reason, asserted on
      // the native wording.
    ).toThrow("non-serializable signal payload: combat.damaged");
    expect(remote.sent).toEqual([]);
  });

  it("toBatched sends every payload to one player, yielding between chunks", async () => {
    const remote = createFakeRemote<string>();
    const publisher = createRemoteSignalPublisher(remote, signals);
    const payloads = new Array<{ amount: number; source: string }>();
    for (let index = 0; index < 5; index += 1) {
      payloads.push({ amount: index, source: "replay" });
    }
    let yields = 0;

    await publisher.toBatched("Ada", "combat.damaged", payloads, {
      chunkSize: 2,
      yield: () => {
        yields += 1;
      },
    });

    expect(remote.sent).toHaveLength(5);
    expect(remote.sent.map((entry) => entry.message.payload)).toEqual(payloads);
    // 5 payloads / chunkSize 2 -> yields after index 1 and 3, not after the
    // last payload.
    expect(yields).toBe(2);
  });

  it("toBatched rejects the whole batch on the first invalid payload", async () => {
    const remote = createFakeRemote<string>();
    const publisher = createRemoteSignalPublisher(remote, signals);

    await expect(
      publisher.toBatched("Ada", "combat.damaged", [
        { amount: 1, source: "ok" },
        { amount: "nope", source: "bad" } as unknown as { amount: number; source: string },
      ]),
    ).rejects.toThrow("amount: expected finite number");
    expect(remote.sent).toHaveLength(1);
  });
});

describe("createRemoteSignalSubscriber", () => {
  it("delivers messages to dynamic .on() subscribers", () => {
    const remote = createFakeRemote<string>();
    const subscriber = createRemoteSignalSubscriber(remote, signals);
    const received = new Array<{ amount: number; source: string }>();

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

  it("drops payloads that violate the declared schema", () => {
    const remote = createFakeRemote<string>();
    let calls = 0;
    const subscriber = createRemoteSignalSubscriber(remote, signals);
    subscriber.on("combat.damaged", () => {
      calls += 1;
    });

    remote.clientSignal.emit({
      signalId: "combat.damaged",
      payload: { amount: "nope", source: "lava" },
    });

    expect(calls).toBe(0);
    subscriber.dispose();
  });

  it("ignores malformed envelopes and signals with no handlers", () => {
    const remote = createFakeRemote<string>();
    let calls = 0;
    const subscriber = createRemoteSignalSubscriber(remote, signals);
    subscriber.on("combat.damaged", () => {
      calls += 1;
    });

    // Node passes `null`; nil is the Luau equivalent.
    remote.clientSignal.emit(undefined as unknown as RemoteSignalMessage);
    remote.clientSignal.emit({ signalId: "world.tick", payload: undefined });

    expect(calls).toBe(0);
    subscriber.dispose();
  });

  it("dispose disconnects from the client signal and rejects further subscriptions", () => {
    const remote = createFakeRemote<string>();
    const subscriber = createRemoteSignalSubscriber(remote, signals);

    expect(remote.clientSignal.listenerCount()).toBe(1);

    subscriber.dispose();
    subscriber.dispose();

    expect(remote.clientSignal.listenerCount()).toBe(0);
    expect(() => subscriber.on("world.tick", () => {})).toThrow("disposed");
  });

  it("round-trips publisher to subscriber over one remote", () => {
    const remote = createFakeRemote<string>();
    const publisher = createRemoteSignalPublisher(remote, signals);
    const subscriber = createRemoteSignalSubscriber(remote, signals);
    const received = new Array<{ amount: number; source: string }>();

    subscriber.on("combat.damaged", (payload) => received.push(payload));
    publisher.toAll("combat.damaged", { amount: 42, source: "boss" });

    expect(received).toEqual([{ amount: 42, source: "boss" }]);
    subscriber.dispose();
  });
});
