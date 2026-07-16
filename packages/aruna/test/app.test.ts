import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearActionInvoker, invokeAction } from "../src/client.js";
import { createClientApp } from "../src/client.js";
import { createServerApp } from "../src/server.js";
import { schema } from "../src/schema.js";
import { defineAction } from "../src/server.js";

beforeEach(() => {
  clearActionInvoker();
});

afterEach(() => {
  clearActionInvoker();
});

describe("createClientApp", () => {
  it("installs an invoker used by invokeAction", async () => {
    const app = createClientApp({
      transport: async (actionId, input) => {
        return { actionId, input };
      },
    });

    await expect(invokeAction("shop.purchaseItem", { itemId: "sword" })).resolves.toEqual({
      actionId: "shop.purchaseItem",
      input: { itemId: "sword" },
    });

    app.dispose();
  });

  it("clears the invoker when disposed", async () => {
    const app = createClientApp({
      transport: async () => {
        return { ok: true };
      },
    });

    app.dispose();

    await expect(invokeAction("shop.purchaseItem", { itemId: "sword" })).rejects.toThrowError(
      /Aruna action invoker is not installed; cannot invoke "shop.purchaseItem"/,
    );
  });

  it("can be disposed twice safely", async () => {
    const app = createClientApp({
      transport: async () => {
        return { ok: true };
      },
    });

    app.dispose();
    app.dispose();

    await expect(invokeAction("shop.purchaseItem", { itemId: "sword" })).rejects.toThrowError(
      /Aruna action invoker is not installed; cannot invoke "shop.purchaseItem"/,
    );
  });
});

describe("createServerApp", () => {
  it("exposes the action registry", () => {
    const actions = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run() {
          return { ok: true };
        },
      }),
    };

    const app = createServerApp({ actions });

    expect(app.actions).toBe(actions);
  });

  it("dispatch validates input and calls the action through dispatchAction", async () => {
    const run = vi.fn(() => {
      return { ok: true };
    });
    const actions = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        input: schema.object({
          itemId: schema.string(),
        }),
        run,
      }),
    };
    const app = createServerApp({ actions });

    await expect(app.dispatch("shop.purchaseItem", {}, { itemId: 123 })).rejects.toThrowError(
      "Aruna action shop.purchaseItem input validation failed: itemId: expected string",
    );

    expect(run).not.toHaveBeenCalled();
  });

  it("accepts a transport that returns nothing", () => {
    const actions = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run() {
          return { ok: true };
        },
      }),
    };
    let called = 0;

    const app = createServerApp({
      actions,
      transport: () => {
        called += 1;
      },
    });

    expect(called).toBe(1);

    app.dispose();
    app.dispose();
  });

  it("accepts a transport that returns a cleanup function", () => {
    const actions = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run() {
          return { ok: true };
        },
      }),
    };
    let cleaned = 0;

    const app = createServerApp({
      actions,
      transport: () => () => {
        cleaned += 1;
      },
    });

    app.dispose();

    expect(cleaned).toBe(1);
  });

  it("accepts a transport that returns a disposable object", () => {
    const actions = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run() {
          return { ok: true };
        },
      }),
    };
    let cleaned = 0;

    const app = createServerApp({
      actions,
      transport: () => ({
        dispose() {
          cleaned += 1;
        },
      }),
    });

    app.dispose();

    expect(cleaned).toBe(1);
  });

  it("makes the owned transport dispose idempotent", () => {
    const actions = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        run() {
          return { ok: true };
        },
      }),
    };
    let cleaned = 0;

    const app = createServerApp({
      actions,
      transport: () => () => {
        cleaned += 1;
      },
    });

    app.dispose();
    app.dispose();

    expect(cleaned).toBe(1);
  });
});

describe("in-process round-trip", () => {
  it("connects a generated-style stub, client app, server app, and schema validation", async () => {
    const actions = {
      "shop.purchaseItem": defineAction({
        id: "shop.purchaseItem",
        input: schema.object({
          itemId: schema.string(),
        }),
        output: schema.object({
          ok: schema.boolean(),
        }),
        run(_ctx, input) {
          return { ok: true, input };
        },
      }),
    };

    const serverApp = createServerApp({ actions });
    const clientApp = createClientApp({
      transport: (actionId, input) =>
        serverApp.dispatch(actionId, { player: { name: "Ada" } }, input),
    });
    const purchaseItem = (input: { itemId: string }): Promise<unknown> => {
      return invokeAction("shop.purchaseItem", input);
    };

    await expect(purchaseItem({ itemId: "sword" })).resolves.toEqual({
      ok: true,
      input: { itemId: "sword" },
    });

    await expect(invokeAction("shop.purchaseItem", { itemId: 123 })).rejects.toThrowError(
      "Aruna action shop.purchaseItem input validation failed: itemId: expected string",
    );

    clientApp.dispose();
    serverApp.dispose();
  });
});
