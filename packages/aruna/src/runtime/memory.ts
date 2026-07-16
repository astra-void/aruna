import { dispatchAction, type ActionRegistry, type ActionRunContext } from "./server.js";
import type { ActionInvoker } from "./client.js";

// Internal/test helper: dispatches actions in-process with a fixed context.
// Not part of the public surface — consumer tests should use
// `createServerApp(...).dispatch` (see docs/actions.md "Testing without a
// transport") or the Lune harness for compiled roblox-ts modules.
export function createInMemoryActionInvoker<TPlayer = unknown>(
  registry: ActionRegistry<TPlayer>,
  ctx: ActionRunContext<TPlayer>,
): ActionInvoker {
  return async (actionId: string, input: unknown): Promise<unknown> => {
    return await dispatchAction(registry, actionId, ctx, input);
  };
}
