// Declared action errors: `errors` on defineAction, `ctx.fail(name, data)` in
// `run`, the server checking an error of a declared name against its
// declaration before the client sees it, and `isActionError` narrowing a
// rejection by name.
import { createActionInvoker, defineAction, robloxRemoteEvent } from "aruna/roblox";
import { isActionError, type ActionStub } from "aruna/client";
import { schema } from "aruna/schema";
import { actionError, createServerApp, type ActionMiddleware } from "aruna/server";
import { afterEach, describe, expect, it } from "aruna/testing";
import { rejectionOf, wireRemote } from "./support";

// A players source that never fires, so these apps do not subscribe to the
// shared fake Players service.
const inertPlayers = {
  PlayerRemoving: {
    Connect: (_callback: (player: unknown) => void) => ({ Disconnect: () => undefined }),
  },
};

const caller = { name: "Caller" };

type Fields = { [key: string]: unknown };

const cleanups = new Array<() => void>();
function track<T extends { readonly dispose: () => void }>(disposable: T): T {
  cleanups.push(() => disposable.dispose());
  return disposable;
}

// The action under test: `mode` picks what `run` does.
function buyAction() {
  return defineAction({
    id: "shop.buy",
    input: schema.object({ mode: schema.string().maxLength(16) }),
    errors: {
      OutOfStock: { data: schema.object({ itemId: schema.string(), restockIn: schema.u16() }) },
      NotEnoughCoins: {},
    },
    run(ctx, input) {
      if (input.mode === "stock") {
        throw ctx.fail("OutOfStock", { itemId: "sword", restockIn: 30 });
      }
      if (input.mode === "coins") {
        throw ctx.fail("NotEnoughCoins");
      }
      if (input.mode === "nan-data") {
        // Typed fine, but NaN cannot cross the wire.
        throw ctx.fail("OutOfStock", { itemId: "sword", restockIn: 0 / 0 });
      }
      // What only a cast lets through: the wrong data, data for an error that
      // declares none, and a name that is not declared.
      const fail = ctx.fail as unknown as (name: string, data?: unknown) => never;
      if (input.mode === "bad-data") {
        throw fail("OutOfStock", { itemId: 42, restockIn: 30 });
      }
      if (input.mode === "extra-data") {
        throw fail("NotEnoughCoins", { reason: "poor" });
      }
      if (input.mode === "undeclared") {
        throw fail("Banned");
      }
      return undefined;
    },
  });
}

function setup(options: { readonly middleware?: readonly ActionMiddleware<unknown>[] } = {}) {
  const reported = new Array<{ readonly error: unknown; readonly errorId?: string }>();
  const app = track(
    createServerApp({
      actions: { "shop.buy": buyAction() },
      players: inertPlayers,
      ...(options.middleware !== undefined ? { middleware: options.middleware } : {}),
      onError: (err, info) => {
        reported.push({ error: err, ...(info.errorId !== undefined ? { errorId: info.errorId } : {}) });
      },
    }),
  );
  return {
    app,
    reported,
    dispatch: (mode: string) => rejectionOf<Fields>(app.dispatch("shop.buy", { player: caller }, { mode })),
  };
}

describe("declared action errors", () => {
  afterEach(() => {
    for (const cleanup of cleanups) {
      cleanup();
    }
    cleanups.clear();
  });

  it("sends a declared error with its name and data", async () => {
    const { dispatch, reported } = setup();

    expect(await dispatch("stock")).toEqual({
      name: "OutOfStock",
      message: "OutOfStock",
      data: { itemId: "sword", restockIn: 30 },
    });
    expect(await dispatch("coins")).toEqual({ name: "NotEnoughCoins", message: "NotEnoughCoins" });
    // Public, so onError sees it with no errorId.
    expect(reported.size()).toBe(2);
    expect(reported[0]?.errorId).toBe(undefined);
  });

  it("masks a declared error whose data does not match, and reports the mismatch", async () => {
    const { dispatch, reported } = setup();

    const refused = await dispatch("bad-data");
    expect(refused["name"]).toBe("ActionInternalError");
    expect(refused["data"]).toBe(undefined);
    expect(typeIs(refused["errorId"], "string")).toBe(true);
    const reportedError = reported[0]?.error as Fields;
    expect(reportedError["name"]).toBe("ActionValidationError");
    expect(reportedError["message"]).toBe(
      "Aruna action shop.buy error OutOfStock data validation failed: itemId: expected string",
    );
    expect(reported[0]?.errorId).toBe(refused["errorId"]);
  });

  it("masks a declared error whose data cannot cross the wire", async () => {
    const { dispatch, reported } = setup();

    const refused = await dispatch("nan-data");
    expect(refused["name"]).toBe("ActionInternalError");
    expect(refused["data"]).toBe(undefined);
    const reportedError = reported[0]?.error as Fields;
    expect(reportedError["name"]).toBe("ActionSerializationError");
    expect(reportedError["message"]).toBe("Aruna action shop.buy error OutOfStock data is not serializable");
  });

  it("masks data on an error declared without, and a name that is not declared", async () => {
    const { dispatch, reported } = setup();

    expect((await dispatch("extra-data"))["name"]).toBe("ActionInternalError");
    expect((await dispatch("undeclared"))["name"]).toBe("ActionInternalError");
    expect(reported.map((entry) => (entry.error as Fields)["message"])).toEqual([
      "Aruna action shop.buy error NotEnoughCoins declares no data",
      "Aruna action shop.buy error Banned is not declared in its errors",
    ]);
  });

  it("holds an actionError of a declared name to the declaration too", async () => {
    // Middleware refusing with a declared name: fine without data when the
    // declaration has none, masked when it promises data.
    const coins: ActionMiddleware<unknown> = () => {
      throw actionError("NotEnoughCoins", "come back richer");
    };
    const stock: ActionMiddleware<unknown> = () => {
      throw actionError("OutOfStock", "sold out");
    };
    const ad: ActionMiddleware<unknown> = () => {
      throw actionError("Maintenance", "back soon");
    };

    expect(await setup({ middleware: [coins] }).dispatch("ok")).toEqual({
      name: "NotEnoughCoins",
      message: "come back richer",
    });
    expect((await setup({ middleware: [stock] }).dispatch("ok"))["name"]).toBe("ActionInternalError");
    // A name the action does not declare goes out untyped, as before.
    expect(await setup({ middleware: [ad] }).dispatch("ok")).toEqual({
      name: "Maintenance",
      message: "back soon",
    });
  });

  it("carries the data over the wire, and the client invoker surfaces it", async () => {
    track(createServerApp({ actions: { "shop.buy": buyAction() }, transport: robloxRemoteEvent() }));
    const wire = wireRemote();
    cleanups.push(() => wire.dispose());

    await wire.send("request-1", "shop.buy", { mode: "stock" });
    expect(wire.responses()[0]?.result).toEqual({
      ok: false,
      error: "OutOfStock",
      errorName: "OutOfStock",
      errorData: { itemId: "sword", restockIn: 30 },
    });

    const invoke = createActionInvoker();
    const buy = ((input: { mode: string }) => invoke("shop.buy", input)) as ActionStub<
      { mode: string },
      void,
      { readonly OutOfStock: { itemId: string; restockIn: number }; readonly NotEnoughCoins: undefined }
    >;
    const rejection = await rejectionOf<unknown>(buy({ mode: "stock" }));
    expect(isActionError(rejection, buy, "OutOfStock")).toBe(true);
    expect(isActionError(rejection, buy, "NotEnoughCoins")).toBe(false);
    if (isActionError(rejection, buy, "OutOfStock")) {
      expect(rejection.data.restockIn).toBe(30);
    }
  });
});
