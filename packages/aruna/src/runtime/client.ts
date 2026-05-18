export type ActionInvoker = (actionId: string, input: unknown) => Promise<unknown>;

let actionInvoker: ActionInvoker | undefined;

export function setActionInvoker(invoker: ActionInvoker): void {
  actionInvoker = invoker;
}

export function clearActionInvoker(): void {
  actionInvoker = undefined;
}

export async function invokeAction(actionId: string, input: unknown): Promise<unknown> {
  if (actionInvoker === undefined) {
    throw new Error(`Aruna action runtime is not installed: ${actionId}`);
  }

  return await Promise.resolve(actionInvoker(actionId, input));
}
