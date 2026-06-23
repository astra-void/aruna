// Aruna roblox-ts native runtime — server action registry and dispatch.

import type { ActionContext, ActionDefinition, ActionRateLimitOptions } from "./server";
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

export interface ActionRegistryOptions {
	// Applied to any action that does not declare its own `rateLimit`. A
	// per-action `rateLimit` always takes precedence over this fallback.
	readonly defaultRateLimit?: ActionRateLimitOptions;
}

export function createActionRegistry<TPlayer>(
	actions: ActionMap<TPlayer>,
	options?: ActionRegistryOptions,
): ActionRegistry<TPlayer> {
	const actionsById = new Map<string, AnyActionDefinition<TPlayer>>();
	for (const [actionId, definition] of pairs(
		actions as { [key: string]: AnyActionDefinition<TPlayer> },
	)) {
		actionsById.set(actionId as string, definition);
	}

	const defaultRateLimit = options?.defaultRateLimit;
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

				// A per-action `rateLimit` always wins; otherwise fall back to the
				// registry-wide default. Only when neither is present is the action
				// left unthrottled.
				const rateLimit = definition.rateLimit ?? defaultRateLimit;
				if (rateLimit !== undefined) {
					const limitKey = resolveRateLimitKey(rateLimit, player);
					if (!rateLimiter.check(actionId, limitKey, rateLimit)) {
						resolve({ ok: false, error: "rate limit exceeded" });
						return;
					}
				}

				const context: ActionContext<TPlayer> = { player };

				// Invoke the handler inside a pcall so a *synchronous* throw becomes
				// a result payload rather than rejecting the dispatch promise. A
				// rejection would leave the transport's `.then` success handler
				// unfired and the client waiting forever for a response.
				const [invoked, runResult] = pcall(() => definition.run(context, input as never));
				if (!invoked) {
					resolve({ ok: false, error: tostring(runResult) });
					return;
				}

				Promise.resolve(runResult).then(
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
