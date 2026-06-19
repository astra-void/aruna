// Aruna roblox-ts native runtime — client action invoker registry.

export type ActionInvoker = (actionId: string, input: unknown) => Promise<unknown>;

let activeInvoker: ActionInvoker | undefined;

export function setActionInvoker(invoker: ActionInvoker): void {
	activeInvoker = invoker;
}

export function clearActionInvoker(): void {
	activeInvoker = undefined;
}

export function invokeAction(actionId: string, input: unknown): Promise<unknown> {
	const invoker = activeInvoker;
	if (invoker === undefined) {
		throw `Aruna action runtime is not installed: ${actionId}`;
	}
	return invoker(actionId, input);
}
