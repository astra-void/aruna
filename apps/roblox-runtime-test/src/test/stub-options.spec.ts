// Generated stubs forward a call's options to the invoker, with what the action
// declares spread over them. The three stubs below are the shapes codegen emits
// (crates/aruna_compiler/src/codegen.rs, `client_stub_lines`) for a plain, an
// idempotent, and a fire-and-forget action; no harness compiles the last two.
import { clearActionInvoker, invokeAction, setActionInvoker, type ActionInvokeOptions } from "aruna/client";
import { afterEach, describe, expect, it } from "aruna/testing";

const look = (input?: number, options?: ActionInvokeOptions): Promise<void> => {
  return invokeAction("shop.look", input, options) as Promise<void>;
};
const claim = (input?: number, options?: ActionInvokeOptions): Promise<void> => {
  return invokeAction("quest.claim", input, { ...options, idempotent: true }) as Promise<void>;
};
const paint = (input?: number, options?: ActionInvokeOptions): Promise<void> => {
  return invokeAction("spray.paint", input, { ...options, fireAndForget: true }) as Promise<void>;
};

function recordCalls() {
  const calls = new Array<{ readonly actionId: string; readonly options: ActionInvokeOptions }>();
  setActionInvoker((actionId, _input, options) => {
    calls.push({ actionId, options: options ?? {} });
    return Promise.resolve(undefined);
  });
  return calls;
}

describe("generated stub options", () => {
  afterEach(() => {
    clearActionInvoker();
  });

  it("forwards a call's options, and none when the call has none", async () => {
    const calls = recordCalls();
    await look(1);
    await look(1, { idempotencyKey: "click-1" });
    expect(calls[0]!.options.idempotencyKey).toBeUndefined();
    expect(calls[1]!.options.idempotencyKey).toBe("click-1");
  });

  it("keeps what the action declares, over whatever the call passes", async () => {
    const calls = recordCalls();
    await claim(1);
    await claim(1, { idempotencyKey: "claim-1", idempotent: false });
    await paint(1, { fireAndForget: false });
    expect(calls[0]!.options.idempotent).toBe(true);
    expect(calls[1]!.options.idempotent).toBe(true);
    expect(calls[1]!.options.idempotencyKey).toBe("claim-1");
    expect(calls[2]!.options.fireAndForget).toBe(true);
  });
});
