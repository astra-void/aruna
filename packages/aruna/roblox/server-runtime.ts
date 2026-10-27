// Aruna roblox-ts native runtime — server action registry and dispatch.

import type { ActionContext, ActionDefinition, ActionRateLimitOptions } from "./server";
import type { StoreDocument } from "./player-store";
import { applyDefaults, firstSchemaIssue, type Schema } from "./schema";
import type { SignalMap, SignalPublisher } from "./signal-runtime";
import { createActionRateLimiter, resolveRateLimitKey } from "./rate-limit";
import { isWireSafe } from "./serialization";
import { createIdempotencyCache, isIdempotencyKey } from "./idempotency";
import {
	admitEnvelope,
	createRequestGuard,
	IN_FLIGHT_RETRY_AFTER_MS,
	type RequestAbuseHandler,
	type RequestBudgetOptions,
} from "./request-guard";
import {
	ACTION_INTERNAL_ERROR_MESSAGE,
	ACTION_INTERNAL_ERROR_NAME,
	actionError,
	createErrorId,
	isPublicActionError,
	type PublicActionError,
} from "./action-error";

export interface ActionDispatchResult {
	readonly ok: boolean;
	readonly output?: unknown;
	readonly error?: string;
	// Structured error metadata alongside the message, so the client can
	// discriminate failures (and back off on rate limits) instead of string
	// matching: "ActionRateLimitError" | "ActionValidationError" |
	// "ActionSerializationError" | "ActionNotFoundError" | the name given to
	// `actionError` | "ActionInternalError".
	readonly errorName?: string;
	readonly retryAfterMs?: number;
	readonly resetAtMs?: number;
	// Present on an `ActionInternalError`: the id `onError` was given for the
	// same failure, so a client report can be matched to the server log.
	readonly errorId?: string;
}

export interface ActionRegistry<TPlayer = unknown> {
	// `idempotencyKey` is the key a retrying client sends with every attempt of
	// one call: a valid key (a string of at most 64 characters) makes the action
	// run once however many attempts arrive, and anything else is ignored.
	readonly dispatch: (
		player: TPlayer,
		actionId: string,
		input: unknown,
		idempotencyKey?: unknown,
	) => Promise<ActionDispatchResult>;
	// The transport's gate for one envelope, before it reads the input: the
	// request and action ids must be bounded strings, and the player's request
	// budget must have a token. False means drop the envelope with no response.
	readonly admitEnvelope: (player: TPlayer, requestId: unknown, actionId: unknown) => boolean;
	// Drops what the registry remembers about a player: idempotency keys, the
	// request budget, the in-flight count. `createServerApp` calls it on leave.
	readonly forgetPlayer: (player: TPlayer) => void;
	// True when the action is declared `fireAndForget` (one-way). The transport
	// binder uses this to decide whether to send a response back to the client.
	// Unknown action ids return false.
	readonly isFireAndForget: (actionId: string) => boolean;
}

type AnyActionDefinition<TPlayer> = ActionDefinition<Schema | undefined, Schema | undefined, TPlayer>;

export type ActionMap<TPlayer> = { readonly [actionId: string]: AnyActionDefinition<TPlayer> };

// Around-run middleware. Runs after input validation and rate limiting (so a
// throttled or malformed request never reaches it) and wraps the action's `run`
// plus output validation. Short-circuit by rejecting (or by not calling `next`);
// observe/transform by awaiting `next()`. Mirrors the Node reference runtime's
// ActionMiddleware.
export type ActionMiddleware<TPlayer = unknown> = (
	info: {
		readonly actionId: string;
		readonly ctx: ActionContext<TPlayer>;
		readonly input: unknown;
	},
	next: () => Promise<unknown>,
) => Promise<unknown>;

// Observability hook for errors raised from the action execution chain
// (middleware, `run`, output validation), called before dispatch converts the
// error into the `{ ok: false }` wire result. `error` is the original value,
// never the masked one. `errorId` is set when the client is sent
// `ActionInternalError`, and is the id that response carries.
export type ActionErrorHandler<TPlayer = unknown> = (
	error: unknown,
	info: {
		readonly actionId: string;
		readonly player: TPlayer;
		readonly errorId?: string;
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
	// Resolves the calling player's session, injected into every action ctx as
	// `ctx.session`. Supplied by `createServerApp` from its per-player session
	// store; dispatch only reads it. Returns undefined when the player has no
	// session (no `createSession` configured, or not yet added).
	readonly getSession?: (player: TPlayer) => unknown;
	// Resolves the calling player's open store document, injected as `ctx.store`.
	// Supplied by `createServerApp` from its `playerStore`. Returns undefined
	// while the locked read is in flight or after the document was released.
	readonly getStore?: (player: TPlayer) => StoreDocument<unknown> | undefined;
	// Around-run middleware, applied outermost-first to every action.
	readonly middleware?: readonly ActionMiddleware<TPlayer>[];
	readonly onError?: ActionErrorHandler<TPlayer>;
	// Sends a non-public error's own name and message instead of
	// `ActionInternalError`. Off by default, because a Luau runtime error names
	// the server script and line it came from. `createTestServerApp` turns it on
	// so a spec sees the real failure.
	readonly exposeInternalErrors?: boolean;
	// The clock the rate limiter reads, in milliseconds. Left unset in a game,
	// where os.clock() is the right answer; set by the test harness so a spec can
	// step past a rate-limit window instead of waiting out a real one.
	readonly nowMs?: () => number;
	// The per-player envelope budget and in-flight cap in front of dispatch.
	readonly requestBudget?: RequestBudgetOptions;
	// Told when a player's envelope is dropped (malformed, over budget) or a
	// dispatch is refused for too many in flight. For logging, or a kick.
	readonly onAbuse?: RequestAbuseHandler<TPlayer>;
}

// A schema failure at the action boundary, in the Node runtime's message shape.
// The boolean `validate` stays the cheap gate; this metadata walk runs only on
// failure, to name the first failing path and reason.
function validationFailure(
	actionId: string,
	role: "input" | "output",
	schema: Schema,
	value: unknown,
): PublicActionError {
	const issue = firstSchemaIssue(schema, value);
	const prefix = `Aruna action ${actionId} ${role} validation failed`;
	return actionError("ActionValidationError", issue !== undefined ? `${prefix}: ${issue}` : prefix);
}

// The response for a rejection from the execution chain. A public error keeps
// its name and message; anything else is masked unless `exposeInternalErrors`.
// `isPublic` is false for a public-typed output failure (see `runAction`).
function rejectionResult(
	reason: unknown,
	isPublic: boolean,
	exposeInternalErrors: boolean,
	errorId: string | undefined,
): ActionDispatchResult {
	if (isPublic && isPublicActionError(reason)) {
		return { ok: false, error: reason.message, errorName: reason.name };
	}
	if (!exposeInternalErrors) {
		return {
			ok: false,
			error: ACTION_INTERNAL_ERROR_MESSAGE,
			errorName: ACTION_INTERNAL_ERROR_NAME,
			...(errorId !== undefined ? { errorId } : {}),
		};
	}
	// A thrown table with `name`/`message` string fields keeps its identity;
	// anything else is stringified.
	const asRecord = typeIs(reason, "table") ? (reason as { name?: unknown; message?: unknown }) : undefined;
	const reasonName = asRecord !== undefined && typeIs(asRecord.name, "string") ? asRecord.name : undefined;
	const reasonMessage =
		asRecord !== undefined && typeIs(asRecord.message, "string") ? asRecord.message : tostring(reason);
	return {
		ok: false,
		error: reasonMessage,
		...(reasonName !== undefined ? { errorName: reasonName } : {}),
	};
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
	const getSession = options?.getSession;
	const getStore = options?.getStore;
	const middleware = options?.middleware;
	const onError = options?.onError;
	const exposeInternalErrors = options?.exposeInternalErrors === true;
	const rateLimiter = createActionRateLimiter();
	const nowMs = options?.nowMs;
	const idempotency = createIdempotencyCache<TPlayer, ActionDispatchResult>(nowMs);
	const guard = createRequestGuard<TPlayer>({
		...(options?.requestBudget !== undefined ? { budget: options.requestBudget } : {}),
		...(options?.onAbuse !== undefined ? { onAbuse: options.onAbuse } : {}),
		...(nowMs !== undefined ? { nowMs } : {}),
	});

	// Everything after the action lookup and the in-flight cap, in the order that
	// keeps a hostile payload cheap: wire safety (bounded in depth and size)
	// before defaults, defaults before validation, validation before the
	// per-action rate limit (invalid input does not consume quota).
	const dispatchDefined = (
		definition: AnyActionDefinition<TPlayer>,
		player: TPlayer,
		actionId: string,
		input: unknown,
		progress: { ran: boolean } | undefined,
	): Promise<ActionDispatchResult> => {
		return new Promise<ActionDispatchResult>((resolve) => {
			// Reject non-wire-safe input before anything else reads it. The input
			// schema decides where an Instance may appear.
			if (!isWireSafe(input, undefined, definition.input)) {
				resolve({
					ok: false,
					error: "non-serializable action input",
					errorName: "ActionSerializationError",
				});
				return;
			}

			// Fill `.default(...)` values before validation and user code, so an
			// omitted defaulted field arrives populated.
			if (definition.input !== undefined) {
				input = applyDefaults(definition.input, input);
			}

			const inputSchema = definition.input;
			if (inputSchema !== undefined && !inputSchema.validate(input)) {
				// The boolean validate stays the cheap gate; the metadata walk runs
				// only on failure to attach the first failing path + reason.
				const failure = validationFailure(actionId, "input", inputSchema, input);
				resolve({ ok: false, error: failure.message, errorName: failure.name });
				return;
			}

			// A per-action `rateLimit` always wins; otherwise fall back to the
			// registry-wide default. Only when neither is present is the action
			// left unthrottled.
			const rateLimit = definition.rateLimit ?? defaultRateLimit;
			if (rateLimit !== undefined) {
				const limitKey = resolveRateLimitKey(rateLimit, { actionId, player, input });
				// The limiter works in seconds; the injected clock mirrors the Node
				// reference runtime's `nowMs`, so the option means the same thing in
				// both runtimes.
				const limitResult = rateLimiter.check(
					actionId,
					limitKey,
					rateLimit,
					nowMs !== undefined ? nowMs() / 1000 : undefined,
				);
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

			const context: ActionContext<TPlayer> = { player };
			if (publisher !== undefined) {
				(context as { publisher?: SignalPublisher<SignalMap, unknown> }).publisher = publisher;
			}
			if (getSession !== undefined) {
				const session = getSession(player);
				if (session !== undefined) {
					(context as { session?: unknown }).session = session;
				}
			}
			if (getStore !== undefined) {
				const document = getStore(player);
				if (document !== undefined) {
					(context as { store?: StoreDocument<unknown> }).store = document;
				}
			}

			// Invoke the handler inside a pcall so a *synchronous* throw becomes
			// a result payload rather than rejecting the dispatch promise. A
			// rejection would leave the transport's `.then` success handler
			// unfired and the client waiting forever for a response.
			//
			// Output is checked here, in the innermost step, exactly where the
			// Node runtime checks it: middleware sees a failing output as a
			// rejection, and it reaches `onError` like any other run failure.
			//
			// A failing output is a server bug, not something the client did:
			// the errors raised here are public types (middleware and `onError`
			// see the real failure), but this dispatch remembers them and masks
			// them like any other internal error.
			const outputFailures = new Set<unknown>();
			const runAction = (): Promise<unknown> => {
				const [invoked, runResult] = pcall(() => definition.run(context, input as never));
				if (!invoked) {
					return Promise.reject(runResult);
				}
				return Promise.resolve(runResult).then((output) => {
					const outputSchema = definition.output;
					if (outputSchema !== undefined && !outputSchema.validate(output)) {
						const failure = validationFailure(actionId, "output", outputSchema, output);
						outputFailures.add(failure);
						throw failure;
					}
					// Server-authored, so not held to the node budget that bounds a
					// client's input.
					if (!isWireSafe(output, math.huge, definition.output)) {
						const failure = actionError("ActionSerializationError", "non-serializable action output");
						outputFailures.add(failure);
						throw failure;
					}
					return output;
				});
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

			// Past every check that refuses a call without running it.
			if (progress !== undefined) {
				progress.ran = true;
			}

			invoke().then(
				(output) => {
					resolve({ ok: true, output });
				},
				(reason) => {
					// Every non-public failure gets an id for `onError`; the client
					// is sent it only when the failure is masked.
					const isPublic = isPublicActionError(reason) && !outputFailures.has(reason);
					const errorId = isPublic ? undefined : createErrorId();
					if (onError !== undefined) {
						onError(reason, errorId !== undefined ? { actionId, player, errorId } : { actionId, player });
					}
					resolve(rejectionResult(reason, isPublic, exposeInternalErrors, errorId));
				},
			);
		});
	};

	const dispatchOnce = (
		player: TPlayer,
		actionId: string,
		input: unknown,
		progress: { ran: boolean } | undefined,
	): Promise<ActionDispatchResult> => {
		const definition = actionsById.get(actionId);
		if (definition === undefined) {
			return Promise.resolve({
				ok: false,
				error: `Aruna action not found: ${actionId}`,
				errorName: "ActionNotFoundError",
			});
		}

		// A player's dispatches that may run at once are capped, so a burst of
		// slow calls cannot pile up behind one another. Refused before any parsing.
		if (!guard.begin(player)) {
			guard.report(player, { reason: "too-many-in-flight", actionId });
			const now = nowMs !== undefined ? nowMs() : os.clock() * 1000;
			return Promise.resolve({
				ok: false,
				error: `Aruna action ${actionId} refused: ${guard.maxInFlight} requests already in flight.`,
				errorName: "ActionRateLimitError",
				retryAfterMs: IN_FLIGHT_RETRY_AFTER_MS,
				resetAtMs: now + IN_FLIGHT_RETRY_AFTER_MS,
			});
		}
		const settled = dispatchDefined(definition, player, actionId, input, progress);
		settled.finally(() => {
			guard.finish(player);
		});
		return settled;
	};

	return {
		isFireAndForget: (actionId) => actionsById.get(actionId)?.fireAndForget === true,
		admitEnvelope: (player, requestId, actionId) =>
			admitEnvelope(guard, player, requestId, actionId),
		dispatch: (player, actionId, input, idempotencyKey) => {
			if (isIdempotencyKey(idempotencyKey)) {
				return idempotency.run(player, actionId, idempotencyKey, (progress) =>
					dispatchOnce(player, actionId, input, progress),
				);
			}
			return dispatchOnce(player, actionId, input, undefined);
		},
		forgetPlayer: (player) => {
			idempotency.forget(player);
			guard.forget(player);
		},
	};
}
