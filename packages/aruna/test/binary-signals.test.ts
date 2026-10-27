// Binary signal delivery against the shared golden table
// (test/conformance/binary-signals.json): the frame the publisher puts on the
// wire must be byte-identical to the native runtime's, which runs the same table
// under Lune (apps/roblox-runtime-test/lune/specs/signal.luau).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defineSignal } from "../src/server.js";
import { schema, type Schema } from "../src/schema.js";
import {
  SIGNAL_ENVELOPE_OVERHEAD_BYTES,
  createRemoteSignalPublisher,
  createRemoteSignalSubscriber,
  type RemoteSignalMessage,
} from "../src/runtime/remote-signal.js";

type Descriptor = { readonly type: string; readonly [key: string]: unknown };

type BinaryCase = {
  readonly name: string;
  readonly payload: Descriptor;
  readonly value: unknown;
  readonly bytes: string;
};

const table = JSON.parse(
  readFileSync(new URL("./conformance/binary-signals.json", import.meta.url), "utf8"),
) as { readonly cases: readonly BinaryCase[] };

function toSchema(descriptor: Descriptor): Schema {
  switch (descriptor.type) {
    case "string": {
      const base = schema.string();
      return typeof descriptor["maxLength"] === "number"
        ? base.maxLength(descriptor["maxLength"])
        : base;
    }
    case "number": {
      const format = descriptor["format"] as "u8" | "u16" | "i16" | "f32" | undefined;
      return format === undefined ? schema.number() : schema[format]();
    }
    case "boolean":
      return schema.boolean();
    case "literal":
      return schema.literal(descriptor["value"] as string);
    case "enum":
      return schema.enum(descriptor["values"] as [string, ...string[]]);
    case "optional":
      return schema.optional(toSchema(descriptor["inner"] as Descriptor));
    case "array": {
      const base = schema.array(toSchema(descriptor["item"] as Descriptor));
      return typeof descriptor["maxItems"] === "number"
        ? base.maxItems(descriptor["maxItems"])
        : base;
    }
    case "object":
      return schema.object(
        Object.fromEntries(
          Object.entries(descriptor["fields"] as Record<string, Descriptor>).map(([key, field]) => [
            key,
            toSchema(field),
          ]),
        ),
      );
    case "union":
      return schema.union((descriptor["members"] as Descriptor[]).map(toSchema));
    default:
      throw new Error(`unknown descriptor type: ${descriptor.type}`);
  }
}

function loopback() {
  const sent: RemoteSignalMessage[] = [];
  let deliver: ((message: RemoteSignalMessage) => void) | undefined;
  return {
    sent,
    server: {
      FireClient(_player: unknown, message: RemoteSignalMessage) {
        sent.push(message);
        deliver?.(message);
      },
      FireAllClients(message: RemoteSignalMessage) {
        sent.push(message);
        deliver?.(message);
      },
    },
    client: {
      OnClientEvent: {
        Connect(callback: (message: RemoteSignalMessage) => void) {
          deliver = callback;
          return { Disconnect() {} };
        },
      },
    },
  };
}

function hex(bytes: unknown): string {
  expect(bytes).toBeInstanceOf(Uint8Array);
  return Buffer.from(bytes as Uint8Array).toString("hex");
}

describe("binary signal wire (Node)", () => {
  for (const testCase of table.cases) {
    it(testCase.name, () => {
      const signals = {
        "fx.hit": defineSignal({ id: "fx.hit", payload: toSchema(testCase.payload), wire: "binary" }),
      };
      const remote = loopback();
      const received: unknown[] = [];
      createRemoteSignalSubscriber(remote.client, signals).on("fx.hit", (payload) => {
        received.push(payload);
      });

      createRemoteSignalPublisher(remote.server, signals).to({}, "fx.hit", testCase.value as never);

      expect(remote.sent).toHaveLength(1);
      expect(hex(remote.sent[0]?.payload)).toBe(testCase.bytes);
      expect(received).toEqual([testCase.value]);
    });
  }

  it("drops a frame encoded with another schema version, like a schema mismatch", () => {
    const v1 = { "fx.hit": defineSignal({ id: "fx.hit", payload: schema.object({ hp: schema.u8() }), wire: "binary" }) };
    const v2 = { "fx.hit": defineSignal({ id: "fx.hit", payload: schema.object({ hp: schema.u16() }), wire: "binary" }) };
    const remote = loopback();
    const received: unknown[] = [];
    createRemoteSignalSubscriber(remote.client, v2).on("fx.hit", (payload) => {
      received.push(payload);
    });

    createRemoteSignalPublisher(remote.server, v1).to({}, "fx.hit", { hp: 5 });

    expect(remote.sent).toHaveLength(1);
    expect(received).toEqual([]);
  });

  it("drops a payload that is not a frame at all", () => {
    const signals = {
      "fx.hit": defineSignal({ id: "fx.hit", payload: schema.object({ hp: schema.u8() }), wire: "binary" }),
    };
    const remote = loopback();
    const received: unknown[] = [];
    createRemoteSignalSubscriber(remote.client, signals).on("fx.hit", (payload) => {
      received.push(payload);
    });

    remote.server.FireAllClients({ signalId: "fx.hit", payload: { hp: 5 } });
    remote.server.FireAllClients({ signalId: "fx.hit", payload: new Uint8Array([1, 2]) });

    expect(received).toEqual([]);
  });

  it("still validates before encoding", () => {
    const signals = {
      "fx.hit": defineSignal({ id: "fx.hit", payload: schema.object({ hp: schema.u8() }), wire: "binary" }),
    };
    const remote = loopback();

    expect(() =>
      createRemoteSignalPublisher(remote.server, signals).to({}, "fx.hit", { hp: 300 } as never),
    ).toThrow();
    expect(remote.sent).toEqual([]);
  });

  describe("unreliable size check", () => {
    // An unbounded array, so only the runtime can catch an oversized frame.
    // Frame: 4-byte header + 4-byte count + 1 per u8. Envelope: "fx.burst" (8)
    // + SIGNAL_ENVELOPE_OVERHEAD_BYTES (55).
    const payload = schema.array(schema.u8());
    const frameOf = (items: number) => 8 + items;
    const envelope = 8 + SIGNAL_ENVELOPE_OVERHEAD_BYTES;
    const items = (count: number) => Array.from({ length: count }, () => 1);

    it("refuses a binary unreliable frame that is over the limit with its envelope", () => {
      const signals = {
        "fx.burst": defineSignal({ id: "fx.burst", payload, wire: "binary", unreliable: true }),
      };
      const remote = loopback();
      const publisher = createRemoteSignalPublisher(remote.server, signals, remote.server);

      // 829 + 63 = 892 fits; 838 + 63 = 901 does not.
      expect(frameOf(821) + envelope).toBe(892);
      publisher.to({}, "fx.burst", items(821));
      expect(remote.sent).toHaveLength(1);

      expect(() => publisher.to({}, "fx.burst", items(830))).toThrowError(
        "Unreliable signal fx.burst carries 901 bytes, over Roblox's 900-byte unreliable limit; larger payloads are dropped without an error.",
      );
      expect(() => publisher.toAll("fx.burst", items(830))).toThrowError(/901 bytes/);
      expect(() => publisher.toMany([{}], "fx.burst", items(830))).toThrowError(/901 bytes/);
      expect(remote.sent).toHaveLength(1);
    });

    it("rejects toBatched with the same error", async () => {
      const signals = {
        "fx.burst": defineSignal({ id: "fx.burst", payload, wire: "binary", unreliable: true }),
      };
      const remote = loopback();
      const publisher = createRemoteSignalPublisher(remote.server, signals, remote.server);

      await expect(publisher.toBatched({}, "fx.burst", [items(1), items(830)])).rejects.toThrowError(
        /fx\.burst carries 901 bytes/,
      );
      expect(remote.sent).toHaveLength(1);
    });

    it("leaves reliable and table-encoded signals alone", () => {
      const signals = {
        "fx.burst": defineSignal({ id: "fx.burst", payload, wire: "binary" }),
        "fx.table": defineSignal({ id: "fx.table", payload, unreliable: true }),
      };
      const remote = loopback();
      const publisher = createRemoteSignalPublisher(remote.server, signals, remote.server);

      publisher.to({}, "fx.burst", items(2000));
      // A table's size is not known at runtime; the compiler warns instead.
      publisher.to({}, "fx.table", items(2000));
      expect(remote.sent).toHaveLength(2);
    });
  });
});
