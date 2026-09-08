// The in-process test harness: a real `ServerApp` wired to fakes a test can
// drive, so a spec exercises the same validated, rate-limited, middleware-wrapped
// dispatch path the wire uses — without a RemoteEvent, a Players service, or a
// DataStore.
//
// Everything here is assembled from the shipping runtime rather than
// re-implemented: the publisher is the real `createRemoteSignalPublisher` over a
// recording remote, so a payload that would fail validation in production fails
// in the test too. A harness that re-implemented publishing would be the one
// place a bug could hide.

import { createServerApp, type CreateServerAppOptions, type ServerApp } from "../app/server.js";
import { createClientApp, type ClientApp } from "../app/client.js";
import {
  createRemoteSignalPublisher,
  createRemoteSignalSubscriber,
  type RemoteSignalMessage,
} from "../runtime/remote-signal.js";
import type { ActionRegistry } from "../runtime/server.js";
import type { SignalRegistry } from "../runtime/signal.js";

// A stand-in for a Roblox `Player`. Only the two fields the runtime reads are
// present: `UserId` is what the default rate-limit key buckets on, and `Name` is
// what test output identifies a player by.
export type TestPlayer = {
  readonly Name: string;
  readonly UserId: number;
};

let nextUserId = 1;

export function createTestPlayer(options?: {
  readonly name?: string;
  readonly userId?: number;
}): TestPlayer {
  const userId = options?.userId ?? nextUserId++;
  return { Name: options?.name ?? `Player${userId}`, UserId: userId };
}

// One signal emit the app made. A broadcast (`toAll`) carries no player; `to`,
// `toMany`, and `toBatched` record one entry per recipient, which is what the
// wire actually carries.
export type TestSignalRecord<TPlayer = TestPlayer> = {
  readonly signalId: string;
  readonly payload: unknown;
  readonly player?: TPlayer;
};

export type TestServerApp<
  TPlayer = TestPlayer,
  TActions extends ActionRegistry<TPlayer> = ActionRegistry<TPlayer>,
  TSignals extends SignalRegistry = SignalRegistry,
> = {
  // The real app. Reach for it when the harness does not wrap what you need
  // (`app.playerStore`, `app.publisher`, `app.dispatch` with a hand-built ctx).
  readonly app: ServerApp<TPlayer, TActions, TSignals>;
  // Dispatches as `player`, through validation, rate limiting, and middleware.
  readonly invoke: (player: TPlayer, actionId: string, input?: unknown) => Promise<unknown>;
  // Drives the player lifecycle the app subscribed to: sessions are created and
  // dropped, `onPlayerAdded` / `onPlayerRemoving` fire, and an owned player store
  // loads and releases the document.
  readonly join: (player: TPlayer) => void;
  readonly leave: (player: TPlayer) => void;
  readonly players: readonly TPlayer[];
  // Every signal emit since the last `takePublished()`, in order.
  readonly published: readonly TestSignalRecord<TPlayer>[];
  // Returns the recorded emits and clears the log — the usual shape for
  // "assert what this call published, then move on".
  readonly takePublished: () => readonly TestSignalRecord<TPlayer>[];
  // A client app whose transport dispatches into this server as `player`, and
  // whose subscriber receives the signals published to that player. Installs the
  // module-global action invoker, so generated `$aruna/actions/client` stubs
  // work — which means only the most recently created client serves the global.
  readonly client: (player: TPlayer) => ClientApp<TSignals>;
  readonly dispose: () => void;
};

// The harness owns the transport, the publisher, and the players source; the
// rest of `createServerApp` is yours.
export type CreateTestServerAppOptions<
  TPlayer = TestPlayer,
  TActions extends ActionRegistry<TPlayer> = ActionRegistry<TPlayer>,
  TSignals extends SignalRegistry = SignalRegistry,
  TSession = unknown,
> = Omit<
  CreateServerAppOptions<TPlayer, TActions, TSignals, TSession>,
  "transport" | "createPublisher" | "players"
>;

export function createTestServerApp<
  TPlayer = TestPlayer,
  TActions extends ActionRegistry<TPlayer> = ActionRegistry<TPlayer>,
  TSignals extends SignalRegistry = SignalRegistry,
  TSession = unknown,
>(
  options: CreateTestServerAppOptions<TPlayer, TActions, TSignals, TSession>,
): TestServerApp<TPlayer, TActions, TSignals> {
  const published: TestSignalRecord<TPlayer>[] = [];
  // Client-side sinks, so a signal published to a player reaches the subscriber
  // of the client app the harness built for that player.
  const sinks: Array<{ readonly player: TPlayer; readonly deliver: (message: RemoteSignalMessage) => void }> = [];

  const recordingRemote = {
    FireClient(player: TPlayer, message: RemoteSignalMessage): void {
      published.push({ signalId: message.signalId, payload: message.payload, player });
      for (const sink of sinks) {
        if (sink.player === player) {
          sink.deliver(message);
        }
      }
    },
    FireAllClients(message: RemoteSignalMessage): void {
      published.push({ signalId: message.signalId, payload: message.payload });
      for (const sink of sinks) {
        sink.deliver(message);
      }
    },
  };

  const present: TPlayer[] = [];
  const addedHandlers = new Set<(player: TPlayer) => void>();
  const removingHandlers = new Set<(player: TPlayer) => void>();

  const app = createServerApp<TPlayer, TActions, TSignals, TSession>({
    ...options,
    ...(options.signals !== undefined
      ? { createPublisher: (signals: TSignals) => createRemoteSignalPublisher(recordingRemote, signals) }
      : {}),
    players: {
      PlayerAdded: {
        Connect(callback) {
          addedHandlers.add(callback);
          return {
            Disconnect() {
              addedHandlers.delete(callback);
            },
          };
        },
      },
      PlayerRemoving: {
        Connect(callback) {
          removingHandlers.add(callback);
          return {
            Disconnect() {
              removingHandlers.delete(callback);
            },
          };
        },
      },
      GetPlayers: () => present,
    },
  });

  const clients: ClientApp<TSignals>[] = [];
  let disposed = false;

  return {
    app,
    invoke(player, actionId, input) {
      return app.dispatch(actionId, { player }, input);
    },
    join(player) {
      if (present.includes(player)) {
        return;
      }
      present.push(player);
      // A Set may be mutated while it is iterated (a handler that disconnects
      // itself is the normal case), so no defensive copy is needed here.
      for (const handler of addedHandlers) {
        handler(player);
      }
    },
    leave(player) {
      const index = present.indexOf(player);
      if (index === -1) {
        return;
      }
      present.splice(index, 1);
      for (const handler of removingHandlers) {
        handler(player);
      }
    },
    get players() {
      return present;
    },
    get published() {
      return published;
    },
    takePublished() {
      const taken = [...published];
      published.length = 0;
      return taken;
    },
    client(player) {
      const signals = options.signals;
      const clientApp = createClientApp<TSignals>({
        transport: (actionId, input) => app.dispatch(actionId, { player }, input),
        ...(signals !== undefined
          ? {
              signals,
              createSubscriber: (registry: TSignals) =>
                createRemoteSignalSubscriber(
                  {
                    OnClientEvent: {
                      Connect(callback: (message: RemoteSignalMessage) => void) {
                        const sink = { player, deliver: callback };
                        sinks.push(sink);
                        return {
                          Disconnect() {
                            const at = sinks.indexOf(sink);
                            if (at !== -1) {
                              sinks.splice(at, 1);
                            }
                          },
                        };
                      },
                    },
                  },
                  registry,
                ),
            }
          : {}),
      });
      clients.push(clientApp);
      return clientApp;
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const clientApp of clients) {
        clientApp.dispose();
      }
      clients.length = 0;
      sinks.length = 0;
      app.dispose();
    },
  };
}
