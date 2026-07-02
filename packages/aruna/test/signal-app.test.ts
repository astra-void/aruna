// P2 coverage: the server app owns the signal publisher (so the signal remote is
// ensured at boot without a hand-written plumbing module), and the client app
// exposes an injection-friendly `invoke` that does not depend on global install
// order.
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearActionInvoker, createClientApp } from "../src/client.js";
import {
  createActionDefiner,
  createServerApp,
  defineSignal,
  type SignalRegistry,
} from "../src/server.js";
import {
  bindRemoteEventActions,
  createRemoteSignalPublisher,
  createRemoteSignalSubscriber,
  createSignalPublisher,
  createSignalSubscriber,
  ensureSignalRemote,
  waitForSignalRemote,
  type RemoteEventActionRequest,
  type RemoteEventActionResponse,
  type RemoteEventServerLike,
  type RemoteSignalClientLike,
  type RemoteSignalMessage,
  type RemoteSignalServerLike,
} from "../src/roblox.js";
import { schema } from "../src/schema.js";

type FakeSignalRemote = RemoteSignalServerLike<unknown> & RemoteSignalClientLike;

function createFakeSignalRemote(): FakeSignalRemote {
  const listeners = new Set<(message: RemoteSignalMessage) => void>();
  const emit = (message: RemoteSignalMessage): void => {
    for (const listener of listeners) {
      listener(message);
    }
  };

  return {
    FireClient(_player, message) {
      emit(message);
    },
    FireAllClients(message) {
      emit(message);
    },
    OnClientEvent: {
      Connect(callback: (message: RemoteSignalMessage) => void) {
        listeners.add(callback);
        return {
          Disconnect() {
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
} satisfies SignalRegistry;

afterEach(() => {
  clearActionInvoker();
});

describe("createServerApp signal publisher ownership", () => {
  it("builds the publisher at boot and routes payloads to subscribers", () => {
    const remote = createFakeSignalRemote();
    const serverApp = createServerApp({
      actions: {},
      signals,
      createPublisher: (registry) => createRemoteSignalPublisher(remote, registry),
    });

    expect(serverApp.publisher).toBeDefined();

    const received: Array<{ score: number }> = [];
    const subscriber = createRemoteSignalSubscriber(remote, signals);
    subscriber.on("scoreChanged", (payload) => received.push(payload));

    serverApp.publisher?.toAll("scoreChanged", { score: 7 });

    expect(received).toEqual([{ score: 7 }]);
    subscriber.dispose();
  });

  it("omits the publisher when no createPublisher is supplied", () => {
    const serverApp = createServerApp({ actions: {}, signals });
    expect(serverApp.publisher).toBeUndefined();
  });
});

describe("createClientApp signal subscriber ownership", () => {
  it("builds the subscriber at boot and receives published payloads", () => {
    const remote = createFakeSignalRemote();
    const serverApp = createServerApp({
      actions: {},
      signals,
      createPublisher: (registry) => createRemoteSignalPublisher(remote, registry),
    });

    const invoker = vi.fn(async () => undefined);
    const clientApp = createClientApp({
      transport: invoker,
      signals,
      createSubscriber: (registry) => createRemoteSignalSubscriber(remote, registry),
    });

    expect(clientApp.subscriber).toBeDefined();

    const received: Array<{ score: number }> = [];
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

    const clientApp = createClientApp({
      transport: async () => undefined,
      signals,
      createSubscriber: (registry) => createRemoteSignalSubscriber(remote, registry),
    });

    const received: Array<{ score: number }> = [];
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
  it("invokes through the app handle without relying on the global install", async () => {
    const invoker = vi.fn(async (actionId: string, input: unknown) => ({ actionId, input }));
    const app = createClientApp({ transport: invoker });

    await expect(app.invoke("shop.buy", { itemId: "sword" })).resolves.toEqual({
      actionId: "shop.buy",
      input: { itemId: "sword" },
    });
    expect(invoker).toHaveBeenCalledTimes(1);

    app.dispose();
    await expect(app.invoke("shop.buy", {})).rejects.toThrowError(/disposed/);
  });
});

describe("action ctx.publisher injection", () => {
  const defineAction = createActionDefiner<typeof signals, string>();

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
    const received: Array<{ score: number }> = [];
    const subscriber = createRemoteSignalSubscriber(remote, signals);
    subscriber.on("scoreChanged", (payload) => received.push(payload));

    const serverApp = createServerApp<string, { "score.bump": ReturnType<typeof bumpAction> }, typeof signals>({
      actions: { "score.bump": bumpAction() },
      signals,
      createPublisher: (registry) => createRemoteSignalPublisher(remote, registry),
    });

    const output = await serverApp.dispatch("score.bump", { player: "p1" }, { score: 5 });

    expect(output).toEqual({ ok: true });
    expect(received).toEqual([{ score: 5 }]);
    subscriber.dispose();
  });

  it("threads the publisher through the wire transport (createServerApp owns dispatch)", async () => {
    const signalRemote = createFakeSignalRemote();
    const received: Array<{ score: number }> = [];
    const subscriber = createRemoteSignalSubscriber(signalRemote, signals);
    subscriber.on("scoreChanged", (payload) => received.push(payload));

    // A minimal fake action remote so the transport can dispatch a wire request.
    const serverListeners = new Set<(player: string, request: RemoteEventActionRequest) => void>();
    const clientResponses: RemoteEventActionResponse[] = [];
    const actionRemote: RemoteEventServerLike<string> = {
      OnServerEvent: {
        Connect(callback) {
          serverListeners.add(callback);
          return {
            Disconnect() {
              serverListeners.delete(callback);
            },
          };
        },
      },
      FireClient(_player, response) {
        clientResponses.push(response);
      },
    };

    createServerApp<string, { "score.bump": ReturnType<typeof bumpAction> }, typeof signals>({
      actions: { "score.bump": bumpAction() },
      signals,
      createPublisher: (registry) => createRemoteSignalPublisher(signalRemote, registry),
      transport: ({ registry, dispatch }) => bindRemoteEventActions(actionRemote, registry, dispatch),
    });

    for (const listener of serverListeners) {
      listener("p1", { requestId: "r1", actionId: "score.bump", input: { score: 9 } });
    }
    // Let the async dispatch settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received).toEqual([{ score: 9 }]);
    expect(clientResponses[0]).toMatchObject({ requestId: "r1", ok: true });
    subscriber.dispose();
  });
});

describe("turnkey signal helpers are part of the public surface", () => {
  it("exposes createSignalPublisher/createSignalSubscriber and the remote ensurers", () => {
    expect(createSignalPublisher).toBeTypeOf("function");
    expect(createSignalSubscriber).toBeTypeOf("function");
    expect(ensureSignalRemote).toBeTypeOf("function");
    expect(waitForSignalRemote).toBeTypeOf("function");
  });
});
