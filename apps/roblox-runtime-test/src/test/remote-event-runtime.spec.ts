// The action RemoteEvent transport: the client invoker (envelopes, responses,
// timeouts, cancellation, the contract handshake), client middleware and retry,
// the server binding (dispatch, fire-and-forget, wire safety, malformed
// envelopes), and a full round trip. Port of
// packages/aruna/test/remote-event-runtime.test.ts.
//
// The Node suite drove a structural fake remote. Here every case runs over the
// real action RemoteEvent in ReplicatedStorage: when a case plays the server, it
// connects to `OnServerEvent` itself and answers with `FireClient`; when it plays
// the client, it fires raw frames. Every fire carries one wire frame
// (docs/wire-protocol.md): `FireServer([1, { t = 1, i, a, d, k }, ...])` and
// `FireClient(player, [1, { t = 2, i, r }, ...])`. The invoker unit cases run with
// `batching: false`, so a call is on the wire the moment it is made; the server
// and round-trip cases batch, as a game does.
// There is no injectable timer scheduler (`task` is a frozen library under Lune),
// so timeouts are observed with real, short timers.
import {
  REMOTE_NAME,
  CONTRACT_HASH_ATTRIBUTE_NAME,
  DEFAULT_ACTION_REQUEST_TIMEOUT_MS,
  bindActions,
  createActionInvoker,
  defineAction,
  robloxRemoteEvent,
} from "aruna/roblox";
import {
  clearActionInvoker,
  createCancelToken,
  createClientApp,
  invokeAction,
  isActionCancelledError,
  isActionVersionMismatchError,
  withClientMiddleware,
  withRetry,
  type ActionInvoker,
  type ClientMiddleware,
  type VersionMismatchInfo,
} from "aruna/client";
import { createActionRegistry, createServerApp, type ActionMap } from "aruna/server";
import { schema } from "aruna/schema";
import { afterEach, beforeEach, describe, expect, it } from "aruna/testing";
import { rejectionOf, waitUntil, wireRemote } from "./support";

const ReplicatedStorage = game.GetService("ReplicatedStorage");
const Players = game.GetService("Players");

// Cleanups a case registers, run by each describe's afterEach so a failing case
// still unbinds what it bound (every spec shares one remote).
const cleanups = new Array<() => void>();
function track(cleanup: () => void): void {
  cleanups.push(cleanup);
}
function runCleanups(): void {
  while (cleanups.size() > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) {
      cleanup();
    }
  }
}

// The shared action remote, created the way a server creates it.
function actionRemote(): RemoteEvent {
  if (ReplicatedStorage.FindFirstChild(REMOTE_NAME) === undefined) {
    bindActions(createActionRegistry<Player>({})).disconnect();
  }
  return ReplicatedStorage.FindFirstChild(REMOTE_NAME) as RemoteEvent;
}

type ResponsePayload = {
  readonly ok: boolean;
  readonly output?: unknown;
  readonly error?: string;
  readonly errorName?: string;
};

// The server end of the action remote, played by the case: records every
// envelope as its positional argument list, and answers on demand.
function fakeServer(options?: {
  // Answers synchronously from inside FireServer.
  readonly autoRespond?: (requestId: unknown, actionId: unknown, input: unknown) => ResponsePayload;
  // Makes FireServer throw this message (the remote raising mid-send).
  readonly throwOnFire?: string;
}) {
  const remote = actionRemote();
  // Each call as a positional list: [requestId, actionId, input(, key)].
  const requests = new Array<Array<unknown>>();
  const connection = remote.OnServerEvent.Connect((_player: Player, frame: unknown) => {
    if (options !== undefined && options.throwOnFire !== undefined) {
      throw options.throwOnFire;
    }
    const items = frame as Array<{ t: unknown; i: unknown; a: unknown; d?: unknown; k?: unknown }>;
    expect(items[0]).toBe(1);
    for (let index = 1; index < items.size(); index += 1) {
      const call = items[index]!;
      expect(call.t).toBe(1);
      requests.push(call.k !== undefined ? [call.i, call.a, call.d, call.k] : [call.i, call.a, call.d]);
      if (options !== undefined && options.autoRespond !== undefined) {
        remote.FireClient(Players.LocalPlayer, [
          1,
          { t: 2, i: call.i, r: options.autoRespond(call.i, call.a, call.d) },
        ]);
      }
    }
  });
  track(() => connection.Disconnect());
  return {
    remote,
    requests,
    respond: (requestId: unknown, payload: ResponsePayload) => {
      remote.FireClient(Players.LocalPlayer, [1, { t: 2, i: requestId, r: payload }]);
    },
  };
}

// Tracks whether a promise settled, without consuming its rejection.
function settledFlag(promise: Promise<unknown>) {
  const state = { settled: false, resolved: 0, rejected: 0 };
  promise.then(
    () => {
      state.settled = true;
      state.resolved += 1;
    },
    () => {
      state.settled = true;
      state.rejected += 1;
    },
  );
  return state;
}

// An 8-character lowercase hex id, the shape `createErrorId` mints.
function isErrorId(value: unknown): boolean {
  if (!typeIs(value, "string") || value.size() !== 8) {
    return false;
  }
  const [matched] = value.match("^[0-9a-f]+$");
  return matched !== undefined;
}

function sleepSeconds(seconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    task.delay(seconds, () => resolve());
  });
}

describe("createRemoteEventActionInvoker", () => {
  afterEach(runCleanups);

  it("sends request envelopes with the action id and input", async () => {
    const server = fakeServer({ autoRespond: () => ({ ok: true, output: { ok: true } }) });
    const invoker = createActionInvoker({ batching: false, createRequestId: () => "request-1" });

    const output = await invoker("shop.purchaseItem", { itemId: "sword" });
    expect(output).toEqual({ ok: true });
    expect(server.requests).toEqual([["request-1", "shop.purchaseItem", { itemId: "sword" }]]);
  });

  it("resolves matching ok responses", async () => {
    const server = fakeServer();
    const invoker = createActionInvoker({ batching: false, createRequestId: () => "request-1" });

    const promise = invoker("shop.purchaseItem", { itemId: "sword" });
    expect(server.requests).toEqual([["request-1", "shop.purchaseItem", { itemId: "sword" }]]);

    server.respond("request-1", { ok: true, output: { ok: true, source: "remote" } });
    expect(await promise).toEqual({ ok: true, source: "remote" });
  });

  it("rejects matching error responses", async () => {
    const server = fakeServer();
    const invoker = createActionInvoker({ batching: false, createRequestId: () => "request-1" });

    const promise = invoker("shop.purchaseItem", { itemId: "sword" });
    server.respond("request-1", { ok: false, error: "boom", errorName: "CustomError" });

    const reason = await rejectionOf(promise);
    expect(reason.message).toBe("boom");
    expect(reason.name).toBe("CustomError");
  });

  it("ignores responses for unknown request ids", async () => {
    const server = fakeServer();
    const invoker = createActionInvoker({ batching: false, createRequestId: () => "request-1" });

    const promise = invoker("shop.purchaseItem", { itemId: "sword" });
    const state = settledFlag(promise);

    server.respond("unknown-request", { ok: true, output: { ignored: true } });
    task.wait();
    expect(state.settled).toBe(false);

    server.respond("request-1", { ok: true, output: { ok: true } });
    expect(await promise).toEqual({ ok: true });
  });

  it("removes the pending request when FireServer throws", async () => {
    const server = fakeServer({ throwOnFire: "boom" });
    const invoker = createActionInvoker({ batching: false, createRequestId: () => "request-1" });

    await expect(invoker("shop.purchaseItem", { itemId: "sword" })).rejects.toThrow("boom");

    // A late response for the failed request settles nothing and raises nothing.
    expect(() => server.respond("request-1", { ok: true, output: { late: true } })).not.toThrow();
    task.wait();
  });

  it("fire-and-forget resolves immediately without registering a pending request", async () => {
    const server = fakeServer();
    const invoker = createActionInvoker({
      batching: false,
      createRequestId: () => "request-1",
      requestTimeoutMs: 20,
    });

    expect(await invoker("spray.paint", { at: 1 }, { fireAndForget: true })).toBeUndefined();

    // The call went out without an idempotency key, and nothing waits on it:
    // past the timeout there is still nothing to reject.
    expect(server.requests).toEqual([["request-1", "spray.paint", { at: 1 }]]);
    await sleepSeconds(0.05);

    // A late server ack must not throw or settle anything (no pending entry).
    expect(() => server.respond("request-1", { ok: true, output: undefined })).not.toThrow();
  });

  it("fire-and-forget rejects when FireServer throws", async () => {
    fakeServer({ throwOnFire: "network down" });
    const invoker = createActionInvoker({ batching: false });

    // Native: the invoke throws synchronously (the retired Node runtime returned a rejected promise).
    expect(() => invoker("spray.paint", { at: 1 }, { fireAndForget: true })).toThrow(
      "network down",
    );
  });
});

describe("createRemoteEventActionInvoker request timeout", () => {
  afterEach(runCleanups);

  it("arms the default 10s timer when requestTimeoutMs is omitted", async () => {
    const server = fakeServer();
    let counter = 0;
    const invoker = createActionInvoker({
      batching: false,
      createRequestId: () => {
        counter += 1;
        return `default-timeout-${counter}`;
      },
    });
    expect(DEFAULT_ACTION_REQUEST_TIMEOUT_MS).toBe(10_000);

    const promise = invoker("shop.purchaseItem", { itemId: "sword" });
    server.respond("default-timeout-1", { ok: true, output: { ok: true } });
    expect(await promise).toEqual({ ok: true });

    // The timer is armed: an unanswered request times out after 10s.
    const unanswered = invoker("shop.purchaseItem", { itemId: "sword" });
    const reason = await rejectionOf(unanswered);
    expect(reason.name).toBe("ActionTimeoutError");
    expect(reason.message).toContain("10000ms");
  });

  it("does not arm a timer when requestTimeoutMs is 0 (explicit opt-out)", async () => {
    const server = fakeServer();
    const invoker = createActionInvoker({
      batching: false,
      createRequestId: () => "no-timeout-1",
      requestTimeoutMs: 0,
    });

    const promise = invoker("shop.purchaseItem", { itemId: "sword" });
    const state = settledFlag(promise);
    // Still waiting past the default timeout: no timer was armed.
    await sleepSeconds(DEFAULT_ACTION_REQUEST_TIMEOUT_MS / 1000 + 0.2);
    expect(state.settled).toBe(false);

    server.respond("no-timeout-1", { ok: true, output: { ok: true } });
    expect(await promise).toEqual({ ok: true });
  });

  it("clears the timer and resolves when a response arrives", async () => {
    const server = fakeServer();
    const invoker = createActionInvoker({
      batching: false,
      createRequestId: () => "request-1",
      requestTimeoutMs: 30,
    });

    const promise = invoker("shop.purchaseItem", { itemId: "sword" });
    const state = settledFlag(promise);
    server.respond("request-1", { ok: true, output: { ok: true } });

    expect(await promise).toEqual({ ok: true });
    // Past the timeout, nothing fired: still exactly one settlement, a resolve.
    await sleepSeconds(0.08);
    expect(state.resolved).toBe(1);
    expect(state.rejected).toBe(0);
  });

  it("rejects with TimeoutError and clears the pending entry on timeout", async () => {
    const server = fakeServer();
    const invoker = createActionInvoker({
      batching: false,
      createRequestId: () => "request-1",
      requestTimeoutMs: 30,
    });

    const promise = invoker("shop.purchaseItem", { itemId: "sword" });
    const reason = await rejectionOf(promise);

    // A late response finds nothing to settle.
    expect(() => server.respond("request-1", { ok: true, output: { late: true } })).not.toThrow();
    task.wait();

    // Native shape (the retired Node runtime also carried `actionId` and `timeoutMs` fields).
    expect(reason).toEqual({
      message: "Aruna action shop.purchaseItem timed out after 30ms.",
      name: "ActionTimeoutError",
    });
  });
});

describe("createRemoteEventActionInvoker cancellation", () => {
  afterEach(runCleanups);

  it("cancelling before invoke rejects immediately without touching the wire", async () => {
    const server = fakeServer();
    const invoker = createActionInvoker({
      batching: false,
      createRequestId: () => "request-1",
      requestTimeoutMs: 20,
    });

    const cancel = createCancelToken();
    cancel.cancel();

    const reason = await rejectionOf(
      invoker("shop.purchaseItem", { itemId: "sword" }, { signal: cancel }),
    );
    expect(reason.name).toBe("ActionCancelledError");
    // Never fired the request.
    expect(server.requests).toHaveLength(0);
  });

  it("cancelling a pending invoke rejects, clears the timer, and drops late responses", async () => {
    const server = fakeServer();
    const invoker = createActionInvoker({
      batching: false,
      createRequestId: () => "request-1",
      requestTimeoutMs: 30,
    });

    const cancel = createCancelToken();
    const promise = invoker("shop.purchaseItem", { itemId: "sword" }, { signal: cancel });
    const state = settledFlag(promise);
    cancel.cancel();

    const reason = await rejectionOf(promise);
    expect(isActionCancelledError(reason)).toBe(true);
    // Past the would-be timeout: nothing else settled.
    await sleepSeconds(0.08);
    expect(state.rejected).toBe(1);
    expect(state.resolved).toBe(0);

    // A late server response finds nothing to settle.
    server.respond("request-1", { ok: true, output: { late: true } });
    task.wait();
    expect(state.resolved).toBe(0);
  });

  it("a normal response unsubscribes the cancel listener (later cancel is inert)", async () => {
    const server = fakeServer();
    const invoker = createActionInvoker({
      batching: false,
      createRequestId: () => "request-1",
      requestTimeoutMs: 1000,
    });

    const cancel = createCancelToken();
    const promise = invoker("shop.purchaseItem", { itemId: "sword" }, { signal: cancel });
    const state = settledFlag(promise);

    server.respond("request-1", { ok: true, output: { ok: true } });
    expect(await promise).toEqual({ ok: true });

    // Cancelling after settlement must not throw or double-reject.
    expect(() => cancel.cancel()).not.toThrow();
    task.wait();
    expect(state.rejected).toBe(0);
  });

  it("fire-and-forget ignores a cancelled signal (nothing to wait on)", async () => {
    const server = fakeServer();
    const invoker = createActionInvoker({ batching: false, createRequestId: () => "request-1" });

    const cancel = createCancelToken();
    cancel.cancel();

    expect(
      await invoker("shop.ping", { at: 1 }, { fireAndForget: true, signal: cancel }),
    ).toBeUndefined();
    // The one-way request still went out.
    expect(server.requests).toHaveLength(1);
  });
});

describe("client middleware", () => {
  beforeEach(() => clearActionInvoker());
  afterEach(() => clearActionInvoker());

  it("wraps the invoker outermost-first and can observe the result", async () => {
    const calls = new Array<string>();
    const base: ActionInvoker = async (actionId, input) => {
      calls.push(`invoke:${actionId}`);
      return { echoed: input };
    };
    const outer: ClientMiddleware = async (info, proceed) => {
      calls.push(`outer:before:${info.actionId}`);
      const result = await proceed();
      calls.push("outer:after");
      return result;
    };
    const inner: ClientMiddleware = async (_info, proceed) => {
      calls.push("inner:before");
      return proceed();
    };

    const wrapped = withClientMiddleware(base, [outer, inner]);
    expect(await wrapped("shop.buy", { n: 1 })).toEqual({ echoed: { n: 1 } });
    expect(calls).toEqual([
      "outer:before:shop.buy",
      "inner:before",
      "invoke:shop.buy",
      "outer:after",
    ]);
  });

  it("a layer that rejects without calling next short-circuits the invoker", async () => {
    let invoked = false;
    const base: ActionInvoker = async () => {
      invoked = true;
      return "unreachable";
    };
    const block: ClientMiddleware = async () => {
      throw "blocked by middleware";
    };

    const wrapped = withClientMiddleware(base, [block]);
    await expect(wrapped("shop.buy", {})).rejects.toThrow("blocked by middleware");
    expect(invoked).toBe(false);
  });

  it("a synchronous throw in a layer becomes a rejection", async () => {
    const base: ActionInvoker = async () => "ok";
    const boom: ClientMiddleware = () => {
      throw "sync boom";
    };

    const wrapped = withClientMiddleware(base, [boom]);
    await expect(wrapped("shop.buy", {})).rejects.toThrow("sync boom");
  });

  it("returns the invoker unchanged when there is no middleware", () => {
    const base: ActionInvoker = async () => "ok";
    expect(withClientMiddleware(base, [])).toBe(base);
  });

  it("createClientApp applies middleware to both invokeAction and app.invoke", async () => {
    const seen = new Array<string>();
    const base: ActionInvoker = async (actionId) => `ran:${actionId}`;
    const tap: ClientMiddleware = async (info, proceed) => {
      seen.push(info.actionId);
      return proceed();
    };

    const app = createClientApp({ transport: base, middleware: [tap] });

    expect(await invokeAction("shop.viaGlobal", {})).toBe("ran:shop.viaGlobal");
    expect(await app.invoke("shop.viaHandle", {})).toBe("ran:shop.viaHandle");
    expect(seen).toEqual(["shop.viaGlobal", "shop.viaHandle"]);

    app.dispose();
  });
});

describe("client contract handshake", () => {
  afterEach(() => {
    runCleanups();
    // The attribute lives on the shared remote; leave it unset.
    actionRemote().SetAttribute(CONTRACT_HASH_ATTRIBUTE_NAME, undefined);
  });

  // The server advertising `hash` (or nothing), the way `bindActions` does.
  function advertise(hash: string | undefined): void {
    actionRemote().SetAttribute(CONTRACT_HASH_ATTRIBUTE_NAME, hash);
  }

  it("does nothing when the client and server hashes match", async () => {
    const server = fakeServer();
    advertise("abc");
    const mismatches = new Array<VersionMismatchInfo>();
    const invoker = createActionInvoker({
      batching: false,
      createRequestId: () => "request-1",
      expectedContractHash: "abc",
      onVersionMismatch: (info) => {
        mismatches.push(info);
      },
    });

    const promise = invoker("shop.buy", {});
    server.respond("request-1", { ok: true, output: { ok: true } });
    expect(await promise).toEqual({ ok: true });
    expect(mismatches).toHaveLength(0);
  });

  it("fires onVersionMismatch once but still invokes when warn-only", async () => {
    const server = fakeServer();
    advertise("server-hash");
    const mismatches = new Array<VersionMismatchInfo>();
    const invoker = createActionInvoker({
      batching: false,
      createRequestId: () => "request-1",
      expectedContractHash: "client-hash",
      onVersionMismatch: (info) => {
        mismatches.push(info);
      },
    });

    expect(mismatches).toEqual([{ expected: "client-hash", actual: "server-hash" }]);

    // Warn-only: the invoke still goes through to the server.
    const promise = invoker("shop.buy", {});
    server.respond("request-1", { ok: true, output: { ok: true } });
    expect(await promise).toEqual({ ok: true });
    expect(mismatches).toHaveLength(1);
  });

  it("rejects every invoke with ActionVersionMismatchError when rejectOnMismatch", async () => {
    const server = fakeServer();
    advertise("server-hash");
    const invoker = createActionInvoker({
      batching: false,
      expectedContractHash: "client-hash",
      rejectOnMismatch: true,
    });

    const first = await rejectionOf(invoker("shop.buy", {}));
    expect(first.name).toBe("ActionVersionMismatchError");
    const second = await rejectionOf(invoker("shop.buy", {}));
    // No request ever reached the wire.
    expect(server.requests).toHaveLength(0);

    // Native shape (the retired Node runtime also carried `expected` and `actual` fields).
    expect(second).toEqual({
      message: "Aruna contract mismatch: client client-hash vs server server-hash.",
      name: "ActionVersionMismatchError",
    });
  });

  it("treats a server advertising no hash as unknown, not a mismatch", async () => {
    const server = fakeServer();
    advertise(undefined);
    const mismatches = new Array<VersionMismatchInfo>();
    const invoker = createActionInvoker({
      batching: false,
      createRequestId: () => "request-1",
      expectedContractHash: "client-hash",
      onVersionMismatch: (info) => {
        mismatches.push(info);
      },
      rejectOnMismatch: true,
    });

    expect(mismatches).toHaveLength(0);
    // Even with rejectOnMismatch, an unknown server hash does not block invokes.
    const promise = invoker("shop.buy", {});
    server.respond("request-1", { ok: true, output: { ok: true } });
    expect(await promise).toEqual({ ok: true });
  });

  it("isActionVersionMismatchError detects the rejection from either runtime", async () => {
    fakeServer();
    advertise("b");
    const invoker = createActionInvoker({ batching: false, expectedContractHash: "a", rejectOnMismatch: true });
    const rejection = await rejectionOf(invoker("shop.buy", {}));

    expect(isActionVersionMismatchError(rejection)).toBe(true);
    expect(isActionVersionMismatchError({ name: "ActionVersionMismatchError" })).toBe(true);
    expect(isActionVersionMismatchError({ name: "Error", message: "nope" })).toBe(false);
    expect(isActionVersionMismatchError("nope")).toBe(false);
  });
});

describe("client retry", () => {
  // A delay that resolves immediately but records each requested backoff, so
  // retry timing is asserted without real waiting.
  function recordingDelay() {
    const delays = new Array<number>();
    return {
      delays,
      delay: (delayMs: number) => {
        delays.push(delayMs);
        return Promise.resolve();
      },
    };
  }

  function rejectionNamed(name: string, extra?: { readonly retryAfterMs?: number }) {
    return { name, message: name, ...(extra !== undefined ? extra : {}) };
  }

  it("returns the invoker unchanged when retries are disabled", () => {
    const base: ActionInvoker = async () => "ok";
    expect(withRetry(base, { maxRetries: 0 })).toBe(base);
  });

  it("retries a rate-limit rejection and honors retryAfterMs for backoff", async () => {
    let attempts = 0;
    const base: ActionInvoker = async () => {
      attempts += 1;
      if (attempts < 3) {
        throw rejectionNamed("ActionRateLimitError", { retryAfterMs: 50 });
      }
      return "ok";
    };
    const rec = recordingDelay();

    const wrapped = withRetry(base, { maxRetries: 3 }, rec.delay);
    expect(await wrapped("shop.buy", {})).toBe("ok");
    expect(attempts).toBe(3);
    expect(rec.delays).toEqual([50, 50]);
  });

  it("uses exponential backoff for an idempotent call's timeouts and propagates after maxRetries", async () => {
    let attempts = 0;
    const base: ActionInvoker = async () => {
      attempts += 1;
      throw rejectionNamed("ActionTimeoutError");
    };
    const rec = recordingDelay();

    const wrapped = withRetry(base, { maxRetries: 3, baseDelayMs: 100 }, rec.delay);
    const reason = await rejectionOf(wrapped("quest.claim", {}, { idempotent: true }));
    expect(reason.name).toBe("ActionTimeoutError");
    expect(attempts).toBe(4); // initial + 3 retries
    expect(rec.delays).toEqual([100, 200, 400]);
  });

  it("does not retry a timeout for a call that is not idempotent", async () => {
    // A timeout does not mean the server did not run the action: the purchase
    // may have committed and only the response was late.
    let attempts = 0;
    const base: ActionInvoker = async () => {
      attempts += 1;
      throw rejectionNamed("ActionTimeoutError");
    };

    const wrapped = withRetry(base, { maxRetries: 3 }, recordingDelay().delay);
    const reason = await rejectionOf(wrapped("shop.buy", {}));
    expect(reason.name).toBe("ActionTimeoutError");
    expect(attempts).toBe(1);
  });

  it("sends one idempotency key with every attempt of a call", async () => {
    const keys = new Array<defined>();
    let attempts = 0;
    const base: ActionInvoker = async (_actionId, _input, options) => {
      // A placeholder keeps the array dense when no key was passed.
      keys.push(
        options !== undefined && options.idempotencyKey !== undefined
          ? options.idempotencyKey
          : "<none>",
      );
      attempts += 1;
      if (attempts < 3) {
        throw rejectionNamed("ActionRateLimitError", { retryAfterMs: 0 });
      }
      return "ok";
    };

    const wrapped = withRetry(base, { maxRetries: 3 }, recordingDelay().delay);
    expect(await wrapped("shop.buy", {})).toBe("ok");
    expect(await wrapped("shop.buy", {})).toBe("ok");

    expect(keys).toHaveLength(4);
    expect(typeIs(keys[0], "string") && keys[0] !== "<none>").toBe(true);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
    // A new call is a new key.
    expect(keys[3]).not.toBe(keys[0]);
  });

  it("keeps a caller-supplied idempotency key", async () => {
    const keys = new Array<defined>();
    const base: ActionInvoker = async (_actionId, _input, options) => {
      keys.push(
        options !== undefined && options.idempotencyKey !== undefined
          ? options.idempotencyKey
          : "<none>",
      );
      return "ok";
    };

    const wrapped = withRetry(base, { maxRetries: 1 });
    await wrapped("shop.buy", {}, { idempotencyKey: "checkout-42" });
    expect(keys).toEqual(["checkout-42"]);
  });

  it("lets a custom retryOn retry a timeout without idempotent", async () => {
    let attempts = 0;
    const base: ActionInvoker = async () => {
      attempts += 1;
      throw rejectionNamed("ActionTimeoutError");
    };

    const wrapped = withRetry(base, { maxRetries: 1, retryOn: () => true }, recordingDelay().delay);
    const reason = await rejectionOf(wrapped("shop.buy", {}));
    expect(reason.name).toBe("ActionTimeoutError");
    expect(attempts).toBe(2);
  });

  it("does not retry a non-retryable rejection", async () => {
    let attempts = 0;
    const base: ActionInvoker = async () => {
      attempts += 1;
      throw rejectionNamed("ActionValidationError");
    };

    const wrapped = withRetry(base, { maxRetries: 3 });
    const reason = await rejectionOf(wrapped("shop.buy", {}));
    expect(reason.name).toBe("ActionValidationError");
    expect(attempts).toBe(1);
  });

  it("never retries a cancellation", async () => {
    let attempts = 0;
    const base: ActionInvoker = async () => {
      attempts += 1;
      throw rejectionNamed("ActionCancelledError");
    };

    const wrapped = withRetry(base, { maxRetries: 3 });
    const reason = await rejectionOf(wrapped("shop.buy", {}));
    expect(reason.name).toBe("ActionCancelledError");
    expect(attempts).toBe(1);
  });

  it("never retries a fire-and-forget invoke", async () => {
    let attempts = 0;
    const base: ActionInvoker = async (_actionId, _input, options) => {
      attempts += 1;
      if (options !== undefined && options.fireAndForget === true) {
        return undefined;
      }
      throw rejectionNamed("ActionTimeoutError");
    };

    const wrapped = withRetry(base, { maxRetries: 3 });
    expect(await wrapped("shop.ping", {}, { fireAndForget: true })).toBeUndefined();
    expect(attempts).toBe(1);
  });

  it("honors a custom retryOn predicate", async () => {
    let attempts = 0;
    const base: ActionInvoker = async () => {
      attempts += 1;
      throw rejectionNamed("CustomError");
    };
    const rec = recordingDelay();

    const wrapped = withRetry(
      base,
      {
        maxRetries: 2,
        retryOn: (rejection) => (rejection as { name?: string }).name === "CustomError",
      },
      rec.delay,
    );
    const reason = await rejectionOf(wrapped("x", {}));
    expect(reason.name).toBe("CustomError");
    expect(attempts).toBe(3); // initial + 2 retries
  });
});

describe("bindRemoteEventActions", () => {
  afterEach(runCleanups);

  // Binds `actions` to the shared remote and returns a client end that fires raw
  // envelopes and records the responses.
  function bindWire(actions: ActionMap<Player>) {
    const binding = bindActions(createActionRegistry<Player>(actions));
    track(() => binding.disconnect());
    const wire = wireRemote();
    track(() => wire.dispose());
    return { binding, wire };
  }

  it("dispatches an action and sends an ok response", async () => {
    const { wire } = bindWire({
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run(_ctx, input) {
          return { ok: true, input };
        },
      }),
    });

    await wire.send("request-1", "shop.purchaseItem", { itemId: "sword" });

    expect(wire.responses()).toEqual([
      {
        requestId: "request-1",
        result: { ok: true, output: { ok: true, input: { itemId: "sword" } } },
      },
    ]);
  });

  it("runs a fire-and-forget action but sends no response", async () => {
    const runs = new Array<defined>();
    const { wire } = bindWire({
      "spray.paint": defineAction({
        id: "spray.paint",
        fireAndForget: true,
        run(_ctx, input) {
          runs.push(input as defined);
          return { ok: true };
        },
      }),
    });

    await wire.send("request-1", "spray.paint", { at: 1 });

    // The handler ran (side effect observed) but no ack was fired back.
    expect(runs).toEqual([{ at: 1 }]);
    expect(wire.responses()).toEqual([]);
  });

  it("sends no error response when a fire-and-forget action throws", async () => {
    let ran = 0;
    const { wire } = bindWire({
      "spray.paint": defineAction({
        id: "spray.paint",
        fireAndForget: true,
        run() {
          ran += 1;
          throw "boom";
        },
      }),
    });

    await wire.send("request-1", "spray.paint", { at: 1 });

    expect(ran).toBe(1);
    expect(wire.responses()).toEqual([]);
  });

  it("sends an error response for an unknown action id", async () => {
    const { wire } = bindWire({});

    await wire.send("request-1", "shop.purchaseItem", { itemId: "sword" });

    expect(wire.responses()).toEqual([
      {
        requestId: "request-1",
        result: {
          ok: false,
          error: "Aruna action not found: shop.purchaseItem",
          errorName: "ActionNotFoundError",
        },
      },
    ]);
  });

  it("turns input validation failures into error responses", async () => {
    const { wire } = bindWire({
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        input: schema.object({ itemId: schema.string() }),
        run() {
          return { ok: true };
        },
      }),
    });

    await wire.send("request-1", "shop.purchaseItem", { itemId: 123 });

    expect(wire.responses()).toEqual([
      {
        requestId: "request-1",
        result: {
          ok: false,
          error: "Aruna action shop.purchaseItem input validation failed: itemId: expected string",
          errorName: "ActionValidationError",
        },
      },
    ]);
  });

  it("turns unsafe input into error responses", async () => {
    const { wire } = bindWire({
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run() {
          return { ok: true };
        },
      }),
    });

    // An Instance-like value (a real Instance cannot be built under Lune).
    await wire.send("request-1", "shop.purchaseItem", {
      player: {
        ClassName: "Player",
        IsA(className: string) {
          return className === "Instance" || className === "Player";
        },
      },
    });

    expect(wire.responses()).toEqual([
      {
        requestId: "request-1",
        // Native message (the retired Node runtime named the path and reason: "Action
        // shop.purchaseItem input is not serializable … $.player: Roblox Instance-like values …").
        result: {
          ok: false,
          error: "non-serializable action input",
          errorName: "ActionSerializationError",
        },
      },
    ]);
  });

  it("turns output validation failures into error responses", async () => {
    const { wire } = bindWire({
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        output: schema.object({ ok: schema.boolean() }),
        run() {
          return { ok: "yes" } as unknown as { ok: boolean };
        },
      }),
    });

    await wire.send("request-1", "shop.purchaseItem", {});

    // The schema's message stays on the server: the client gets the masked
    // error and its id.
    const responses = wire.responses();
    expect(responses).toHaveLength(1);
    const result = (
      responses[0] !== undefined ? responses[0].result : undefined
    ) as ResponsePayload & { readonly errorId?: unknown };
    expect(isErrorId(result.errorId)).toBe(true);
    expect(result).toEqual({
      ok: false,
      error: "internal error",
      errorName: "ActionInternalError",
      errorId: result.errorId,
    });
  });

  it("turns unsafe output into error responses", async () => {
    const { wire } = bindWire({
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run() {
          return {
            ok: true,
            player: {
              ClassName: "Player",
              IsA(className: string) {
                return className === "Instance" || className === "Player";
              },
            },
          };
        },
      }),
    });

    await wire.send("request-1", "shop.purchaseItem", {});

    const responses = wire.responses();
    expect(responses).toHaveLength(1);
    const result = (
      responses[0] !== undefined ? responses[0].result : undefined
    ) as ResponsePayload & { readonly errorId?: unknown };
    expect(isErrorId(result.errorId)).toBe(true);
    expect(result).toEqual({
      ok: false,
      error: "internal error",
      errorName: "ActionInternalError",
      errorId: result.errorId,
    });
  });

  it("passes the player into a custom context factory", async () => {
    // The native runtime has no per-request context factory; the per-player
    // factory is `createSession`, and its result reaches the action as
    // `ctx.session`.
    const factoryCalls = new Array<defined>();
    const app = createServerApp<Player>({
      actions: {
        "shop.purchaseItem": defineAction({
          id: "shop.purchaseItem",
          run(ctx, input) {
            return { ctx: { player: ctx.player, session: ctx.session }, input };
          },
        }),
      },
      transport: robloxRemoteEvent(),
      createSession: (player) => {
        factoryCalls.push(player);
        return { player, role: "merchant" };
      },
      players: {
        PlayerRemoving: { Connect: () => ({ Disconnect: () => undefined }) },
        GetPlayers: () => [Players.LocalPlayer],
      },
    });
    track(() => app.dispose());
    const wire = wireRemote();
    track(() => wire.dispose());

    await wire.send("request-1", "shop.purchaseItem", { itemId: "sword" });

    expect(factoryCalls).toEqual([Players.LocalPlayer]);
    expect(factoryCalls[0]).toBe(Players.LocalPlayer);
    expect(wire.responses()).toEqual([
      {
        requestId: "request-1",
        result: {
          ok: true,
          output: {
            ctx: {
              player: Players.LocalPlayer,
              session: { player: Players.LocalPlayer, role: "merchant" },
            },
            input: { itemId: "sword" },
          },
        },
      },
    ]);
  });

  it("drops a malformed request envelope without a response", async () => {
    let runs = 0;
    const { wire } = bindWire({
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run() {
          runs += 1;
          return { ok: true };
        },
      }),
    });

    // A usable requestId no longer earns a reply: a malformed call is dropped,
    // so a flood of them has nothing to measure.
    await wire.send("request-1", 123, {});
    // Ids past their length limits are malformed too.
    await wire.send("r".rep(65), "shop.purchaseItem", {});
    await wire.send("request-3", "a".rep(129), {});

    expect(runs).toBe(0);
    expect(wire.responses()).toEqual([]);
  });

  it("drops a request that has no usable requestId", async () => {
    let runs = 0;
    const { wire } = bindWire({
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run() {
          runs += 1;
          return { ok: true };
        },
      }),
    });

    await wire.send(undefined, "shop.purchaseItem", {});
    // A fire with no frame in it.
    wire.remote.FireServer();
    await waitUntil(() => wire.responses().size() > 0, 5);

    expect(runs).toBe(0);
    expect(wire.responses()).toEqual([]);
  });

  it("dispose disconnects from the server request signal", async () => {
    const { binding, wire } = bindWire({});

    // Bound: an envelope earns a response.
    await wire.send("request-1", "shop.purchaseItem", {});
    expect(wire.responses()).toHaveLength(1);

    binding.disconnect();
    binding.disconnect();

    // Disconnected: the binding no longer hears envelopes.
    await wire.send("request-2", "shop.purchaseItem", {});
    expect(wire.responses()).toHaveLength(1);
  });
});

describe("RemoteEvent round trip", () => {
  beforeEach(() => clearActionInvoker());
  afterEach(() => {
    runCleanups();
    clearActionInvoker();
  });

  it("connects generated-style client stubs, client and server apps, and validation", async () => {
    const actions = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        input: schema.object({ itemId: schema.string() }),
        output: schema.object({
          ok: schema.boolean(),
          itemId: schema.string(),
          playerName: schema.string(),
        }),
        run(ctx, input) {
          return { ok: true, itemId: input.itemId, playerName: ctx.player.Name };
        },
      }),
    };

    const serverApp = createServerApp({ actions, transport: robloxRemoteEvent() });
    track(() => serverApp.dispose());
    const clientApp = createClientApp({
      transport: createActionInvoker({ createRequestId: () => "round-trip-1" }),
    });
    track(() => clientApp.dispose());

    const purchaseItem = (input: { readonly itemId: string }) =>
      invokeAction("shop.purchaseItem", input);

    expect(await purchaseItem({ itemId: "sword" })).toEqual({
      ok: true,
      itemId: "sword",
      playerName: Players.LocalPlayer.Name,
    });
  });

  it("resolves concurrent requests by request id", async () => {
    const server = fakeServer();
    let counter = 0;
    const invoker = createActionInvoker({
      batching: false,
      createRequestId: () => {
        counter += 1;
        return `request-${counter}`;
      },
    });

    const firstPromise = invoker("shop.first", { value: 1 });
    const secondPromise = invoker("shop.second", { value: 2 });

    expect(server.requests).toEqual([
      ["request-1", "shop.first", { value: 1 }],
      ["request-2", "shop.second", { value: 2 }],
    ]);

    server.respond("request-2", { ok: true, output: { value: 2, source: "second" } });
    server.respond("request-1", { ok: true, output: { value: 1, source: "first" } });

    expect(await firstPromise).toEqual({ value: 1, source: "first" });
    expect(await secondPromise).toEqual({ value: 2, source: "second" });
  });
});
