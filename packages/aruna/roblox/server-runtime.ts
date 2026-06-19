// Aruna roblox-ts native runtime — server action registry and dispatch.

import type { ActionContext, ActionDefinition } from "./server";
import type { Schema } from "./schema";

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

	return {
		dispatch: (player, actionId, input) => {
			return new Promise<ActionDispatchResult>((resolve) => {
				const definition = actionsById.get(actionId);
				if (definition === undefined) {
					resolve({ ok: false, error: `unknown action: ${actionId}` });
					return;
				}

				const inputSchema = definition.input;
				if (inputSchema !== undefined && !inputSchema.validate(input)) {
					resolve({ ok: false, error: "invalid action input" });
					return;
				}

				const context: ActionContext<TPlayer> = { player };
				Promise.resolve(definition.run(context, input as never)).then(
					(output) => resolve({ ok: true, output }),
					(reason) => resolve({ ok: false, error: tostring(reason) }),
				);
			});
		},
	};
}
