// Per-call invoke options. `fireAndForget` requests one-way delivery: the
// transport fires the request without waiting for (or expecting) a server ack.
// Generated client stubs for fire-and-forget actions pass `{ fireAndForget:
// true }`; the option is optional so existing two-way invokers are unaffected.
export type ActionInvokeOptions = {
  readonly fireAndForget?: boolean;
};

export type ActionInvoker = (
  actionId: string,
  input: unknown,
  options?: ActionInvokeOptions,
) => Promise<unknown>;

let actionInvoker: ActionInvoker | undefined;

export function setActionInvoker(invoker: ActionInvoker): void {
  actionInvoker = invoker;
}

export function clearActionInvoker(): void {
  actionInvoker = undefined;
}

export async function invokeAction(
  actionId: string,
  input: unknown,
  options?: ActionInvokeOptions,
): Promise<unknown> {
  if (actionInvoker === undefined) {
    throw new Error(`Aruna action runtime is not installed: ${actionId}`);
  }

  return await Promise.resolve(actionInvoker(actionId, input, options));
}
