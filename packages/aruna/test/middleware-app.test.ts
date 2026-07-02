// Coverage for createServerApp({ middleware, onError }): the around-run
// middleware chain (outermost-first, inside rate limiting and input validation)
// and the error observability hook.
import { describe, expect, it, vi } from "vitest";
import { createServerApp, defineAction, type ActionMiddleware } from "../src/server.js";
import { schema } from "../src/schema.js";

const buy = defineAction({
  id: "shop.buy",
  input: schema.object({ itemId: schema.string() }),
  output: schema.object({ ok: schema.boolean() }),
  run: () => ({ ok: true }),
});

describe("createServerApp middleware", () => {
  it("wraps the run outermost-first and can observe input and output", async () => {
    const order: string[] = [];
    const outer: ActionMiddleware = async (info, next) => {
      order.push(`outer:${info.actionId}`);
      const output = await next();
      order.push("outer:done");
      return output;
    };
    const inner: ActionMiddleware = async (_info, next) => {
      order.push("inner");
      return next();
    };

    const app = createServerApp({ actions: { "shop.buy": buy }, middleware: [outer, inner] });
    await expect(app.dispatch("shop.buy", {}, { itemId: "sword" })).resolves.toEqual({
      ok: true,
    });
    expect(order).toEqual(["outer:shop.buy", "inner", "outer:done"]);
  });

  it("short-circuits when a middleware throws, without running the action", async () => {
    const run = vi.fn(() => ({ ok: true }));
    const guarded = defineAction({
      id: "shop.guarded",
      output: schema.object({ ok: schema.boolean() }),
      run,
    });
    const reject: ActionMiddleware = async () => {
      throw new Error("not authorized");
    };

    const app = createServerApp({ actions: { "shop.guarded": guarded }, middleware: [reject] });
    await expect(app.dispatch("shop.guarded", {}, undefined)).rejects.toThrowError(
      "not authorized",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("does not reach middleware when the rate limit rejects first", async () => {
    const seen = vi.fn(async (_info: unknown, next: () => Promise<unknown>) => next());
    const app = createServerApp({
      actions: { "shop.buy": buy },
      defaultRateLimit: { key: "player", windowMs: 1000, max: 1 },
      middleware: [seen],
    });

    const ctx = { player: { name: "Ada" } };
    await expect(app.dispatch("shop.buy", ctx, { itemId: "sword" })).resolves.toEqual({
      ok: true,
    });
    await expect(app.dispatch("shop.buy", ctx, { itemId: "sword" })).rejects.toThrowError(
      /rate limited/,
    );
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe("createServerApp onError", () => {
  it("observes run errors before they propagate", async () => {
    const boom = defineAction({
      id: "shop.boom",
      run: () => {
        throw new Error("kaboom");
      },
    });
    const onError = vi.fn();

    const app = createServerApp({ actions: { "shop.boom": boom }, onError });
    await expect(app.dispatch("shop.boom", {}, undefined)).rejects.toThrowError("kaboom");
    expect(onError).toHaveBeenCalledTimes(1);
    const [error, info] = onError.mock.calls[0] as [unknown, { actionId: string }];
    expect((error as Error).message).toBe("kaboom");
    expect(info.actionId).toBe("shop.boom");
  });

  it("is not called for input validation failures", async () => {
    const onError = vi.fn();
    const app = createServerApp({ actions: { "shop.buy": buy }, onError });

    await expect(app.dispatch("shop.buy", {}, { itemId: 5 })).rejects.toThrowError(
      /validation failed/,
    );
    expect(onError).not.toHaveBeenCalled();
  });
});
