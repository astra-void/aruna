// Runs the shared dispatch conformance table (test/conformance/dispatch.json)
// against the Node reference runtime. The native runtime runs the same table
// under Lune; see test/conformance/README.md for the format.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createServerApp } from "../src/app/server.js";
import {
  bindRemoteEventActions,
  type RemoteEventActionRequest,
  type RemoteEventActionResponse,
} from "../src/runtime/remote-event.js";
import { schema, type Schema } from "../src/schema.js";
import {
  actionError,
  defineAction,
  type ActionMiddleware,
  type ActionRegistry,
} from "../src/server.js";

type SchemaDescriptor = {
  readonly type: "string" | "number" | "boolean" | "object";
  readonly fields?: Readonly<Record<string, SchemaDescriptor>>;
  readonly format?: "f32";
  readonly default?: unknown;
};

type ActionFixture = {
  readonly id: string;
  readonly behavior:
    | "echoInput"
    | "returnConstant"
    | "returnFunction"
    | "throwError"
    | "throwTable"
    | "throwActionError";
  readonly value?: unknown;
  readonly message?: string;
  readonly errorName?: string;
  readonly input?: SchemaDescriptor;
  readonly output?: SchemaDescriptor;
  readonly rateLimit?: { readonly windowMs: number; readonly max: number };
  readonly fireAndForget?: boolean;
};

type Expectation = {
  readonly ok?: boolean;
  readonly output?: unknown;
  readonly errorName?: string;
  readonly message?: string;
  readonly messageContains?: string;
  readonly errorId?: boolean;
  readonly onErrorName?: string;
  readonly noResponse?: boolean;
};

type Step =
  | { readonly advanceMs: number }
  | {
      readonly dispatch: string;
      readonly input?: unknown;
      readonly idempotencyKey?: string;
      readonly expect: Expectation;
    };

type ConformanceCase = {
  readonly name: string;
  readonly actions: readonly ActionFixture[];
  readonly middleware?: readonly string[];
  readonly exposeInternalErrors?: boolean;
  readonly steps: readonly Step[];
  readonly trace: readonly string[];
};

const table = JSON.parse(
  readFileSync(new URL("./conformance/dispatch.json", import.meta.url), "utf8"),
) as { readonly cases: readonly ConformanceCase[] };

function toSchema(descriptor: SchemaDescriptor): Schema {
  const base = (() => {
    switch (descriptor.type) {
      case "string":
        return schema.string();
      case "number":
        return descriptor.format === "f32" ? schema.f32() : schema.number();
      case "boolean":
        return schema.boolean();
      case "object":
        return schema.object(
          Object.fromEntries(
            Object.entries(descriptor.fields ?? {}).map(([key, field]) => [key, toSchema(field)]),
          ),
        );
    }
  })();
  if (descriptor.default === undefined) {
    return base;
  }
  return (base as unknown as { default(value: unknown): Schema }).default(descriptor.default);
}

const NON_FINITE_NUMBERS: Readonly<Record<string, number>> = {
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  "-Infinity": Number.NEGATIVE_INFINITY,
};

// `{ "$function": true }` stands in for a function, and `{ "$number": "NaN" }`
// (or "Infinity" / "-Infinity") for a non-finite number: JSON can carry neither.
// `{ "$array": { "length": n, "of": value } }` builds a large array without
// writing it out.
function materialize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(materialize);
  }
  if (typeof value === "object" && value !== null) {
    if ((value as { $function?: unknown }).$function === true) {
      return () => undefined;
    }
    const repeated = (value as { $array?: { length?: unknown; of?: unknown } }).$array;
    if (repeated !== undefined) {
      return Array.from({ length: Number(repeated.length) }, () => materialize(repeated.of));
    }
    const numberName = (value as { $number?: unknown }).$number;
    if (typeof numberName === "string") {
      const nonFinite = NON_FINITE_NUMBERS[numberName];
      if (nonFinite === undefined) {
        throw new Error(`unknown $number sentinel: ${numberName}`);
      }
      return nonFinite;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, materialize(entry)]),
    );
  }
  return value;
}

function behaviorOf(fixture: ActionFixture): (input: unknown) => unknown {
  switch (fixture.behavior) {
    case "echoInput":
      return (input) => input;
    case "returnConstant":
      return () => fixture.value;
    case "returnFunction":
      return () => ({ handler: () => undefined });
    case "throwError":
      return () => {
        throw new Error(fixture.message);
      };
    case "throwTable":
      return () => {
        // The plain-table throw is the point of this fixture.
        // oxlint-disable-next-line no-throw-literal
        throw { name: fixture.errorName, message: fixture.message };
      };
    case "throwActionError":
      return () => {
        throw actionError(fixture.errorName ?? "", fixture.message ?? "");
      };
  }
}

// A loopback RemoteEvent: `send` fires a request at the bound server and returns
// the response it fired back, or undefined when it sent none.
function createLoopbackRemote() {
  let listener: ((player: unknown, request: RemoteEventActionRequest) => unknown) | undefined;
  const responses: RemoteEventActionResponse[] = [];
  return {
    remote: {
      FireClient(_player: unknown, response: RemoteEventActionResponse) {
        responses.push(response);
      },
      OnServerEvent: {
        Connect(callback: (player: unknown, request: RemoteEventActionRequest) => unknown) {
          listener = callback;
          return {
            Disconnect() {
              listener = undefined;
            },
          };
        },
      },
    },
    async send(player: unknown, request: RemoteEventActionRequest) {
      await listener?.(player, request);
      return responses.shift();
    },
  };
}

describe("dispatch conformance (Node)", () => {
  for (const testCase of table.cases) {
    it(testCase.name, async () => {
      const trace: string[] = [];
      const actions: ActionRegistry = {};
      for (const fixture of testCase.actions) {
        const behave = behaviorOf(fixture);
        actions[fixture.id] = defineAction({
          id: fixture.id,
          ...(fixture.input !== undefined ? { input: toSchema(fixture.input) } : {}),
          ...(fixture.output !== undefined ? { output: toSchema(fixture.output) } : {}),
          ...(fixture.rateLimit !== undefined ? { rateLimit: fixture.rateLimit } : {}),
          ...(fixture.fireAndForget === true ? { fireAndForget: true } : {}),
          run(_ctx, input) {
            trace.push("run");
            return behave(input);
          },
        });
      }

      const middleware = (testCase.middleware ?? []).map(
        (label): ActionMiddleware => async (_info, next) => {
          trace.push(`${label}:before`);
          const output = await next();
          trace.push(`${label}:after`);
          return output;
        },
      );

      let clockMs = 0;
      let lastErrorId: string | undefined;
      let lastErrorName: string | undefined;
      const loopback = createLoopbackRemote();
      const app = createServerApp({
        actions,
        middleware,
        onError(error, info) {
          trace.push("onError");
          lastErrorId = info.errorId;
          lastErrorName = error instanceof Error ? error.name : undefined;
        },
        ...(testCase.exposeInternalErrors !== undefined
          ? { exposeInternalErrors: testCase.exposeInternalErrors }
          : {}),
        nowMs: () => clockMs,
        transport: ({ registry, dispatch }) =>
          bindRemoteEventActions(loopback.remote, registry, dispatch),
      });

      const player = { UserId: 1, Name: "Conformance" };
      let requestCount = 0;
      for (const step of testCase.steps) {
        if ("advanceMs" in step) {
          clockMs += step.advanceMs;
          continue;
        }

        requestCount += 1;
        lastErrorId = undefined;
        lastErrorName = undefined;
        const response = await loopback.send(player, {
          requestId: `conformance:${requestCount}`,
          actionId: step.dispatch,
          input: materialize(step.input),
          ...(step.idempotencyKey !== undefined ? { idempotencyKey: step.idempotencyKey } : {}),
        });
        const expected = step.expect;

        if (expected.noResponse === true) {
          expect(response).toBeUndefined();
          continue;
        }
        expect(response).toBeDefined();
        if (response === undefined) {
          continue;
        }
        if (expected.ok !== undefined) {
          expect(response.ok).toBe(expected.ok);
        }
        if (response.ok) {
          if ("output" in expected) {
            expect(response.output).toEqual(expected.output);
          }
        } else {
          if (expected.errorName !== undefined) {
            expect(response.error.name).toBe(expected.errorName);
          }
          if (expected.message !== undefined) {
            expect(response.error.message).toBe(expected.message);
          }
          if (expected.messageContains !== undefined) {
            expect(response.error.message).toContain(expected.messageContains);
          }
          if (expected.errorId === true) {
            expect(response.error.errorId).toMatch(/^[0-9a-f]{8}$/);
            expect(response.error.errorId).toBe(lastErrorId);
          } else if (expected.errorId === false) {
            expect(response.error.errorId).toBeUndefined();
          }
          if (expected.onErrorName !== undefined) {
            expect(lastErrorName).toBe(expected.onErrorName);
          }
        }
      }

      expect(trace).toEqual(testCase.trace);
      app.dispose();
    });
  }
});
