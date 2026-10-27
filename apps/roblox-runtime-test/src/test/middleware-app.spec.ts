// Port of packages/aruna/test/middleware-app.test.ts: createServerApp({
// middleware, onError }) — the around-run middleware chain (outermost-first,
// inside rate limiting and input validation) and the error observability hook.
//
// The Node cases dispatch with an empty ctx (`{}`); the native `dispatch` ctx
// requires a player (the per-player in-flight cap is keyed on it), so these
// cases dispatch as a fixed player table. Node's `new Error(message)` becomes a
// thrown `{ name: "Error", message }` table: Luau has no Error class.
import { schema } from "aruna/schema";
import { actionError, createServerApp, defineAction, type ActionMiddleware } from "aruna/server";
import { afterEach, describe, expect, it } from "aruna/testing";
import { rejectionOf } from "./support";

const buy = defineAction({
  id: "shop.buy",
  input: schema.object({ itemId: schema.string() }),
  output: schema.object({ ok: schema.boolean() }),
  run() {
    return { ok: true };
  },
});

// A players source that never fires, so these apps do not subscribe to the
// shared fake Players service.
const inertPlayers = {
  PlayerRemoving: {
    Connect: (_callback: (player: unknown) => void) => ({ Disconnect: () => undefined }),
  },
};

const caller = { name: "Caller" };

const apps = new Array<{ readonly dispose: () => void }>();
function track<T extends { readonly dispose: () => void }>(app: T): T {
  apps.push(app);
  return app;
}
function disposeTracked(): void {
  for (const app of apps) {
    app.dispose();
  }
  apps.clear();
}

interface ErrorCall {
  readonly failure: unknown;
  readonly info: { readonly actionId: string; readonly player: unknown; readonly errorId?: string };
}

describe("createServerApp middleware", () => {
  afterEach(() => disposeTracked());

  it("wraps the run outermost-first and can observe input and output", async () => {
    const order = new Array<string>();
    const outer: ActionMiddleware = async (info, nextInvoke) => {
      order.push(`outer:${info.actionId}`);
      const output = await nextInvoke();
      order.push("outer:done");
      return output;
    };
    const inner: ActionMiddleware = async (_info, nextInvoke) => {
      order.push("inner");
      return nextInvoke();
    };

    const app = track(
      createServerApp({
        actions: { "shop.buy": buy },
        middleware: [outer, inner],
        players: inertPlayers,
      }),
    );
    const output = await app.dispatch("shop.buy", { player: caller }, { itemId: "sword" });
    expect(output).toEqual({ ok: true });
    expect(order).toEqual(["outer:shop.buy", "inner", "outer:done"]);
  });

  it("short-circuits when a middleware throws, without running the action", async () => {
    const runs = { count: 0 };
    const guarded = defineAction({
      id: "shop.guarded",
      output: schema.object({ ok: schema.boolean() }),
      run() {
        runs.count += 1;
        return { ok: true };
      },
    });
    const reject: ActionMiddleware = async () => {
      throw { name: "Error", message: "not authorized" };
    };

    const app = track(
      createServerApp({
        actions: { "shop.guarded": guarded },
        middleware: [reject],
        players: inertPlayers,
      }),
    );
    // A plain error is internal: the caller gets the masked error, and only
    // onError sees the original.
    const rejection = await rejectionOf<{ name: string; message: string; cause?: unknown }>(
      app.dispatch("shop.guarded", { player: caller }, undefined),
    );
    expect(rejection.name).toBe("ActionInternalError");
    expect(rejection.message).toBe("internal error");
    expect(runs.count).toBe(0);
    // Retired Node runtime: also kept the original error as the rejection's `cause`.
    expect(rejection.cause).toBeUndefined();
  });

  it("does not reach middleware when the rate limit rejects first", async () => {
    const seen = { count: 0 };
    const counting: ActionMiddleware = async (_info, nextInvoke) => {
      seen.count += 1;
      return nextInvoke();
    };
    const app = track(
      createServerApp({
        actions: { "shop.buy": buy },
        defaultRateLimit: { key: "player", windowMs: 1000, max: 1 },
        middleware: [counting],
        players: inertPlayers,
      }),
    );

    const ctx = { player: { name: "Ada" } };
    const first = await app.dispatch("shop.buy", ctx, { itemId: "sword" });
    expect(first).toEqual({ ok: true });
    await expect(app.dispatch("shop.buy", ctx, { itemId: "sword" })).rejects.toThrow(
      "rate limited",
    );
    expect(seen.count).toBe(1);
  });
});

describe("createServerApp onError", () => {
  afterEach(() => disposeTracked());

  it("observes run errors before they propagate", async () => {
    const boom = defineAction({
      id: "shop.boom",
      run(): { ok: boolean } {
        throw { name: "Error", message: "kaboom" };
      },
    });
    const calls = new Array<ErrorCall>();

    const app = track(
      createServerApp({
        actions: { "shop.boom": boom },
        onError: (reason, info) => {
          calls.push({ failure: reason, info });
        },
        players: inertPlayers,
      }),
    );
    const rejection = await rejectionOf<{ name: string; errorId?: string }>(
      app.dispatch("shop.boom", { player: caller }, undefined),
    );
    expect(rejection.name).toBe("ActionInternalError");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    // onError gets the original, and the id the masked error carries.
    expect((call.failure as { message: string }).message).toBe("kaboom");
    expect(call.info.actionId).toBe("shop.boom");
    const errorId = call.info.errorId;
    expect(typeIs(errorId, "string")).toBe(true);
    // /^[0-9a-f]{8}$/
    expect((errorId as string).size()).toBe(8);
    const [hex] = (errorId as string).match("^[0-9a-f]+$");
    expect(hex).toBe(errorId);
    expect(rejection.errorId).toBe(errorId);
  });

  it("passes an actionError through with its own name and message", async () => {
    const soldOut = defineAction({
      id: "shop.soldOut",
      run(): { ok: boolean } {
        throw actionError("OutOfStock", "Item is sold out");
      },
    });
    const calls = new Array<ErrorCall>();

    const app = track(
      createServerApp({
        actions: { "shop.soldOut": soldOut },
        onError: (reason, info) => {
          calls.push({ failure: reason, info });
        },
        players: inertPlayers,
      }),
    );
    const rejection = await rejectionOf<{ name: string; message: string }>(
      app.dispatch("shop.soldOut", { player: caller }, undefined),
    );
    expect(rejection.name).toBe("OutOfStock");
    expect(rejection.message).toBe("Item is sold out");
    // A public error needs no id to be matched up: the client already has it.
    expect(calls[0]!.info).toEqual({ actionId: "shop.soldOut", player: caller });
  });

  it("rethrows the original error when exposeInternalErrors is set", async () => {
    const boom = defineAction({
      id: "shop.boom",
      run(): { ok: boolean } {
        throw { name: "Error", message: "kaboom" };
      },
    });
    const calls = new Array<ErrorCall>();

    const app = track(
      createServerApp({
        actions: { "shop.boom": boom },
        onError: (reason, info) => {
          calls.push({ failure: reason, info });
        },
        exposeInternalErrors: true,
        players: inertPlayers,
      }),
    );
    await expect(app.dispatch("shop.boom", { player: caller }, undefined)).rejects.toThrow(
      "kaboom",
    );
    expect(typeIs(calls[0]!.info.errorId, "string")).toBe(true);
  });

  it("is not called for input validation failures", async () => {
    const calls = { count: 0 };
    const app = track(
      createServerApp({
        actions: { "shop.buy": buy },
        onError: () => {
          calls.count += 1;
        },
        players: inertPlayers,
      }),
    );

    await expect(app.dispatch("shop.buy", { player: caller }, { itemId: 5 })).rejects.toThrow(
      "validation failed",
    );
    expect(calls.count).toBe(0);
  });
});
