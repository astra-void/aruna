// Helpers shared by the runtime specs. Not a spec itself: the runner loads every
// compiled module under the test tree, and this one registers no tests.
import { ACTION_REMOTE_NAME } from "aruna/roblox";

const ReplicatedStorage = game.GetService("ReplicatedStorage");

// Resolves once `done()` holds, or after `maxFrames` scheduler frames — for a
// message that never gets an answer (a dropped call, a one-way action). The
// runner fires RunService.Heartbeat every frame, so batched frames flush while
// this waits.
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

// One call as the wire carries it (docs/wire-protocol.md): `{ i, a, d, k }`.
export function wireCall(
  requestId: unknown,
  actionId: unknown,
  input?: unknown,
  idempotencyKey?: unknown,
): object {
  return {
    i: requestId,
    a: actionId,
    ...(input !== undefined ? { d: input } : {}),
    ...(idempotencyKey !== undefined ? { k: idempotencyKey } : {}),
  };
}

// The client end of the action RemoteEvent a server app bound: sends raw frames
// (`[1, ...calls]`) and records every response the server fires back, one entry
// per response item.
export function wireRemote() {
  const remote = ReplicatedStorage.FindFirstChild(ACTION_REMOTE_NAME) as RemoteEvent | undefined;
  if (remote === undefined) {
    throw `${ACTION_REMOTE_NAME} does not exist; bind a server app first`;
  }
  const responses = new Array<WireResponse>();
  const frames = new Array<defined>();
  const connection = remote.OnClientEvent.Connect((frame: unknown) => {
    frames.push(frame as defined);
    const items = frame as Array<{ readonly i: unknown; readonly r: unknown }>;
    for (let index = 1; index < items.size(); index += 1) {
      const item = items[index]!;
      responses.push({ requestId: item.i, result: item.r });
    }
  });
  return {
    remote,
    responses: () => responses,
    // Every response frame, as fired.
    frames: () => frames,
    // Sends one call in its own frame and waits for its response (or gives up
    // after a few frames, for a call the server drops).
    send: (requestId: unknown, actionId: unknown, input?: unknown, idempotencyKey?: unknown): Promise<void> => {
      remote.FireServer([1, wireCall(requestId, actionId, input, idempotencyKey)]);
      return waitUntil(() => responses.some((response) => response.requestId === requestId));
    },
    // Fires a raw frame as is (a batch, or a malformed one) and waits a few
    // frames for whatever the server answers.
    sendFrame: (frame: unknown, maxFrames = 5): Promise<void> => {
      remote.FireServer(frame);
      return waitUntil(() => false, maxFrames);
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
