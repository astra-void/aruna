import {
  bindRemoteEventActions,
  createRemoteEventActionInvoker,
  type BindRemoteEventActionsOptions,
  type DisposableActionInvoker,
  type RemoteEventActionInvokerOptions,
  type RemoteEventClientLike,
  type RemoteEventServerLike,
} from "./remote-event.js";
import type { ServerBinding } from "./binding.js";
import type { ActionRegistry } from "./server.js";

export const DEFAULT_ARUNA_FOLDER_NAME = "Aruna";
export const DEFAULT_ARUNA_ACTION_REMOTE_EVENT_NAME = "Actions";

export type RobloxActionRemoteEventOptions = {
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

function getRemotePath(folderName: string, remoteName: string): string {
  return `ReplicatedStorage/${folderName}/${remoteName}`;
}

function getFolderPath(folderName: string): string {
  return `ReplicatedStorage/${folderName}`;
}

function getOptions(options?: RobloxActionRemoteEventOptions): Required<RobloxActionRemoteEventOptions> {
  return {
    folderName: options?.folderName ?? DEFAULT_ARUNA_FOLDER_NAME,
    remoteName: options?.remoteName ?? DEFAULT_ARUNA_ACTION_REMOTE_EVENT_NAME,
  };
}

function describeClass(instance: Instance): string {
  return instance.ClassName;
}

function toRemoteEventClientLike(remote: RemoteEvent): RemoteEventClientLike {
  return remote as unknown as RemoteEventClientLike;
}

function toRemoteEventServerLike<TPlayer>(remote: RemoteEvent): RemoteEventServerLike<TPlayer> {
  return remote as unknown as RemoteEventServerLike<TPlayer>;
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
      `Aruna Roblox remote folder has wrong class: ${getFolderPath(folderName)} (${describeClass(existing)})`,
    );
  }

  return existing;
}

function ensureRemoteEvent(parent: Folder, remoteName: string): RemoteEvent {
  const existing = parent.FindFirstChild(remoteName);

  if (existing === undefined) {
    const remoteEvent = new Instance("RemoteEvent");
    remoteEvent.Name = remoteName;
    remoteEvent.Parent = parent;
    return remoteEvent;
  }

  if (!isRemoteEvent(existing)) {
    throw new Error(
      `Aruna Roblox action remote has wrong class: ${getRemotePath(parent.Name, remoteName)} (${describeClass(existing)})`,
    );
  }

  return existing;
}

function waitForFolder(parent: Instance, folderName: string): Folder {
  const instance = parent.WaitForChild(folderName);

  if (!isFolder(instance)) {
    throw new Error(
      `Aruna Roblox remote folder has wrong class: ${getFolderPath(folderName)} (${describeClass(instance)})`,
    );
  }

  return instance;
}

function waitForRemoteEvent(parent: Folder, remoteName: string): RemoteEvent {
  const instance = parent.WaitForChild(remoteName);

  if (!isRemoteEvent(instance)) {
    throw new Error(
      `Aruna Roblox action remote has wrong class: ${getRemotePath(parent.Name, remoteName)} (${describeClass(instance)})`,
    );
  }

  return instance;
}

function findFolder(parent: Instance, folderName: string): Folder {
  const instance = parent.FindFirstChild(folderName);

  if (instance === undefined) {
    throw new Error(`Aruna Roblox remote folder not found: ${getFolderPath(folderName)}`);
  }

  if (!isFolder(instance)) {
    throw new Error(
      `Aruna Roblox remote folder has wrong class: ${getFolderPath(folderName)} (${describeClass(instance)})`,
    );
  }

  return instance;
}

function findRemoteEvent(parent: Folder, remoteName: string): RemoteEvent {
  const instance = parent.FindFirstChild(remoteName);

  if (instance === undefined) {
    throw new Error(`Aruna Roblox action RemoteEvent not found: ${getRemotePath(parent.Name, remoteName)}`);
  }

  if (!isRemoteEvent(instance)) {
    throw new Error(
      `Aruna Roblox action remote has wrong class: ${getRemotePath(parent.Name, remoteName)} (${describeClass(instance)})`,
    );
  }

  return instance;
}

export function getDefaultRobloxActionRemoteEvent(
  options?: RobloxActionRemoteEventOptions,
): RemoteEvent {
  const { folderName, remoteName } = getOptions(options);
  const replicatedStorage = getReplicatedStorage();
  const folder = findFolder(replicatedStorage, folderName);

  return findRemoteEvent(folder, remoteName);
}

export function ensureDefaultRobloxActionRemoteEvent(
  options?: RobloxActionRemoteEventOptions,
): RemoteEvent {
  const { folderName, remoteName } = getOptions(options);
  const replicatedStorage = getReplicatedStorage();
  const folder = ensureFolder(replicatedStorage, folderName);

  return ensureRemoteEvent(folder, remoteName);
}

export function waitForDefaultRobloxActionRemoteEvent(
  options?: RobloxActionRemoteEventOptions,
): RemoteEvent {
  const { folderName, remoteName } = getOptions(options);
  const replicatedStorage = getReplicatedStorage();
  const folder = waitForFolder(replicatedStorage, folderName);

  return waitForRemoteEvent(folder, remoteName);
}

export function createDefaultRobloxActionInvoker(
  options?: RobloxActionRemoteEventOptions & RemoteEventActionInvokerOptions,
): DisposableActionInvoker {
  return createRemoteEventActionInvoker(
    toRemoteEventClientLike(waitForDefaultRobloxActionRemoteEvent(options)),
    options,
  );
}

export function bindDefaultRobloxActionRemoteEvent<TPlayer = Player>(
  registry: ActionRegistry<TPlayer>,
  options?: RobloxActionRemoteEventOptions & BindRemoteEventActionsOptions<TPlayer>,
): ServerBinding {
  return bindRemoteEventActions(
    toRemoteEventServerLike<TPlayer>(ensureDefaultRobloxActionRemoteEvent(options)),
    registry,
    options,
  );
}
