// Default Aruna signal RemoteEvent wiring — the server -> client push
// counterpart to roblox-action-remote.ts. `createSignalPublisher(signals)` and
// `createSignalSubscriber(signals)` are the turnkey helpers: they ensure / wait
// for `ReplicatedStorage/ArunaSignalRemoteEvent` (the same flat instance the
// native runtime uses) and wrap it with the schema-validating publisher /
// subscriber. They remove the hand-written lazy-singleton boot boilerplate
// consumers previously needed to create the signal remote before any client
// `WaitForChild` runs.

import {
  createRemoteSignalPublisher,
  createRemoteSignalSubscriber,
  type RemoteSignalClientLike,
  type RemoteSignalPublisher,
  type RemoteSignalServerLike,
  type RemoteSignalSubscriber,
} from "./remote-signal.js";
import type { SignalRegistry } from "./signal.js";

export const SIGNAL_REMOTE_NAME = "ArunaSignalRemoteEvent";

function getRobloxGame(): DataModel {
  if (typeof game === "undefined") {
    throw new Error("Aruna Roblox runtime requires a Roblox environment.");
  }

  return game;
}

function getReplicatedStorage(): ReplicatedStorage {
  return getRobloxGame().GetService("ReplicatedStorage");
}

function isRemoteEvent(instance: Instance): instance is RemoteEvent {
  return instance.IsA("RemoteEvent");
}

function describeClass(instance: Instance): string {
  return instance.ClassName;
}

function toSignalServerLike<TPlayer>(remote: RemoteEvent): RemoteSignalServerLike<TPlayer> {
  return remote as unknown as RemoteSignalServerLike<TPlayer>;
}

function toSignalClientLike(remote: RemoteEvent): RemoteSignalClientLike {
  return remote as unknown as RemoteSignalClientLike;
}

// Ensures the default signal RemoteEvent exists (server side). Call this — or
// `createSignalPublisher` — once at server boot so the remote is replicated
// before any client waits for it.
export function ensureSignalRemote(): RemoteEvent {
  const storage = getReplicatedStorage();
  const existing = storage.FindFirstChild(SIGNAL_REMOTE_NAME);

  if (existing !== undefined) {
    if (!isRemoteEvent(existing)) {
      throw new Error(
        `Aruna Roblox signal remote has wrong class: ReplicatedStorage/${SIGNAL_REMOTE_NAME} (${describeClass(existing)})`,
      );
    }

    return existing;
  }

  const remote = new Instance("RemoteEvent");
  remote.Name = SIGNAL_REMOTE_NAME;
  remote.Parent = storage;
  return remote;
}

// Waits for the default signal RemoteEvent (client side).
export function waitForSignalRemote(): RemoteEvent {
  const instance = getReplicatedStorage().WaitForChild(SIGNAL_REMOTE_NAME);

  if (!isRemoteEvent(instance)) {
    throw new Error(
      `Aruna Roblox signal remote has wrong class: ReplicatedStorage/${SIGNAL_REMOTE_NAME} (${describeClass(instance)})`,
    );
  }

  return instance;
}

// Turnkey server-side publisher over the default Aruna signal RemoteEvent. The
// single-argument form is the recommended entry point: it ensures the remote at
// call time (boot), so no lazy-singleton plumbing module is required. Use the
// advanced `createRemoteSignalPublisher(remote, signals)` overload when you
// supply your own RemoteEvent.
export function createSignalPublisher<TSignals extends SignalRegistry, TPlayer = Player>(
  signals: TSignals,
): RemoteSignalPublisher<TSignals, TPlayer> {
  return createRemoteSignalPublisher<TSignals, TPlayer>(
    toSignalServerLike<TPlayer>(ensureSignalRemote()),
    signals,
  );
}

// Turnkey client-side subscriber over the default Aruna signal RemoteEvent.
// `.on(id, handler)` is the subscribe API.
export function createSignalSubscriber<TSignals extends SignalRegistry>(
  signals: TSignals,
): RemoteSignalSubscriber<TSignals> {
  return createRemoteSignalSubscriber<TSignals>(toSignalClientLike(waitForSignalRemote()), signals);
}
