// Helpers shared by the runtime specs. Not a spec itself: the runner loads every
// compiled module under the test tree, and this one registers no tests.
import { ACTION_REMOTE_NAME } from "aruna/roblox";

const ReplicatedStorage = game.GetService("ReplicatedStorage");

// Resolves once `done()` holds, or after `maxFrames` scheduler frames — for a
// message that never gets an answer (a dropped envelope, a one-way action).
export function waitUntil(done: () => boolean, maxFrames = 30): Promise<void> {
  return new Promise<void>((resolve) => {
    task.spawn(() => {
      for (let frame = 0; frame < maxFrames && !done(); frame += 1) {
        task.wait();
      }
      resolve();
    });
  });
}

export interface WireResponse {
  readonly requestId: unknown;
  readonly result: unknown;
}

// The client end of the action RemoteEvent a server app bound: sends raw
// envelopes (`FireServer(requestId, actionId, input, idempotencyKey)`) and
// records every response the server fires back.
export function wireRemote() {
  const remote = ReplicatedStorage.FindFirstChild(ACTION_REMOTE_NAME) as RemoteEvent | undefined;
  if (remote === undefined) {
    throw `${ACTION_REMOTE_NAME} does not exist; bind a server app first`;
  }
  const responses = new Array<WireResponse>();
  const connection = remote.OnClientEvent.Connect((requestId: unknown, result: unknown) => {
    responses.push({ requestId, result });
  });
  return {
    remote,
    responses: () => responses,
    // Sends one envelope and waits for its response (or gives up after a few
    // frames, for a request the server drops).
    send: (...args: Array<unknown>): Promise<void> => {
      const requestId = args[0];
      remote.FireServer(...args);
      return waitUntil(() => responses.some((response) => response.requestId === requestId));
    },
    dispose: () => {
      connection.Disconnect();
    },
  };
}

// The value a promise rejects with; fails the spec when it resolves instead.
// Assert on the reason's fields (`name`, `message`, …) — the native runtime
// rejects with tagged tables, not Error instances.
export function rejectionOf<T = { readonly name: string; readonly message: string }>(
  promise: Promise<unknown>,
): Promise<T> {
  return promise.then(
    (value) => {
      throw `expected a rejection, but the promise resolved with ${tostring(value)}`;
    },
    (reason) => reason as T,
  );
}
