import { dispatchAction, type ActionRegistry, type ActionRunContext } from "./server.js";
import type { ActionInvoker } from "./client.js";

export function createInMemoryActionInvoker<TPlayer = unknown>(
  registry: ActionRegistry<TPlayer>,
  ctx?: ActionRunContext<TPlayer>,
): ActionInvoker {
  const context = ctx ?? {};

  return async (actionId: string, input: unknown): Promise<unknown> => {
    return await dispatchAction(registry, actionId, context, input);
  };
}
