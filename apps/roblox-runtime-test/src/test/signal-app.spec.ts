// Port of packages/aruna/test/signal-app.test.ts: the server app owns the signal
// publisher (so the signal remote is ensured at boot), the client app owns the
// subscriber and exposes an injection-friendly `invoke`, and the app-owned
// publisher reaches every action as `ctx.publisher` on both dispatch paths.
import { createClientApp } from "aruna/client";
import { clearActionInvoker } from "aruna/internal/client-runtime";
import {
  createActionDefiner,
  createSignalPublisher,
  createSignalSubscriber,
  robloxRemoteEvent,
} from "aruna/roblox";
import { REMOTE_NAME } from "aruna/internal/roblox-constants";
import { schema } from "aruna/schema";
import { createServerApp, defineSignal } from "aruna/server";
import { afterEach, describe, expect, it } from "aruna/testing";
import {
  createRemoteSignalPublisher as createChannelPublisher,
  createRemoteSignalSubscriber as createChannelSubscriber,
  type SignalClientLike,
  type SignalMap,
  type SignalServerLike,
} from "aruna/internal/signal-runtime";
import { createClientChannel, createServerChannel } from "aruna/internal/wire";
import { waitUntil, wireRemote } from "./support";

// The two ends of an unbatched reliable channel over a fake remote.
function createRemoteSignalPublisher<TSignals extends SignalMap>(remote: FakeSignalRemote, registry: TSignals) {
  return createChannelPublisher(createServerChannel(remote, { batching: false }), registry);
}

function createRemoteSignalSubscriber<TSignals extends SignalMap>(remote: FakeSignalRemote, registry: TSignals) {
  return createChannelSubscriber(createClientChannel(remote, "signals"), registry);
}

type FakeSignalRemote = SignalServerLike<unknown> & SignalClientLike;

function createFakeSignalRemote(): FakeSignalRemote {
  // Wire frames pass straight through to the subscriber.
  const listeners = new Set<(frame: unknown) => void>();
  const emit = (frame: unknown): void => {
    const snapshot = new Array<(frame: unknown) => void>();
    for (const listener of listeners) {
      snapshot.push(listener);
    }
    for (const listener of snapshot) {
      listener(frame);
    }
  };

  return {
    FireClient: (_player, frame) => {
      emit(frame);
    },
    FireAllClients: (frame) => {
      emit(frame);
    },
    OnClientEvent: {
      Connect: (callback) => {
        listeners.add(callback);
        return {
          Disconnect: () => {
            listeners.delete(callback);
          },
        };
      },
    },
  };
}

const signals = {
  scoreChanged: defineSignal({
    id: "scoreChanged",
    payload: schema.object({ score: schema.number() }),
  }),
};

// Everything a case created that holds a connection, disposed even when the
// case fails part-way: the fake game is shared by every spec in the run.
const cleanups = new Array<() => void>();
function track(cleanup: () => void): void {
  cleanups.push(cleanup);
}

// Hooks attach to a describe block; every block below calls this first.
function disposeAfterEach(): void {
  afterEach(() => {
    for (const cleanup of cleanups) {
      cleanup();
    }
    cleanups.clear();
    clearActionInvoker();
  });
}

describe("createServerApp signal publisher ownership", () => {
  disposeAfterEach();

  it("builds the publisher at boot and routes payloads to subscribers", () => {
    const remote = createFakeSignalRemote();
    const serverApp = createServerApp({
      actions: {},
      signals,
      createPublisher: (registry) => createRemoteSignalPublisher(remote, registry),
    });
    track(() => serverApp.dispose());

    expect(serverApp.publisher).toBeDefined();

    const received = new Array<{ score: number }>();
    const subscriber = createRemoteSignalSubscriber(remote, signals);
    subscriber.on("scoreChanged", (payload) => received.push(payload));

    serverApp.publisher?.toAll("scoreChanged", { score: 7 });

    expect(received).toEqual([{ score: 7 }]);
    subscriber.dispose();
  });

  it("omits the publisher when no createPublisher is supplied", () => {
    const serverApp = createServerApp({ actions: {}, signals });
    track(() => serverApp.dispose());
    expect(serverApp.publisher).toBeUndefined();
  });
});

describe("createClientApp signal subscriber ownership", () => {
  disposeAfterEach();

  it("builds the subscriber at boot and receives published payloads", () => {
    const remote = createFakeSignalRemote();
    const serverApp = createServerApp({
      actions: {},
      signals,
      createPublisher: (registry) => createRemoteSignalPublisher(remote, registry),
    });
    track(() => serverApp.dispose());

    const clientApp = createClientApp({
      transport: async () => undefined,
      signals,
      createSubscriber: (registry) => createRemoteSignalSubscriber(remote, registry),
    });
    track(() => clientApp.dispose());

    expect(clientApp.subscriber).toBeDefined();

    const received = new Array<{ score: number }>();
    const connection = clientApp.subscriber?.on("scoreChanged", (payload) =>
      received.push(payload),
    );

    serverApp.publisher?.toAll("scoreChanged", { score: 11 });
    expect(received).toEqual([{ score: 11 }]);

    connection?.disconnect();
    clientApp.dispose();
  });

  it("disposes the owned subscriber with the app", () => {
    const remote = createFakeSignalRemote();
    const serverApp = createServerApp({
      actions: {},
      signals,
      createPublisher: (registry) => createRemoteSignalPublisher(remote, registry),
    });
    track(() => serverApp.dispose());

    const clientApp = createClientApp({
      transport: async () => undefined,
      signals,
      createSubscriber: (registry) => createRemoteSignalSubscriber(remote, registry),
    });

    const received = new Array<{ score: number }>();
    clientApp.subscriber?.on("scoreChanged", (payload) => received.push(payload));
    clientApp.dispose();

    serverApp.publisher?.toAll("scoreChanged", { score: 3 });
    expect(received).toEqual([]);
  });

  it("omits the subscriber when no createSubscriber is supplied", () => {
    const clientApp = createClientApp({ transport: async () => undefined });
    expect(clientApp.subscriber).toBeUndefined();
    clientApp.dispose();
  });
});

describe("createClientApp invoke injection", () => {
  disposeAfterEach();

  it("invokes through the app handle without relying on the global install", async () => {
    let invokerCalls = 0;
    const app = createClientApp({
      transport: async (actionId: string, input: unknown) => {
        invokerCalls += 1;
        return { actionId, input };
      },
    });

    const output = await app.invoke("shop.buy", { itemId: "sword" });
    expect(output).toEqual({
      actionId: "shop.buy",
      input: { itemId: "sword" },
    });
    expect(invokerCalls).toBe(1);

    app.dispose();
    await expect(app.invoke("shop.buy", {})).rejects.toThrow("disposed");
    expect(invokerCalls).toBe(1);
  });
});

describe("action ctx.publisher injection", () => {
  disposeAfterEach();

  // The native definer defaults the player to `Player`; the wire case below
  // dispatches as the fake game's LocalPlayer.
  const defineAction = createActionDefiner<typeof signals, Player>();

  function bumpAction() {
    return defineAction({
      id: "score.bump",
      input: schema.object({ score: schema.number() }),
      output: schema.object({ ok: schema.boolean() }),
      run(ctx, input) {
        // ctx.publisher is non-optional and registry-typed here.
        ctx.publisher.toAll("scoreChanged", { score: input.score });
        return { ok: true };
      },
    });
  }

  it("threads the app-owned publisher into an in-process dispatch", async () => {
    const remote = createFakeSignalRemote();
    const received = new Array<{ score: number }>();
    const subscriber = createRemoteSignalSubscriber(remote, signals);
    track(() => subscriber.dispose());
    subscriber.on("scoreChanged", (payload) => received.push(payload));

    const serverApp = createServerApp<Player, typeof signals>({
      actions: { "score.bump": bumpAction() },
      signals,
      createPublisher: (registry) => createRemoteSignalPublisher(remote, registry),
    });
    track(() => serverApp.dispose());

    const player = game.GetService("Players").LocalPlayer;
    const output = await serverApp.dispatch("score.bump", { player }, { score: 5 });

    expect(output).toEqual({ ok: true });
    expect(received).toEqual([{ score: 5 }]);
  });

  it("threads the publisher through the wire transport (createServerApp owns dispatch)", async () => {
    // The real RemoteEvent the transport binds and the publisher publishes on,
    // driven with a raw frame from the client end.
    const serverApp = createServerApp<Player, typeof signals>({
      actions: { "score.bump": bumpAction() },
      signals,
      createPublisher: createSignalPublisher,
      transport: robloxRemoteEvent(),
    });
    track(() => serverApp.dispose());
    const wire = wireRemote();
    track(() => wire.dispose());

    await wire.send("r1", "score.bump", { score: 9 });

    expect(wire.signals()).toEqual([{ signalId: "scoreChanged", payload: { score: 9 } }]);
    // Published inside run(), so ahead of the response on the one channel.
    expect(wire.order()).toEqual(["signal scoreChanged", "response r1"]);
    const first = wire.responses()[0];
    expect(first).toBeDefined();
    expect(first?.requestId).toBe("r1");
    expect((first?.result as { ok: boolean } | undefined)?.ok).toBe(true);
  });
});

describe("turnkey signal helpers are part of the public surface", () => {
  disposeAfterEach();

  it("exposes createSignalPublisher/createSignalSubscriber and the remote ensurers", async () => {
    expect(typeIs(createSignalPublisher, "function")).toBe(true);
    expect(typeIs(createSignalSubscriber, "function")).toBe(true);

    // The native runtime has no exported `ensureSignalRemote` /
    // `waitForSignalRemote`: `createSignalPublisher` ensures the remote itself,
    // and `createSignalSubscriber` waits for it. Asserted as that behavior: the
    // remote exists after the publisher is built, and a subscriber built from it
    // receives what the publisher sends.
    const publisher = createSignalPublisher(signals);
    const remote = game.GetService("ReplicatedStorage").FindFirstChild(REMOTE_NAME);
    expect(remote).toBeDefined();
    expect(remote !== undefined && remote.IsA("RemoteEvent")).toBe(true);

    const subscriber = createSignalSubscriber(signals);
    track(() => subscriber.dispose());
    const received = new Array<{ score: number }>();
    subscriber.on("scoreChanged", (payload) => received.push(payload));
    publisher.toAll("scoreChanged", { score: 13 });
    // Batched: it goes out with the frame's other signals, at Heartbeat.
    expect(received).toEqual([]);
    await waitUntil(() => received.size() > 0);
    expect(received).toEqual([{ score: 13 }]);

    // Built again, the publisher reuses the remote rather than adding one.
    createSignalPublisher(signals);
    expect(game.GetService("ReplicatedStorage").FindFirstChild(REMOTE_NAME)).toBe(remote);
  });
});
