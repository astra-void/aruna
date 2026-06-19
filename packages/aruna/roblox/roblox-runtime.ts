// Aruna roblox-ts native runtime — default RemoteEvent action transport.

import type { ActionInvoker } from "./client-runtime";
import type { ActionRegistry } from "./server-runtime";
import type { ServerAppBinding } from "./server-app";

const ACTION_REMOTE_NAME = "ArunaActionRemoteEvent";

interface ActionResponsePayload {
	readonly ok: boolean;
	readonly output?: unknown;
	readonly error?: string;
}

function getReplicatedStorage(): ReplicatedStorage {
	return game.GetService("ReplicatedStorage");
}

function ensureServerActionRemote(): RemoteEvent {
	const storage = getReplicatedStorage();
	const existing = storage.FindFirstChild(ACTION_REMOTE_NAME);
	if (existing !== undefined && existing.IsA("RemoteEvent")) {
		return existing;
	}

	const remote = new Instance("RemoteEvent");
	remote.Name = ACTION_REMOTE_NAME;
	remote.Parent = storage;
	return remote;
}

function waitForClientActionRemote(): RemoteEvent {
	const storage = getReplicatedStorage();
	return storage.WaitForChild(ACTION_REMOTE_NAME) as RemoteEvent;
}

let requestCounter = 0;
function defaultRequestId(): string {
	requestCounter += 1;
	return `aruna-${requestCounter}`;
}

export interface CreateDefaultRobloxActionInvokerOptions {
	readonly createRequestId?: () => string;
}

export function createDefaultRobloxActionInvoker(
	options?: CreateDefaultRobloxActionInvokerOptions,
): ActionInvoker {
	const remote = waitForClientActionRemote();
	const createRequestId =
		options !== undefined && options.createRequestId !== undefined
			? options.createRequestId
			: defaultRequestId;
	const pending = new Map<string, (payload: ActionResponsePayload) => void>();

	remote.OnClientEvent.Connect((requestId: string, payload: ActionResponsePayload) => {
		const resolver = pending.get(requestId);
		if (resolver !== undefined) {
			pending.delete(requestId);
			resolver(payload);
		}
	});

	return (actionId, input) => {
		return new Promise<unknown>((resolve, reject) => {
			const requestId = createRequestId();
			pending.set(requestId, (payload) => {
				if (payload.ok) {
					resolve(payload.output);
				} else {
					reject(payload.error !== undefined ? payload.error : "action failed");
				}
			});
			remote.FireServer(requestId, actionId, input);
		});
	};
}

export function bindDefaultRobloxActionRemoteEvent<TPlayer>(
	registry: ActionRegistry<TPlayer>,
): ServerAppBinding {
	const remote = ensureServerActionRemote();
	const connection = remote.OnServerEvent.Connect((player: Player, ...args: Array<unknown>) => {
		const requestId = args[0] as string;
		const actionId = args[1] as string;
		const input = args[2];
		void registry.dispatch(player as unknown as TPlayer, actionId, input).then((result) => {
			remote.FireClient(player, requestId, result);
		});
	});

	return {
		disconnect: () => {
			connection.Disconnect();
		},
	};
}
