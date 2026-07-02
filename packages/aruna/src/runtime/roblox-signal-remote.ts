// Default Aruna signal RemoteEvent wiring — the server -> client push
// counterpart to roblox-action-remote.ts. `createSignalPublisher(signals)` and
// `createSignalSubscriber(signals)` are the turnkey helpers: they ensure / wait
// for `ReplicatedStorage/Aruna/Signals` and wrap it with the schema-validating
// publisher / subscriber. They remove the hand-written lazy-singleton boot
// boilerplate consumers previously needed to create the signal remote before
// any client `WaitForChild` runs.

import {
  createRemoteSignalPublisher,
  createRemoteSignalSubscriber,
  type SignalSubscriberOptions,
  type RemoteSignalClientLike,
  type RemoteSignalPublisher,
  type RemoteSignalServerLike,
  type RemoteSignalSubscriber,
} from "./remote-signal.js";
import type { SignalRegistry } from "./signal.js";

export const ARUNA_SIGNAL_FOLDER_NAME = "Aruna";
export const SIGNAL_REMOTE_NAME = "Signals";

export type SignalRemoteOptions = {
  readonly folderName?: string;
  readonly remoteName?: string;
};

function getRobloxGame(): DataModel {
  if (typeof game === "undefined") {
    throw new Error("Aruna Roblox runtime requires a Roblox environment.");
  }

  return game;
}

function getReplicatedStorage(): ReplicatedStorage {
  return getRobloxGame().GetService("ReplicatedStorage");
}

function isFolder(instance: Instance): instance is Folder {
  return instance.IsA("Folder");
}

function isRemoteEvent(instance: Instance): instance is RemoteEvent {
  return instance.IsA("RemoteEvent");
}

function resolveOptions(options?: SignalRemoteOptions): Required<SignalRemoteOptions> {
  return {
    folderName: options?.folderName ?? ARUNA_SIGNAL_FOLDER_NAME,
    remoteName: options?.remoteName ?? SIGNAL_REMOTE_NAME,
  };
}

function describeClass(instance: Instance): string {
  return instance.ClassName;
}

function ensureFolder(parent: Instance, folderName: string): Folder {
  const existing = parent.FindFirstChild(folderName);

  if (existing === undefined) {
    const folder = new Instance("Folder");
    folder.Name = folderName;
    folder.Parent = parent;
    return folder;
  }

  if (!isFolder(existing)) {
    throw new Error(
      `Aruna Roblox signal folder has wrong class: ReplicatedStorage/${folderName} (${describeClass(existing)})`,
    );
  }

  return existing;
}

function ensureRemoteEvent(parent: Folder, remoteName: string): RemoteEvent {
  const existing = parent.FindFirstChild(remoteName);

  if (existing === undefined) {
    const remote = new Instance("RemoteEvent");
    remote.Name = remoteName;
    remote.Parent = parent;
    return remote;
  }

  if (!isRemoteEvent(existing)) {
    throw new Error(
      `Aruna Roblox signal remote has wrong class: ReplicatedStorage/${parent.Name}/${remoteName} (${describeClass(existing)})`,
    );
  }

  return existing;
}

function waitForFolder(parent: Instance, folderName: string): Folder {
  const instance = parent.WaitForChild(folderName);

  if (!isFolder(instance)) {
    throw new Error(
      `Aruna Roblox signal folder has wrong class: ReplicatedStorage/${folderName} (${describeClass(instance)})`,
    );
  }

  return instance;
}

function waitForRemoteEvent(parent: Folder, remoteName: string): RemoteEvent {
  const instance = parent.WaitForChild(remoteName);

  if (!isRemoteEvent(instance)) {
    throw new Error(
      `Aruna Roblox signal remote has wrong class: ReplicatedStorage/${parent.Name}/${remoteName} (${describeClass(instance)})`,
    );
  }

  return instance;
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
export function ensureSignalRemote(options?: SignalRemoteOptions): RemoteEvent {
  const { folderName, remoteName } = resolveOptions(options);
  const folder = ensureFolder(getReplicatedStorage(), folderName);
  return ensureRemoteEvent(folder, remoteName);
}

// Waits for the default signal RemoteEvent (client side).
export function waitForSignalRemote(options?: SignalRemoteOptions): RemoteEvent {
  const { folderName, remoteName } = resolveOptions(options);
  const folder = waitForFolder(getReplicatedStorage(), folderName);
  return waitForRemoteEvent(folder, remoteName);
}

// Turnkey server-side publisher over the default Aruna signal RemoteEvent. The
// single-argument form is the recommended entry point: it ensures the remote at
// call time (boot), so no lazy-singleton plumbing module is required. Use the
// advanced `createRemoteSignalPublisher(remote, signals)` overload when you
// supply your own RemoteEvent.
export function createSignalPublisher<TSignals extends SignalRegistry, TPlayer = Player>(
  signals: TSignals,
  options?: SignalRemoteOptions,
): RemoteSignalPublisher<TSignals, TPlayer> {
  return createRemoteSignalPublisher<TSignals, TPlayer>(
    toSignalServerLike<TPlayer>(ensureSignalRemote(options)),
    signals,
  );
}

// Turnkey client-side subscriber over the default Aruna signal RemoteEvent.
export function createSignalSubscriber<TSignals extends SignalRegistry>(
  signals: TSignals,
  options?: SignalRemoteOptions & SignalSubscriberOptions<TSignals>,
): RemoteSignalSubscriber<TSignals> {
  const subscriberOptions =
    options?.handlers !== undefined ? { handlers: options.handlers } : undefined;
  return createRemoteSignalSubscriber<TSignals>(
    toSignalClientLike(waitForSignalRemote(options)),
    signals,
    subscriberOptions,
  );
}
