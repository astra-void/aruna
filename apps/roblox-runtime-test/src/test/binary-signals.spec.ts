// Binary signal delivery (`wire: "binary"`). Port of
// packages/aruna/test/binary-signals.test.ts. The golden cases mirror
// apps/roblox-runtime-test/conformance/binary-signals.json — a compiled spec
// cannot read files under Lune, so each case's schema, value, and expected frame
// are written out here (lune/specs/signal.luau runs the JSON table itself). The
// frame on the wire must be exactly those bytes.
import { schema, type Schema } from "aruna/schema";
import { defineSignal } from "aruna/server";
import {
  createRemoteSignalPublisher as createBatchingPublisher,
  createRemoteSignalSubscriber,
  type SignalMap,
  type SignalServerLike,
} from "aruna/internal/signal-runtime";
import type { WireFrame } from "aruna/internal/wire";

// One signal as the wire carries it: the item `{ s, d }` of a frame.
interface RemoteSignalMessage {
  readonly signalId: string;
  readonly payload: unknown;
}

// Unbatched, so a case can assert on the wire right after publishing. Binary
// signals in batched frames are covered in wire.spec.ts.
function createRemoteSignalPublisher<TSignals extends SignalMap>(
  remote: SignalServerLike<unknown>,
  registry: TSignals,
) {
  return createBatchingPublisher(remote, registry, undefined, { batching: false });
}
import { describe, expect, it } from "aruna/testing";

interface BinaryCase {
  readonly name: string;
  readonly payload: Schema;
  readonly value: unknown;
  readonly bytes: string;
}

const cases: Array<BinaryCase> = [
  {
    name: "an object packs its fields in sorted key order, with declared number widths",
    payload: schema.object({
      id: schema.u16(),
      hp: schema.u8(),
      x: schema.f32(),
      y: schema.number(),
    }),
    value: { id: 513, hp: 200, x: 1.5, y: -2.25 },
    bytes: "4bea7d10c801020000c03f00000000000002c0",
  },
  {
    name: "strings, booleans, optionals, and enums",
    payload: schema.object({
      by: schema.string().maxLength(16),
      crit: schema.boolean(),
      note: schema.optional(schema.string()),
      kind: schema.enum(["melee", "ranged", "magic"]),
    }),
    value: { by: "ada", crit: true, kind: "magic" },
    bytes: "1a07320403000000616461010200000000",
  },
  {
    name: "arrays and unions",
    payload: schema.object({
      tags: schema.array(schema.u8()).maxItems(8),
      label: schema.union([schema.string().maxLength(10), schema.i16()]),
      phase: schema.literal("start"),
    }),
    value: { tags: [1, 2, 250], label: -3, phase: "start" },
    bytes: "c4257f3901000000fdff030000000102fa",
  },
];

// A structural server/client pair: every fired message is recorded and handed
// straight to the connected subscriber. Function-valued properties, not methods:
// the runtime calls them with `.` (SignalServerLike / SignalClientLike), so a
// method's implicit `self` would shift every argument.
function loopback() {
  const sent = new Array<RemoteSignalMessage>();
  let deliver: ((frame: unknown) => void) | undefined;
  const record = (frame: WireFrame) => {
    for (let index = 1; index < frame.size(); index += 1) {
      const item = frame[index] as { s: string; d?: unknown };
      sent.push({ signalId: item.s, payload: item.d });
    }
    deliver?.(frame);
  };
  return {
    sent,
    server: {
      FireClient: (_player: unknown, frame: WireFrame) => record(frame),
      FireAllClients: (frame: WireFrame) => record(frame),
    },
    // A raw signal in its own frame, as a misbehaving server would send it.
    fireRaw: (message: RemoteSignalMessage) => record([1, { s: message.signalId, d: message.payload }]),
    client: {
      OnClientEvent: {
        Connect: (callback: (frame: unknown) => void) => {
          deliver = callback;
          return { Disconnect: () => undefined };
        },
      },
    },
  };
}

function hex(bytes: unknown): string {
  expect(typeOf(bytes)).toBe("buffer");
  const frame = bytes as buffer;
  const parts = new Array<string>();
  for (let index = 0; index < buffer.len(frame); index += 1) {
    parts.push("%02x".format(buffer.readu8(frame, index)));
  }
  return parts.join("");
}

function bytesOf(values: Array<number>): buffer {
  const out = buffer.create(values.size());
  values.forEach((value, index) => buffer.writeu8(out, index, value));
  return out;
}

describe("binary signal wire (Node)", () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      const signals = {
        "fx.hit": defineSignal({ id: "fx.hit", payload: testCase.payload, wire: "binary" }),
      };
      const remote = loopback();
      const received = new Array<defined>();
      const subscriber = createRemoteSignalSubscriber(remote.client, signals);
      subscriber.on("fx.hit", (payload) => {
        received.push(payload as defined);
      });

      createRemoteSignalPublisher(remote.server, signals).to({}, "fx.hit", testCase.value as never);

      expect(remote.sent).toHaveLength(1);
      expect(hex(remote.sent[0]?.payload)).toBe(testCase.bytes);
      expect(received).toEqual([testCase.value]);
      subscriber.dispose();
    });
  }

  it("drops a frame encoded with another schema version, like a schema mismatch", () => {
    const v1 = {
      "fx.hit": defineSignal({
        id: "fx.hit",
        payload: schema.object({ hp: schema.u8() }),
        wire: "binary",
      }),
    };
    const v2 = {
      "fx.hit": defineSignal({
        id: "fx.hit",
        payload: schema.object({ hp: schema.u16() }),
        wire: "binary",
      }),
    };
    const remote = loopback();
    const received = new Array<defined>();
    const subscriber = createRemoteSignalSubscriber(remote.client, v2);
    subscriber.on("fx.hit", (payload) => {
      received.push(payload as defined);
    });

    createRemoteSignalPublisher(remote.server, v1).to({}, "fx.hit", { hp: 5 });

    expect(remote.sent).toHaveLength(1);
    expect(received).toEqual([]);
    subscriber.dispose();
  });

  it("drops a payload that is not a frame at all", () => {
    const signals = {
      "fx.hit": defineSignal({
        id: "fx.hit",
        payload: schema.object({ hp: schema.u8() }),
        wire: "binary",
      }),
    };
    const remote = loopback();
    const received = new Array<defined>();
    const subscriber = createRemoteSignalSubscriber(remote.client, signals);
    subscriber.on("fx.hit", (payload) => {
      received.push(payload as defined);
    });

    remote.fireRaw({ signalId: "fx.hit", payload: { hp: 5 } });
    remote.fireRaw({ signalId: "fx.hit", payload: bytesOf([1, 2]) });

    expect(remote.sent).toHaveLength(2);
    expect(received).toEqual([]);
    subscriber.dispose();
  });

  it("still validates before encoding", () => {
    const signals = {
      "fx.hit": defineSignal({
        id: "fx.hit",
        payload: schema.object({ hp: schema.u8() }),
        wire: "binary",
      }),
    };
    const remote = loopback();

    expect(() =>
      createRemoteSignalPublisher(remote.server, signals).to({}, "fx.hit", { hp: 300 } as never),
    ).toThrow();
    expect(remote.sent).toEqual([]);
  });
});
