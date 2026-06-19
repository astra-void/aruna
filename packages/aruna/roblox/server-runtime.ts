// Aruna roblox-ts native runtime — server action registry and dispatch.

import type { ActionContext, ActionDefinition } from "./server";
import type { Schema } from "./schema";
import { createActionRateLimiter, resolveRateLimitKey } from "./rate-limit";
import { isWireSafe } from "./serialization";

export interface ActionDispatchResult {
	readonly ok: boolean;
	readonly output?: unknown;
	readonly error?: string;
}

export interface ActionRegistry<TPlayer = unknown> {
	readonly dispatch: (
		player: TPlayer,
		actionId: string,
		input: unknown,
	) => Promise<ActionDispatchResult>;
}

type AnyActionDefinition<TPlayer> = ActionDefinition<Schema | undefined, Schema | undefined, TPlayer>;

export type ActionMap<TPlayer> = { readonly [actionId: string]: AnyActionDefinition<TPlayer> };

export function createActionRegistry<TPlayer>(actions: ActionMap<TPlayer>): ActionRegistry<TPlayer> {
	const actionsById = new Map<string, AnyActionDefinition<TPlayer>>();
	for (const [actionId, definition] of pairs(
		actions as { [key: string]: AnyActionDefinition<TPlayer> },
	)) {
		actionsById.set(actionId as string, definition);
	}

	const rateLimiter = createActionRateLimiter();

	return {
		dispatch: (player, actionId, input) => {
			return new Promise<ActionDispatchResult>((resolve) => {
				const definition = actionsById.get(actionId);
				if (definition === undefined) {
					resolve({ ok: false, error: `unknown action: ${actionId}` });
					return;
				}

				// Reject non-wire-safe input before validation or user code runs.
				if (!isWireSafe(input)) {
					resolve({ ok: false, error: "non-serializable action input" });
					return;
				}

				const inputSchema = definition.input;
				if (inputSchema !== undefined && !inputSchema.validate(input)) {
					resolve({ ok: false, error: "invalid action input" });
					return;
				}

				const rateLimit = definition.rateLimit;
				if (rateLimit !== undefined) {
					const limitKey = resolveRateLimitKey(rateLimit, player);
					if (!rateLimiter.check(actionId, limitKey, rateLimit)) {
						resolve({ ok: false, error: "rate limit exceeded" });
						return;
					}
				}

				const context: ActionContext<TPlayer> = { player };
				Promise.resolve(definition.run(context, input as never)).then(
					(output) => {
						if (!isWireSafe(output)) {
							resolve({ ok: false, error: "non-serializable action output" });
							return;
						}
						resolve({ ok: true, output });
					},
					(reason) => resolve({ ok: false, error: tostring(reason) }),
				);
			});
		},
	};
}
