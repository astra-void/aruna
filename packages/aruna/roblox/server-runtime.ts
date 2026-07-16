// Aruna roblox-ts native runtime — server action registry and dispatch.

import type { ActionContext, ActionDefinition, ActionRateLimitOptions } from "./server";
import { firstSchemaIssue, type Schema } from "./schema";
import type { SignalMap, SignalPublisher } from "./signal-runtime";
import { createActionRateLimiter, resolveRateLimitKey } from "./rate-limit";
import { isWireSafe } from "./serialization";

export interface ActionDispatchResult {
	readonly ok: boolean;
	readonly output?: unknown;
	readonly error?: string;
	// Structured error metadata alongside the message, so the client can
	// discriminate failures (and back off on rate limits) instead of string
	// matching: "ActionRateLimitError" | "ActionValidationError" |
	// "ActionSerializationError" | a thrown table's own `name`.
	readonly errorName?: string;
	readonly retryAfterMs?: number;
	readonly resetAtMs?: number;
}

export interface ActionRegistry<TPlayer = unknown> {
	readonly dispatch: (
		player: TPlayer,
		actionId: string,
		input: unknown,
	) => Promise<ActionDispatchResult>;
	// True when the action is declared `fireAndForget` (one-way). The transport
	// binder uses this to decide whether to send a response back to the client.
	// Unknown action ids return false.
	readonly isFireAndForget: (actionId: string) => boolean;
}

type AnyActionDefinition<TPlayer> = ActionDefinition<Schema | undefined, Schema | undefined, TPlayer>;

export type ActionMap<TPlayer> = { readonly [actionId: string]: AnyActionDefinition<TPlayer> };

// Around-run middleware. Runs after input validation and rate limiting (so a
// throttled or malformed request never reaches it) and wraps the action's `run`.
// Short-circuit by rejecting (or by not calling `next`); observe/transform by
// awaiting `next()`. Mirrors the Node reference runtime's ActionMiddleware.
export type ActionMiddleware<TPlayer = unknown> = (
	info: {
		readonly actionId: string;
		readonly ctx: ActionContext<TPlayer>;
		readonly input: unknown;
	},
	next: () => Promise<unknown>,
) => Promise<unknown>;

// Observability hook for errors raised from the action execution chain
// (middleware or `run`), called before dispatch converts the error into the
// `{ ok: false }` wire result.
export type ActionErrorHandler<TPlayer = unknown> = (
	error: unknown,
	info: {
		readonly actionId: string;
		readonly player: TPlayer;
	},
) => void;

export interface ActionRegistryOptions<TPlayer = unknown> {
	// Applied to any action that does not declare its own `rateLimit`. A
	// per-action `rateLimit` always takes precedence over this fallback.
	readonly defaultRateLimit?: ActionRateLimitOptions;
	// The app-owned signal publisher, injected into every action ctx so `run` can
	// publish signals. Carried registry- and player-erased (`unknown`) — the precise
	// typing lives on the action ctx via `createActionDefiner`; dispatch only
	// forwards it.
	readonly publisher?: SignalPublisher<SignalMap, unknown>;
	// Around-run middleware, applied outermost-first to every action.
	readonly middleware?: readonly ActionMiddleware<TPlayer>[];
	readonly onError?: ActionErrorHandler<TPlayer>;
}

export function createActionRegistry<TPlayer>(
	actions: ActionMap<TPlayer>,
	options?: ActionRegistryOptions<TPlayer>,
): ActionRegistry<TPlayer> {
	const actionsById = new Map<string, AnyActionDefinition<TPlayer>>();
	for (const [actionId, definition] of pairs(
		actions as { [key: string]: AnyActionDefinition<TPlayer> },
	)) {
		actionsById.set(actionId as string, definition);
	}

	const defaultRateLimit = options?.defaultRateLimit;
	const publisher = options?.publisher;
	const middleware = options?.middleware;
	const onError = options?.onError;
	const rateLimiter = createActionRateLimiter();

	return {
		isFireAndForget: (actionId) => actionsById.get(actionId)?.fireAndForget === true,
		dispatch: (player, actionId, input) => {
			return new Promise<ActionDispatchResult>((resolve) => {
				const definition = actionsById.get(actionId);
				if (definition === undefined) {
					resolve({ ok: false, error: `unknown action: ${actionId}` });
					return;
				}

				// Reject non-wire-safe input before validation or user code runs.
				if (!isWireSafe(input)) {
					resolve({
						ok: false,
						error: "non-serializable action input",
						errorName: "ActionSerializationError",
					});
					return;
				}

				const inputSchema = definition.input;
				if (inputSchema !== undefined && !inputSchema.validate(input)) {
					// The boolean validate stays the cheap gate; the metadata walk runs
					// only on failure to attach the first failing path + reason.
					const issue = firstSchemaIssue(inputSchema, input);
					resolve({
						ok: false,
						error:
							issue !== undefined ? `invalid action input: ${issue}` : "invalid action input",
						errorName: "ActionValidationError",
					});
					return;
				}

				// A per-action `rateLimit` always wins; otherwise fall back to the
				// registry-wide default. Only when neither is present is the action
				// left unthrottled.
				const rateLimit = definition.rateLimit ?? defaultRateLimit;
				if (rateLimit !== undefined) {
					const limitKey = resolveRateLimitKey(rateLimit, player);
					const limitResult = rateLimiter.check(actionId, limitKey, rateLimit);
					if (!limitResult.ok) {
						resolve({
							ok: false,
							error: `Aruna action ${actionId} is rate limited. Retry after ${limitResult.retryAfterMs}ms.`,
							errorName: "ActionRateLimitError",
							retryAfterMs: limitResult.retryAfterMs,
							resetAtMs: limitResult.resetAtMs,
						});
						return;
					}
				}

				const context: ActionContext<TPlayer> =
					publisher !== undefined ? { player, publisher } : { player };

				// Invoke the handler inside a pcall so a *synchronous* throw becomes
				// a result payload rather than rejecting the dispatch promise. A
				// rejection would leave the transport's `.then` success handler
				// unfired and the client waiting forever for a response.
				const runAction = (): Promise<unknown> => {
					const [invoked, runResult] = pcall(() => definition.run(context, input as never));
					if (!invoked) {
						return Promise.reject(runResult);
					}
					return Promise.resolve(runResult);
				};

				// Compose middleware outermost-first around the run: middleware[0]
				// is the outermost layer, `runAction` the innermost `next`. Each
				// layer call is routed through a resolved promise so a synchronous
				// throw inside a layer becomes a rejection, not an unhandled error.
				let invoke = runAction;
				if (middleware !== undefined) {
					const info = { actionId, ctx: context, input };
					for (let index = middleware.size() - 1; index >= 0; index -= 1) {
						const layer = middleware[index];
						if (layer === undefined) {
							continue;
						}
						const nextInvoke = invoke;
						invoke = () => Promise.resolve().then(() => layer(info, nextInvoke));
					}
				}

				invoke().then(
					(output) => {
						if (!isWireSafe(output)) {
							resolve({
								ok: false,
								error: "non-serializable action output",
								errorName: "ActionSerializationError",
							});
							return;
						}
						resolve({ ok: true, output });
					},
					(reason) => {
						if (onError !== undefined) {
							onError(reason, { actionId, player });
						}
						// A thrown table with `name`/`message` string fields keeps its
						// identity across the wire; anything else is stringified.
						const asRecord = typeIs(reason, "table")
							? (reason as { name?: unknown; message?: unknown })
							: undefined;
						const reasonName =
							asRecord !== undefined && typeIs(asRecord.name, "string")
								? asRecord.name
								: undefined;
						const reasonMessage =
							asRecord !== undefined && typeIs(asRecord.message, "string")
								? asRecord.message
								: tostring(reason);
						resolve({
							ok: false,
							error: reasonMessage,
							...(reasonName !== undefined ? { errorName: reasonName } : {}),
						});
					},
				);
			});
		},
	};
}
