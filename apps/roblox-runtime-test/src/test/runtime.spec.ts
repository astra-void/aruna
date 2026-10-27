// Port of packages/aruna/test/runtime.test.ts: the client invoker registry,
// server dispatch, and the in-process client → server path.
//
// The Node runtime's free `dispatchAction(registry, actionId, ctx, input,
// options)` has no native export; the native in-process equivalent is
// `createServerApp({ actions, ...options }).dispatch(actionId, ctx, input)`,
// which runs the same validated, rate-limited, middleware-wrapped path and
// rejects with the structured error. The Node in-memory invoker
// (`createInMemoryActionInvoker`) is replaced by the test harness's
// `client(player)`, whose transport dispatches into the server app in process.
import { clearActionInvoker, invokeAction, setActionInvoker } from "aruna/client";
import { schema } from "aruna/schema";
import {
  createServerApp,
  defineAction,
  type ActionErrorHandler,
  type ActionMap,
  type ActionMiddleware,
} from "aruna/server";
import {
  afterEach,
  beforeEach,
  createTestPlayer,
  createTestServerApp,
  deepEquals,
  describe,
  expect,
  it,
} from "aruna/testing";
import { rejectionOf } from "./support";

interface DispatchOptions {
  readonly exposeInternalErrors?: boolean;
  readonly middleware?: ReadonlyArray<ActionMiddleware<unknown>>;
  readonly onError?: ActionErrorHandler<unknown>;
}

// A players source that never fires, so a throwaway app does not subscribe to
// the shared fake Players service.
const inertPlayers = {
  PlayerRemoving: {
    Connect: (_callback: (player: unknown) => void) => ({ Disconnect: () => undefined }),
  },
};

// The native stand-in for Node's `dispatchAction(registry, actionId, ctx,
// input, options)`: one app per call, disposed once the call settles.
function dispatchAction(
  actions: ActionMap<unknown>,
  actionId: string,
  ctx: { readonly player: unknown },
  input: unknown,
  options?: DispatchOptions,
): Promise<unknown> {
  const app = createServerApp<unknown>({
    actions,
    players: inertPlayers,
    ...(options !== undefined && options.exposeInternalErrors !== undefined
      ? { exposeInternalErrors: options.exposeInternalErrors }
      : {}),
    ...(options !== undefined && options.middleware !== undefined
      ? { middleware: options.middleware }
      : {}),
    ...(options !== undefined && options.onError !== undefined ? { onError: options.onError } : {}),
  });
  const settled = app.dispatch(actionId, ctx, input);
  settled.finally(() => app.dispose());
  return settled;
}

// vitest's `toMatchObject`: every field of `expected` (recursively, for tables)
// must equal the same field of `actual`. Fails listing each mismatched path.
function collectMismatches(
  actual: unknown,
  expected: unknown,
  path: string,
  out: Array<string>,
): void {
  if (typeIs(expected, "table") && typeIs(actual, "table")) {
    for (const [key, value] of pairs(expected as { [key: string]: unknown })) {
      collectMismatches(
        (actual as { [key: string]: unknown })[key as string],
        value,
        `${path}.${tostring(key)}`,
        out,
      );
    }
    return;
  }
  if (!deepEquals(actual, expected)) {
    out.push(`${path}: expected ${tostring(expected)}, got ${tostring(actual)}`);
  }
}

function expectMatchObject(actual: unknown, expected: unknown): void {
  const mismatches = new Array<string>();
  collectMismatches(actual, expected, "$", mismatches);
  expect(mismatches).toEqual([]);
}

// The Node case's stand-in for a Roblox Instance: a table that quacks like one.
function instanceLike() {
  return {
    ClassName: "Player",
    IsA(className: string) {
      return className === "Instance" || className === "Player";
    },
  };
}

describe("client runtime", () => {
  beforeEach(() => {
    clearActionInvoker();
  });
  afterEach(() => {
    clearActionInvoker();
  });

  it("fails clearly when no invoker is installed", () => {
    // Retired Node runtime: rejected with `Aruna action invoker is not installed; cannot invoke "<id>"`.
    expect(() => invokeAction("shop.purchaseItem", { itemId: "sword" })).toThrow(
      "Aruna action runtime is not installed: shop.purchaseItem",
    );
  });

  it("calls the installed invoker", async () => {
    setActionInvoker(async (actionId, input) => {
      return { actionId, input };
    });

    const output = await invokeAction("shop.purchaseItem", { itemId: "sword" });
    expect(output).toEqual({
      actionId: "shop.purchaseItem",
      input: { itemId: "sword" },
    });
  });

  it("clears the installed invoker", () => {
    setActionInvoker(async (actionId, input) => {
      return { actionId, input };
    });
    clearActionInvoker();

    // Retired Node runtime: rejected with `Aruna action invoker is not installed; cannot invoke "<id>"`.
    expect(() => invokeAction("shop.purchaseItem", { itemId: "sword" })).toThrow(
      "Aruna action runtime is not installed: shop.purchaseItem",
    );
  });
});

describe("server runtime", () => {
  it("dispatches a sync action and returns its result", async () => {
    const registry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run(ctx, input) {
          return { ctx, input, mode: "sync" };
        },
      }),
    };

    const output = await dispatchAction(
      registry,
      "shop.purchaseItem",
      { player: { name: "Ada" } },
      { itemId: "sword" },
    );
    expect(output).toEqual({
      ctx: { player: { name: "Ada" } },
      input: { itemId: "sword" },
      mode: "sync",
    });
  });

  it("dispatches an async action and returns its result", async () => {
    const registry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        async run(ctx, input) {
          return Promise.resolve({ ctx, input, mode: "async" });
        },
      }),
    };

    const output = await dispatchAction(
      registry,
      "shop.purchaseItem",
      { player: { name: "Ada" } },
      { itemId: "sword" },
    );
    expect(output).toEqual({
      ctx: { player: { name: "Ada" } },
      input: { itemId: "sword" },
      mode: "async",
    });
  });

  it("fails clearly for an unknown action id", async () => {
    const registry = {};

    await expect(
      dispatchAction(registry, "shop.purchaseItem", { player: "tester" }, { itemId: "sword" }),
    ).rejects.toThrow("Aruna action not found: shop.purchaseItem");
  });

  it("validates input before running the action", async () => {
    const runs = { count: 0 };
    const registry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        input: schema.object({
          itemId: schema.string(),
        }),
        run() {
          runs.count += 1;
          return { ok: true };
        },
      }),
    };

    await expect(
      dispatchAction(registry, "shop.purchaseItem", { player: "tester" }, { itemId: 123 }),
    ).rejects.toThrow(
      "Aruna action shop.purchaseItem input validation failed: itemId: expected string",
    );

    expect(runs.count).toBe(0);
  });

  it("rejects unsafe input before running the action", async () => {
    const runs = { count: 0 };
    const registry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run() {
          runs.count += 1;
          return { ok: true };
        },
      }),
    };

    const rejection = await rejectionOf<unknown>(
      dispatchAction(
        registry,
        "shop.purchaseItem",
        { player: "tester" },
        { player: instanceLike() },
      ),
    );
    expect(runs.count).toBe(0);
    // Retired Node runtime: also carried actionId and role, with the message
    // "Action <id> input is not serializable across the Aruna action boundary. $.player: …".
    expect(rejection).toEqual({
      name: "ActionSerializationError",
      message: "non-serializable action input",
    });
  });

  it("validates output after the action resolves", async () => {
    const seen = new Array<defined>();
    const registry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        output: schema.object({
          ok: schema.boolean(),
        }),
        async run() {
          return { ok: "yes" } as unknown as { ok: boolean };
        },
      }),
    };

    // An invalid output is a server bug: dispatch rejects with the masked
    // error, and onError gets the validation failure with its message.
    const rejection = await rejectionOf<{ name: string; errorId?: string; cause?: unknown }>(
      dispatchAction(
        registry,
        "shop.purchaseItem",
        { player: "tester" },
        { itemId: "sword" },
        { onError: (reason) => seen.push(reason as defined) },
      ),
    );
    expect(rejection.name).toBe("ActionInternalError");
    expectMatchObject(seen[0], {
      name: "ActionValidationError",
      message: "Aruna action shop.purchaseItem output validation failed: ok: expected boolean",
    });
    // Retired Node runtime: also kept the validation failure as the rejection's `cause`.
    expect(rejection.cause).toBeUndefined();
  });

  it("rethrows an output failure as is when internal errors are exposed", async () => {
    const registry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        output: schema.object({ ok: schema.boolean() }),
        run() {
          return { ok: "yes" } as unknown as { ok: boolean };
        },
      }),
    };

    await expect(
      dispatchAction(
        registry,
        "shop.purchaseItem",
        { player: "tester" },
        {},
        {
          exposeInternalErrors: true,
        },
      ),
    ).rejects.toThrow(
      "Aruna action shop.purchaseItem output validation failed: ok: expected boolean",
    );
  });

  it("rejects unsafe output after the action resolves", async () => {
    const runs = { count: 0 };
    const seen = new Array<defined>();
    const registry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run() {
          runs.count += 1;
          return { ok: true, player: instanceLike() };
        },
      }),
    };

    const rejection = await rejectionOf<unknown>(
      dispatchAction(
        registry,
        "shop.purchaseItem",
        { player: "tester" },
        { itemId: "sword" },
        { onError: (reason) => seen.push(reason as defined) },
      ),
    );
    expect(runs.count).toBe(1);
    expectMatchObject(rejection, { name: "ActionInternalError", message: "internal error" });
    // Retired Node runtime: the original also carried actionId and role, with the
    // message "Action <id> output is not serializable across the Aruna action boundary. $.player: …".
    expectMatchObject(seen[0], {
      name: "ActionSerializationError",
      message: "non-serializable action output",
    });
    expect((seen[0] as { actionId?: unknown }).actionId).toBeUndefined();
    expect((seen[0] as { role?: unknown }).role).toBeUndefined();
    // Retired Node runtime: also kept that failure as the rejection's `cause`.
    expect((rejection as { cause?: unknown }).cause).toBeUndefined();
  });

  it("passes output that matches the output schema", async () => {
    const registry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        output: schema.object({ ok: schema.boolean() }),
        run() {
          return { ok: true };
        },
      }),
    };

    const output = await dispatchAction(registry, "shop.purchaseItem", { player: "tester" }, {});
    expect(output).toEqual({ ok: true });
  });

  it("routes an output schema failure through middleware and onError", async () => {
    const onErrorCalls = new Array<{ readonly failure: unknown; readonly info: unknown }>();
    const seenByMiddleware = new Array<defined>();
    const registry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        output: schema.object({ ok: schema.boolean() }),
        run() {
          return { ok: "yes" } as unknown as { ok: boolean };
        },
      }),
    };

    const pending = dispatchAction(
      registry,
      "shop.purchaseItem",
      { player: "tester" },
      {},
      {
        middleware: [
          async (_info, nextInvoke) => {
            return nextInvoke().catch((reason: unknown) => {
              seenByMiddleware.push(reason as defined);
              throw reason;
            });
          },
        ],
        onError: (reason, info) => {
          onErrorCalls.push({ failure: reason, info });
        },
      },
    );

    // Middleware and onError see the validation failure itself; the caller
    // gets the masked error with the same errorId.
    const rejected = await rejectionOf<{ name: string; errorId?: string; cause?: unknown }>(
      pending,
    );
    expect(rejected.name).toBe("ActionInternalError");
    expect(onErrorCalls).toHaveLength(1);
    const failure = onErrorCalls[0]!.failure;
    expectMatchObject(failure, { name: "ActionValidationError" });
    // `instanceof SchemaValidationError` has no native counterpart (no class
    // hierarchy); the name above is what identifies the error.
    expect(onErrorCalls[0]!.info).toEqual({
      actionId: "shop.purchaseItem",
      player: "tester",
      errorId: rejected.errorId,
    });
    expect(seenByMiddleware).toHaveLength(1);
    expect(seenByMiddleware[0]).toBe(failure);
    // Retired Node runtime: the error also carried actionId and role.
    expect((failure as { actionId?: unknown }).actionId).toBeUndefined();
    expect((failure as { role?: unknown }).role).toBeUndefined();
    // Retired Node runtime: the rejection also kept it as its `cause`.
    expect(rejected.cause).toBeUndefined();
  });

  it("includes the action id and role on validation errors", async () => {
    const registry = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        input: schema.object({
          itemId: schema.string(),
        }),
        run() {
          return { ok: true };
        },
      }),
    };

    const rejection = await rejectionOf<unknown>(
      dispatchAction(registry, "shop.purchaseItem", { player: "tester" }, { itemId: 123 }),
    );
    // Retired Node runtime: also carried actionId and role ("input").
    expect(rejection).toEqual({
      name: "ActionValidationError",
      message: "Aruna action shop.purchaseItem input validation failed: itemId: expected string",
    });
  });
});

// Harnesses a case created, disposed after it whether it passed or not.
const harnesses = new Array<{ readonly dispose: () => void }>();
function track<T extends { readonly dispose: () => void }>(harness: T): T {
  harnesses.push(harness);
  return harness;
}
function disposeTracked(): void {
  for (const harness of harnesses) {
    harness.dispose();
  }
  harnesses.clear();
}

describe("in-memory transport", () => {
  beforeEach(() => {
    clearActionInvoker();
  });
  afterEach(() => {
    disposeTracked();
    clearActionInvoker();
  });

  it("connects client invocation to the server registry", async () => {
    const harness = track(
      createTestServerApp({
        actions: {
          "shop.purchaseItem": defineAction({
            id: "shop.purchaseItem",
            run(_ctx, input) {
              return { ok: true, input };
            },
          }),
        },
      }),
    );
    harness.client(createTestPlayer({ name: "tester" }));

    const output = await invokeAction("shop.purchaseItem", { itemId: "sword" });
    expect(output).toEqual({
      ok: true,
      input: { itemId: "sword" },
    });
  });

  it("surfaces validation errors", async () => {
    const harness = track(
      createTestServerApp({
        actions: {
          "shop.purchaseItem": defineAction({
            id: "shop.purchaseItem",
            input: schema.object({
              itemId: schema.string(),
            }),
            run() {
              return { ok: true };
            },
          }),
        },
      }),
    );
    harness.client(createTestPlayer({ name: "tester" }));

    await expect(invokeAction("shop.purchaseItem", { itemId: 123 })).rejects.toThrow(
      "Aruna action shop.purchaseItem input validation failed: itemId: expected string",
    );
  });

  it("surfaces serialization policy errors", async () => {
    const harness = track(
      createTestServerApp({
        actions: {
          "shop.purchaseItem": defineAction({
            id: "shop.purchaseItem",
            run(_ctx, input) {
              return { ok: true, input };
            },
          }),
        },
      }),
    );
    harness.client(createTestPlayer({ name: "tester" }));

    const rejection = await rejectionOf<unknown>(
      invokeAction("shop.purchaseItem", { player: instanceLike() }),
    );
    // Retired Node runtime: also carried actionId and role ("input").
    expect(rejection).toEqual({
      name: "ActionSerializationError",
      message: "non-serializable action input",
    });
  });
});

describe("generated-style stubs", () => {
  afterEach(() => {
    disposeTracked();
    clearActionInvoker();
  });

  it("can call through the in-memory invoker", async () => {
    const purchaseItem = (input: unknown): Promise<unknown> => {
      return invokeAction("shop.purchaseItem", input);
    };

    const harness = track(
      createTestServerApp({
        actions: {
          "shop.purchaseItem": defineAction({
            id: "shop.purchaseItem",
            run(_ctx, input) {
              return { ok: true, input };
            },
          }),
        },
      }),
    );
    harness.client(createTestPlayer({ name: "tester" }));

    const output = await purchaseItem({ itemId: "sword" });
    expect(output).toEqual({
      ok: true,
      input: { itemId: "sword" },
    });
  });
});
