import type { RemoteEventSignalConnectionLike, RemoteEventSignalLike } from "./remote-event.js";
import type { Schema } from "../schema/index.js";
import { decodeBinary, encodeBinary } from "./binary.js";
import {
  assertPublishableSignalPayload,
  isDeliverableSignalPayload,
  type InferSignalPayload,
  type SignalDefinition,
  type SignalRegistry,
} from "./signal.js";

// Wire envelope for a server -> client push. A single RemoteEvent multiplexes
// every signal by id, mirroring how the action transport multiplexes by
// requestId/actionId.
export type RemoteSignalMessage = {
  readonly signalId: string;
  readonly payload: unknown;
};

export type RemoteSignalServerLike<TPlayer = unknown> = {
  readonly FireClient: (player: TPlayer, message: RemoteSignalMessage) => void;
  readonly FireAllClients: (message: RemoteSignalMessage) => void;
};

export type RemoteSignalClientLike = {
  readonly OnClientEvent: RemoteEventSignalLike<[RemoteSignalMessage]>;
};

type SignalId<TSignals extends SignalRegistry> = keyof TSignals & string;

const DEFAULT_BATCH_CHUNK_SIZE = 50;

function defaultBatchYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Options for `toBatched`. `chunkSize` caps how many payloads go out before a
// yield; `yield` swaps the wait strategy (defaults to a macrotask tick).
export type SignalBatchOptions = {
  readonly chunkSize?: number;
  readonly yield?: () => Promise<void>;
};

// Server-side emitter bound to a signal registry. Every emit validates the
// payload against the serialization boundary and the signal schema before it
// touches the wire, so an invalid payload fails loudly on the server rather
// than silently reaching clients.
export type RemoteSignalPublisher<TSignals extends SignalRegistry, TPlayer = unknown> = {
  readonly to: <TId extends SignalId<TSignals>>(
    player: TPlayer,
    signalId: TId,
    payload: InferSignalPayload<TSignals[TId]>,
  ) => void;
  readonly toMany: <TId extends SignalId<TSignals>>(
    players: readonly TPlayer[],
    signalId: TId,
    payload: InferSignalPayload<TSignals[TId]>,
  ) => void;
  readonly toAll: <TId extends SignalId<TSignals>>(
    signalId: TId,
    payload: InferSignalPayload<TSignals[TId]>,
  ) => void;
  // Sends a large payload batch to a single player in fixed-size chunks,
  // yielding between chunks instead of firing every payload in one tick.
  // Meant for bulk one-time sends (e.g. late-join replay of a stored
  // broadcast log) where firing hundreds/thousands of messages synchronously
  // would spike outbound bandwidth for that frame.
  readonly toBatched: <TId extends SignalId<TSignals>>(
    player: TPlayer,
    signalId: TId,
    payloads: readonly InferSignalPayload<TSignals[TId]>[],
    options?: SignalBatchOptions,
  ) => Promise<void>;
};

// Roblox drops an unreliable message over this size without an error.
export const UNRELIABLE_PAYLOAD_LIMIT_BYTES = 900;
// What the `{ signalId, payload }` envelope costs on top of the payload and the
// signal id's own bytes: the two key strings (15 bytes) plus 8 bytes for each
// of the table's five values. Mirrors the compiler's
// SIGNAL_ENVELOPE_OVERHEAD_BYTES (crates/aruna_compiler/src/actions.rs), which
// documents the estimate.
export const SIGNAL_ENVELOPE_OVERHEAD_BYTES = 55;

const utf8Encoder = new TextEncoder();

// The payload as it goes on the wire: an `encodeBinary` buffer for a binary
// signal, the value itself otherwise. Validated first, so the encoder only ever
// sees a conforming value. A binary frame's size is exact, so an unreliable one
// that would be dropped for size is refused here, with the message aruna::511
// uses at compile time; a frame can only get there when the schema leaves the
// payload unbounded (aruna::510).
function wirePayload(
  signal: SignalDefinition<Schema | undefined>,
  signalId: string,
  payload: unknown,
): unknown {
  if (signal.wire !== "binary" || signal.payload === undefined) {
    return payload;
  }
  const frame = encodeBinary(signal.payload, payload);
  if (signal.unreliable === true) {
    const size =
      frame.byteLength + utf8Encoder.encode(signalId).byteLength + SIGNAL_ENVELOPE_OVERHEAD_BYTES;
    if (size > UNRELIABLE_PAYLOAD_LIMIT_BYTES) {
      throw new Error(
        `Unreliable signal ${signalId} carries ${size} bytes, over Roblox's ${UNRELIABLE_PAYLOAD_LIMIT_BYTES}-byte unreliable limit; larger payloads are dropped without an error.`,
      );
    }
  }
  return frame;
}

// The payload a binary signal's handlers receive, or `dropped` when the bytes
// are not a frame of this schema (another schema version's fingerprint, a
// truncated buffer, not bytes at all) — dropped the way a schema mismatch is.
const DROPPED = Symbol("dropped");
function readWirePayload(
  signal: SignalDefinition<Schema | undefined>,
  payload: unknown,
): unknown {
  if (signal.wire !== "binary" || signal.payload === undefined) {
    return payload;
  }
  if (!(payload instanceof Uint8Array)) {
    return DROPPED;
  }
  try {
    return decodeBinary(signal.payload, payload);
  } catch {
    return DROPPED;
  }
}

function resolveSignal(
  signals: SignalRegistry,
  signalId: string,
): SignalDefinition<Schema | undefined> {
  const signal = signals[signalId];

  if (signal === undefined) {
    throw new Error(`Aruna signal not found: ${signalId}`);
  }

  return signal;
}

export function createRemoteSignalPublisher<
  TSignals extends SignalRegistry,
  TPlayer = unknown,
>(
  remote: RemoteSignalServerLike<TPlayer>,
  signals: TSignals,
  // The unreliable channel (an UnreliableRemoteEvent in the default wiring).
  // Signals declared `unreliable: true` route here when present; otherwise
  // they fall back to the reliable remote.
  unreliableRemote?: RemoteSignalServerLike<TPlayer>,
): RemoteSignalPublisher<TSignals, TPlayer> {
  const remoteFor = (
    signal: SignalDefinition<Schema | undefined>,
  ): RemoteSignalServerLike<TPlayer> =>
    signal.unreliable === true && unreliableRemote !== undefined ? unreliableRemote : remote;
  // Implemented against loose signatures and re-typed on the way out. The public
  // RemoteSignalPublisher surface is a heavy mapped/generic type; inferring it
  // directly inside the implementation triggers TS2589 (excessive depth).
  const publisher = {
    to(player: TPlayer, signalId: string, payload: unknown): void {
      const signal = resolveSignal(signals, signalId);
      assertPublishableSignalPayload(signal, payload);
      remoteFor(signal).FireClient(player, { signalId, payload: wirePayload(signal, signalId, payload) });
    },
    toMany(players: readonly TPlayer[], signalId: string, payload: unknown): void {
      const signal = resolveSignal(signals, signalId);
      assertPublishableSignalPayload(signal, payload);
      const message: RemoteSignalMessage = { signalId, payload: wirePayload(signal, signalId, payload) };
      const wire = remoteFor(signal);

      for (const player of players) {
        wire.FireClient(player, message);
      }
    },
    toAll(signalId: string, payload: unknown): void {
      const signal = resolveSignal(signals, signalId);
      assertPublishableSignalPayload(signal, payload);
      remoteFor(signal).FireAllClients({ signalId, payload: wirePayload(signal, signalId, payload) });
    },
    async toBatched(
      player: TPlayer,
      signalId: string,
      payloads: readonly unknown[],
      options?: SignalBatchOptions,
    ): Promise<void> {
      const signal = resolveSignal(signals, signalId);
      const chunkSize = options?.chunkSize ?? DEFAULT_BATCH_CHUNK_SIZE;
      const yieldBetweenChunks = options?.yield ?? defaultBatchYield;
      const wire = remoteFor(signal);

      for (let index = 0; index < payloads.length; index += 1) {
        const payload = payloads[index];
        assertPublishableSignalPayload(signal, payload);
        wire.FireClient(player, { signalId, payload: wirePayload(signal, signalId, payload) });

        const isChunkBoundary = (index + 1) % chunkSize === 0;
        if (isChunkBoundary && index + 1 < payloads.length) {
          await yieldBetweenChunks();
        }
      }
    },
  };

  return publisher as RemoteSignalPublisher<TSignals, TPlayer>;
}

export type SignalHandler<TPayload> = (payload: TPayload) => void;

export type RemoteSignalConnection = {
  readonly disconnect: () => void;
};

// Client-side subscriber bound to a signal registry. A single OnClientEvent
// connection fans messages out to per-signal handler sets. `.on()` is the single
// subscribe API (matching the native runtime); it returns a disconnectable
// handle.
export type RemoteSignalSubscriber<TSignals extends SignalRegistry> = {
  readonly on: <TId extends SignalId<TSignals>>(
    signalId: TId,
    handler: SignalHandler<InferSignalPayload<TSignals[TId]>>,
  ) => RemoteSignalConnection;
  readonly dispose: () => void;
};

function isValidSignalMessage(value: unknown): value is RemoteSignalMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return typeof (value as { readonly signalId?: unknown }).signalId === "string";
}

export function createRemoteSignalSubscriber<TSignals extends SignalRegistry>(
  remote: RemoteSignalClientLike,
  signals: TSignals,
  // The unreliable channel; unreliable signals arrive here in the default
  // wiring. The same handler fan-out serves both remotes.
  unreliableRemote?: RemoteSignalClientLike,
): RemoteSignalSubscriber<TSignals> {
  const handlersBySignal = new Map<string, Set<SignalHandler<unknown>>>();
  let disposed = false;

  function addHandler(signalId: string, handler: SignalHandler<unknown>): RemoteSignalConnection {
    let handlers = handlersBySignal.get(signalId);

    if (handlers === undefined) {
      handlers = new Set<SignalHandler<unknown>>();
      handlersBySignal.set(signalId, handlers);
    }

    handlers.add(handler);
    let connected = true;

    return {
      disconnect() {
        if (!connected) {
          return;
        }

        connected = false;
        handlers.delete(handler);
      },
    };
  }

  const onMessage = (message: RemoteSignalMessage): void => {
    if (!isValidSignalMessage(message)) {
      return;
    }

    const handlers = handlersBySignal.get(message.signalId);

    if (handlers === undefined || handlers.size === 0) {
      return;
    }

    const signal = signals[message.signalId];
    const payload = signal !== undefined ? readWirePayload(signal, message.payload) : message.payload;
    if (payload === DROPPED) {
      return;
    }

    // Drop payloads that violate the declared schema before invoking handlers.
    if (signal !== undefined && !isDeliverableSignalPayload(signal, payload)) {
      return;
    }

    // Snapshot so handlers that subscribe/unsubscribe during delivery do not
    // mutate the set mid-iteration. Built with an explicit loop to mirror the
    // roblox-ts native runtime and to avoid Array.from, which is shadowed by the
    // globally loaded @rbxts/types and would lose the handler element type.
    const snapshot: SignalHandler<unknown>[] = [];
    for (const handler of handlers) {
      snapshot.push(handler);
    }

    for (const handler of snapshot) {
      handler(payload);
    }
  };

  const connection: RemoteEventSignalConnectionLike = remote.OnClientEvent.Connect(onMessage);
  const unreliableConnection: RemoteEventSignalConnectionLike | undefined =
    unreliableRemote?.OnClientEvent.Connect(onMessage);

  return {
    on(signalId, handler) {
      if (disposed) {
        throw new Error("RemoteSignal subscriber is disposed.");
      }

      return addHandler(signalId, handler as SignalHandler<unknown>);
    },
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      connection.Disconnect();
      unreliableConnection?.Disconnect();
      handlersBySignal.clear();
    },
  };
}
