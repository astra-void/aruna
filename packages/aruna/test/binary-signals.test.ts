// Binary signal delivery against the shared golden table
// (test/conformance/binary-signals.json): the frame the publisher puts on the
// wire must be byte-identical to the native runtime's, which runs the same table
// under Lune (apps/roblox-runtime-test/lune/specs/signal.luau).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defineSignal } from "../src/server.js";
import { schema, type Schema } from "../src/schema.js";
import {
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
});
