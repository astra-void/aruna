// Default Aruna action RemoteEvent wiring. A single flat
// `ReplicatedStorage/ArunaActionRemoteEvent` — the same instance the native
// runtime uses — multiplexes every action request/response by request id.

import {
  bindRemoteEventActions,
  createRemoteEventActionInvoker,
  type ActionInvokerOptions,
  type BindActionsOptions,
  type DisposableActionInvoker,
  type RemoteEventClientLike,
  type RemoteEventServerLike,
} from "./remote-event.js";
import type { ServerBinding } from "./binding.js";
import type { ActionRegistry } from "./server.js";
import type { ServerTransport } from "../app/server.js";

export const ACTION_REMOTE_NAME = "ArunaActionRemoteEvent";
// Attribute on the action remote where the server advertises its contract hash,
// so a client with a mismatched compiled-in hash can detect a deploy skew.
export const CONTRACT_HASH_ATTRIBUTE_NAME = "ArunaContractHash";

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

function wrongClassError(instance: Instance): Error {
  return new Error(
    `Aruna Roblox action remote has wrong class: ReplicatedStorage/${ACTION_REMOTE_NAME} (${describeClass(instance)})`,
  );
}

function toRemoteEventClientLike(remote: RemoteEvent): RemoteEventClientLike {
  return remote as unknown as RemoteEventClientLike;
}

function toRemoteEventServerLike<TPlayer>(remote: RemoteEvent): RemoteEventServerLike<TPlayer> {
  return remote as unknown as RemoteEventServerLike<TPlayer>;
}

export function getActionRemote(): RemoteEvent {
  const instance = getReplicatedStorage().FindFirstChild(ACTION_REMOTE_NAME);

  if (instance === undefined) {
    throw new Error(
      `Aruna Roblox action RemoteEvent not found: ReplicatedStorage/${ACTION_REMOTE_NAME}`,
    );
  }

  if (!isRemoteEvent(instance)) {
    throw wrongClassError(instance);
  }

  return instance;
}

export function ensureActionRemote(): RemoteEvent {
  const storage = getReplicatedStorage();
  const existing = storage.FindFirstChild(ACTION_REMOTE_NAME);

  if (existing !== undefined) {
    if (!isRemoteEvent(existing)) {
      throw wrongClassError(existing);
    }

    return existing;
  }

  const remote = new Instance("RemoteEvent");
  remote.Name = ACTION_REMOTE_NAME;
  remote.Parent = storage;
  return remote;
}

export function waitForActionRemote(): RemoteEvent {
  const instance = getReplicatedStorage().WaitForChild(ACTION_REMOTE_NAME);

  if (!isRemoteEvent(instance)) {
    throw wrongClassError(instance);
  }

  return instance;
}

export function createActionInvoker(options?: ActionInvokerOptions): DisposableActionInvoker {
  const remote = waitForActionRemote();
  // When a contract hash is expected but no fetcher was injected, read it from
  // the action remote's attribute — the source the server transport advertises.
  const resolvedOptions: ActionInvokerOptions | undefined =
    options?.expectedContractHash !== undefined && options.fetchServerContractHash === undefined
      ? {
          ...options,
          fetchServerContractHash: () => {
            const value = remote.GetAttribute(CONTRACT_HASH_ATTRIBUTE_NAME);
            return typeof value === "string" ? value : undefined;
          },
        }
      : options;
  return createRemoteEventActionInvoker(toRemoteEventClientLike(remote), resolvedOptions);
}

export function bindActions<TPlayer = Player>(
  registry: ActionRegistry<TPlayer>,
  options?: BindActionsOptions<TPlayer>,
): ServerBinding {
  return bindRemoteEventActions(
    toRemoteEventServerLike<TPlayer>(ensureActionRemote()),
    registry,
    options,
  );
}

// Server transport over the default Aruna RemoteEvent, for
// `createServerApp({ transport: robloxRemoteEvent() })`. The app injects its
// resolved dispatch options (rate limiter, key resolver, `defaultRateLimit`,
// clock) so the fallback rate limit reaches the wire without any per-binder
// wiring. `createContext` may still be set here; dispatch options always win.
export function robloxRemoteEvent<TPlayer = Player>(
  options?: Pick<BindActionsOptions<TPlayer>, "createContext"> & {
    // The server's contract hash, advertised on the action remote so clients can
    // detect a deploy skew. Pass the generated `contractHash`; omit to advertise
    // nothing.
    readonly contractHash?: string;
  },
): ServerTransport<TPlayer, ActionRegistry<TPlayer>> {
  return ({ registry, dispatch }) => {
    const remote = ensureActionRemote();
    if (options?.contractHash !== undefined) {
      remote.SetAttribute(CONTRACT_HASH_ATTRIBUTE_NAME, options.contractHash);
    }
    return bindRemoteEventActions(toRemoteEventServerLike<TPlayer>(remote), registry, {
      ...(options?.createContext !== undefined ? { createContext: options.createContext } : {}),
      ...dispatch,
    });
  };
}
