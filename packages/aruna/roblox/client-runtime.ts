// Aruna roblox-ts native runtime — client action invoker registry.

// Per-call invoke options. `fireAndForget` requests one-way delivery: the
// transport fires the request without waiting for (or expecting) a server ack.
// Generated client stubs for fire-and-forget actions pass `{ fireAndForget:
// true }`; the option is optional so existing two-way invokers are unaffected.
export interface ActionInvokeOptions {
	readonly fireAndForget?: boolean;
}

export type ActionInvoker = (
	actionId: string,
	input: unknown,
	options?: ActionInvokeOptions,
) => Promise<unknown>;

let activeInvoker: ActionInvoker | undefined;

export function setActionInvoker(invoker: ActionInvoker): void {
	activeInvoker = invoker;
}

export function clearActionInvoker(): void {
	activeInvoker = undefined;
}

export function invokeAction(
	actionId: string,
	input: unknown,
	options?: ActionInvokeOptions,
): Promise<unknown> {
	const invoker = activeInvoker;
	if (invoker === undefined) {
		throw `Aruna action runtime is not installed: ${actionId}`;
	}
	return invoker(actionId, input, options);
}
