// Aruna roblox-ts native runtime — server action registry and dispatch.

import type { ActionContext, ActionDefinition, ActionErrorMap, ActionRateLimitOptions } from "./server";
import type { StoreDocument } from "./player-store";
import type { ResourceCallTag, ResourceContext, ResourceHost } from "./resource";
import { applyDefaults, firstSchemaIssue, type Schema } from "./schema";
import type { SignalMap, SignalPublisher } from "./signal-runtime";
import { createActionRateLimiter, resolveRateLimitKey } from "./rate-limit";
import { isWireSafe } from "./serialization";
import { createIdempotencyCache, isIdempotencyKey } from "./idempotency";
import {
	admitEnvelope,
	createDepartedPlayers,
	type RequestAbuseReason,
	createRequestGuard,
	IN_FLIGHT_RETRY_AFTER_MS,
	refuseFrame,
	type RequestAbuseHandler,
	type RequestBudgetOptions,
} from "./request-guard";
import {
	ACTION_INTERNAL_ERROR_MESSAGE,
	ACTION_INTERNAL_ERROR_NAME,
	actionError,
	createErrorId,
	declaredActionError,
	isDeclaredActionError,
	isPublicActionError,
	publicErrorData,
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
	// Present on an error the action declares with a `data` schema: the data,
	// already checked against it.
	readonly errorData?: unknown;
}

export interface ActionRegistry<TPlayer = unknown> {
	// The transport's entry, for a client's envelope: a player's dispatches
	// running at once are capped (`requestBudget.maxInFlight`), and the next is
	// refused with ActionRateLimitError. `idempotencyKey` is the key a retrying
	// client sends with every attempt of one call: a valid key (a string of at
	// most 64 characters) makes the action run once however many attempts
	// arrive, and anything else is ignored. `optimistic` (the call item's `o`)
	// tags the call's invalidations with its key, when it has a valid one, for
	// the client's optimistic updates (docs/rfcs/ui-bindings.md).
	readonly dispatch: (
		player: TPlayer,
		actionId: string,
		input: unknown,
		idempotencyKey?: unknown,
		optimistic?: boolean,
	) => Promise<ActionDispatchResult>;
	// The same dispatch for trusted server code (`app.dispatch`, specs): not a
	// client's envelope, so not held to the in-flight cap. Validation, rate
	// limits, middleware, and idempotency are the same.
	readonly dispatchInProcess: (
		player: TPlayer,
		actionId: string,
		input: unknown,
		idempotencyKey?: unknown,
		optimistic?: boolean,
	) => Promise<ActionDispatchResult>;
	// The transport's gate for one envelope, before it reads the input: the
	// request and action ids must be bounded strings, the player's request
	// budget must have a token, and the action must exist. False means drop the
	// envelope with no response. (`dispatch` still answers an unknown id with
	// ActionNotFoundError, for a caller that does not go through this gate.)
	readonly admitEnvelope: (player: TPlayer, requestId: unknown, actionId: unknown) => boolean;
	// The transport's report of a frame it dropped whole, before reading any call
	// in it (docs/wire-protocol.md): charged one request and reported through
	// `onAbuse`.
	readonly refuseFrame: (
		player: TPlayer,
		reason: "malformed-frame" | "unknown-protocol-version" | "oversize-batch",
	) => void;
	// Drops what the registry remembers about a player: idempotency keys, the
	// request budget, the in-flight count. `createServerApp` calls it on leave.
	// The player is then marked departed for a short while
	// (DEPARTED_PLAYER_TTL_MS), so an envelope that arrives after the leave is
	// dropped instead of creating that state again.
	readonly forgetPlayer: (player: TPlayer) => void;
	// Clears the departed mark for a player who joined again. `createServerApp`
	// calls it on join.
	readonly readmitPlayer: (player: TPlayer) => void;
	// The transport's gate for an item that is not a call (a resource
	// subscription): its id must be a string of at most `maxLength`, and the
	// player's request budget must have a token. Charged and reported like a
	// call's envelope; false means drop it.
	readonly admitItem: (player: TPlayer, id: unknown, maxLength: number) => boolean;
	// Counts a report for the player and passes it to `onAbuse`, for a refusal
	// the transport decides on its own (an unknown resource).
	readonly reportAbuse: (
		player: TPlayer,
		info: { readonly reason: RequestAbuseReason; readonly actionId?: string },
	) => void;
	// True when the action is declared `fireAndForget` (one-way). The transport
	// binder uses this to decide whether to send a response back to the client.
	// Unknown action ids return false.
	readonly isFireAndForget: (actionId: string) => boolean;
}

type AnyActionDefinition<TPlayer> = ActionDefinition<
	Schema | undefined,
	Schema | undefined,
	TPlayer,
	SignalMap,
	ActionErrorMap
>;

export type ActionMap<TPlayer> = { readonly [actionId: string]: AnyActionDefinition<TPlayer> };

// Around-run middleware. Runs after input validation and rate limiting (so a
// throttled or malformed request never reaches it) and wraps the action's `run`
// plus output validation. Short-circuit by rejecting (or by not calling `next`);
// observe/transform by awaiting `next()`.
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

// How a settled dispatch went, for observability (`createServerApp({ onReject
// })`, `createNetworkMetrics`). Names and timings only: never the input, the
// output, or an error's message or data.
export interface DispatchSettledInfo<TPlayer = unknown> {
	readonly actionId: string;
	readonly player: TPlayer;
	readonly ok: boolean;
	// The error name the caller is sent (`ActionValidationError`, a declared
	// error's name, `ActionInternalError`, ...), when not ok.
	readonly errorName?: string;
	// True when `errorName` is one the action declares in `errors`.
	readonly declared?: boolean;
	// From the dispatch's start to its settling, in milliseconds: server time
	// only (validation, middleware, run, output checks) — not a round trip.
	readonly durationMs: number;
	// The part of it spent before `run`: wire safety, defaults, validation, and
	// the rate limit. Absent when the call was refused before getting there.
	readonly checkMs?: number;
	// A client's envelope (true) or trusted in-process dispatch (false).
	readonly fromClient: boolean;
}

export interface DispatchObserver<TPlayer = unknown> {
	readonly onSettled: (info: DispatchSettledInfo<TPlayer>) => void;
}

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
	// Resolves the calling player's named store documents, injected as
	// `ctx.stores` (each undefined until it lands). Supplied by `createServerApp`
	// from its `playerStores`.
	readonly getStores?: (player: TPlayer) => { readonly [name: string]: StoreDocument<unknown> | undefined };
	// The app's resources, injected as `ctx.resources` with invalidation bound
	// to the calling player.
	readonly resources?: ResourceHost<TPlayer>;
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
	// Told, with a running count per player and reason, when a player's envelope
	// is dropped (malformed, over budget, an unknown action) or a call of theirs
	// is refused (too many in flight, invalid input, rate limited). For logging,
	// or a kick. Never told about in-process dispatch.
	readonly onAbuse?: RequestAbuseHandler<TPlayer>;
	// Told about every dispatch once it settles. Absent, dispatch reads no clock
	// for it.
	readonly observer?: DispatchObserver<TPlayer>;
}

// A schema failure at the action boundary.
// The boolean `validate` stays the cheap gate; this metadata walk runs only on
// failure, to name the first failing path and reason.
function validationFailure(
	actionId: string,
	role: "input" | "output",
	schema: Schema,
	value: unknown,
): PublicActionError {
	// The walk re-runs `refine` callbacks, which may throw; the message then
	// names no path, but the failure is still a validation failure.
	const [walked, found] = pcall(() => firstSchemaIssue(schema, value));
	const issue = walked ? found : undefined;
	const prefix = `Aruna action ${actionId} ${role} validation failed`;
	return actionError("ActionValidationError", issue !== undefined ? `${prefix}: ${issue}` : prefix);
}

// A public error whose name the action declares has to match the declaration,
// however it was thrown (`ctx.fail`, or an `actionError` from middleware): the
// client is promised that an error of that name carries that data. And
// `ctx.fail` only throws declared names. Returns the failure to report instead
// when either does not hold — a server bug, so it is masked like a failing
// output. `undefined` means the error may go out as it is; that includes an
// `actionError` of a name the action does not declare, which stays untyped.
function declaredErrorMismatch(
	actionId: string,
	errors: ActionErrorMap | undefined,
	failure: PublicActionError,
): PublicActionError | undefined {
	const prefix = `Aruna action ${actionId} error ${failure.name}`;
	const declaration = errors !== undefined ? errors[failure.name] : undefined;
	if (declaration === undefined) {
		return isDeclaredActionError(failure)
			? actionError("ActionValidationError", `${prefix} is not declared in its errors`)
			: undefined;
	}
	const data = publicErrorData(failure);
	const dataSchema = declaration.data;
	if (dataSchema === undefined) {
		return data === undefined ? undefined : actionError("ActionValidationError", `${prefix} declares no data`);
	}
	// Server-authored, so not held to the client's node budget.
	if (!isWireSafe(data, math.huge, dataSchema)) {
		return actionError("ActionSerializationError", `${prefix} data is not serializable`);
	}
	if (!dataSchema.validate(data)) {
		const issue = firstSchemaIssue(dataSchema, data);
		return actionError(
			"ActionValidationError",
			issue !== undefined ? `${prefix} data validation failed: ${issue}` : `${prefix} data validation failed`,
		);
	}
	return undefined;
}

// The response for a rejection from the execution chain. A public error keeps
// its name and message (and a declared error its data); anything else is
// masked unless `exposeInternalErrors`. `isPublic` is false for a public-typed
// output failure (see `runAction`).
function rejectionResult(
	reason: unknown,
	isPublic: boolean,
	exposeInternalErrors: boolean,
	errorId: string | undefined,
): ActionDispatchResult {
	if (isPublic && isPublicActionError(reason)) {
		const data = publicErrorData(reason);
		return {
			ok: false,
			error: reason.message,
			errorName: reason.name,
			...(data !== undefined ? { errorData: data } : {}),
		};
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
	const resources = options?.resources;
	const getStores = options?.getStores;
	const middleware = options?.middleware;
	const onError = options?.onError;
	const exposeInternalErrors = options?.exposeInternalErrors === true;
	const rateLimiter = createActionRateLimiter();
	const nowMs = options?.nowMs;
	// Players who just left. forgetPlayer drops their keys and budget; this
	// keeps a late envelope from creating them again (and holding the player).
	const departed = createDepartedPlayers<TPlayer>(nowMs);
	const idempotency = createIdempotencyCache<TPlayer, ActionDispatchResult>(nowMs, departed);
	const guard = createRequestGuard<TPlayer>({
		...(options?.requestBudget !== undefined ? { budget: options.requestBudget } : {}),
		...(options?.onAbuse !== undefined ? { onAbuse: options.onAbuse } : {}),
		...(nowMs !== undefined ? { nowMs } : {}),
		departed,
	});

	// Everything after the action lookup and the in-flight cap, in the order that
	// keeps a hostile payload cheap: wire safety (bounded in depth and size)
	// before defaults, defaults before validation, validation before the
	// per-action rate limit (invalid input does not consume quota).
	//
	// `fromClient` is set for a client's envelope, which the transport charged
	// to the request budget: its refusals are reported through `onAbuse`, and
	// its token is given back once its action's rate limit admits it.
	const observer = options?.observer;
	const readClock = (): number => (nowMs !== undefined ? nowMs() : os.clock() * 1000);

	const dispatchDefined = (
		definition: AnyActionDefinition<TPlayer>,
		player: TPlayer,
		actionId: string,
		input: unknown,
		progress: { ran: boolean } | undefined,
		fromClient: boolean,
		timing?: { checkedAt?: number },
		call?: ResourceCallTag<TPlayer>,
	): Promise<ActionDispatchResult> => {
		return new Promise<ActionDispatchResult>((resolve) => {
			// Reject non-wire-safe input before anything else reads it. The input
			// schema decides where an Instance may appear.
			if (!isWireSafe(input, undefined, definition.input)) {
				if (fromClient) {
					guard.report(player, { reason: "invalid-input", actionId });
				}
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
			// A schema's `refine` callbacks are user code run on client input: one
			// that throws on a hostile value must fail the call like any invalid
			// input, not reject the dispatch and leave the caller unanswered.
			const [validated, valid] =
				inputSchema !== undefined ? pcall(() => inputSchema.validate(input)) : [true, true];
			if (!validated) {
				if (fromClient) {
					guard.report(player, { reason: "invalid-input", actionId });
				}
				resolve({
					ok: false,
					error: `Aruna action ${actionId} input validation failed: a refinement threw`,
					errorName: "ActionValidationError",
				});
				return;
			}
			if (inputSchema !== undefined && valid !== true) {
				// The boolean validate stays the cheap gate; the metadata walk runs
				// only on failure to attach the first failing path + reason.
				const failure = validationFailure(actionId, "input", inputSchema, input);
				if (fromClient) {
					guard.report(player, { reason: "invalid-input", actionId });
				}
				resolve({ ok: false, error: failure.message, errorName: failure.name });
				return;
			}

			// A per-action `rateLimit` always wins; otherwise fall back to the
			// registry-wide default. Only when neither is present is the action
			// left unthrottled.
			const rateLimit = definition.rateLimit ?? defaultRateLimit;
			if (rateLimit !== undefined) {
				const limitKey = resolveRateLimitKey(rateLimit, { actionId, player, input });
				// The limiter works in seconds; the injected clock (`nowMs`) is in
				// milliseconds, like every other duration option.
				const limitResult = rateLimiter.check(
					actionId,
					limitKey,
					rateLimit,
					nowMs !== undefined ? nowMs() / 1000 : undefined,
				);
				if (!limitResult.ok) {
					if (fromClient) {
						guard.report(player, { reason: "rate-limited", actionId });
					}
					resolve({
						ok: false,
						error: `Aruna action ${actionId} is rate limited. Retry after ${limitResult.retryAfterMs}ms.`,
						errorName: "ActionRateLimitError",
						retryAfterMs: limitResult.retryAfterMs,
						resetAtMs: limitResult.resetAtMs,
					});
					return;
				}
				// The action's own limit priced this call; the budget does not
				// charge it a second time.
				if (fromClient) {
					guard.refund(player);
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
			if (getStores !== undefined) {
				(context as { stores?: unknown }).stores = getStores(player);
			}
			if (resources !== undefined) {
				// An optimistic call's invalidations are tagged with its key.
				const bound: ResourceContext<TPlayer> = {
					invalidate: (resource, target) => {
						const key = target !== undefined ? target : player;
						if (call !== undefined) {
							resources.invalidateForCall(resource, key, call);
						} else {
							resources.invalidate(resource, key);
						}
					},
					invalidateAll: (resource) => {
						if (call !== undefined) {
							resources.invalidateForCall(resource, undefined, call);
						} else {
							resources.invalidate(resource);
						}
					},
				};
				(context as { resources?: ResourceContext<TPlayer> }).resources = bound;
			}
			// `ctx.fail(name, data)` for an action that declares `errors`.
			if (definition.errors !== undefined) {
				(context as { fail?: (name: string, data?: unknown) => never }).fail = (name, data) => {
					throw declaredActionError(name, data);
				};
			}

			// `authorize(ctx, input)`: who may call, decided with the context `run`
			// would get. It is user code run on every call, so a throw refuses the
			// call like a `false` instead of escaping the dispatch; only `true`
			// lets it through.
			// Read as a plain field: roblox-ts refuses to index a method without
			// calling it, and `authorize` is a method (like `run`) for variance.
			if ((definition as unknown as { readonly authorize?: unknown }).authorize !== undefined) {
				const [checked, allowed] = pcall(() => definition.authorize!(context as never, input as never));
				if (!checked || allowed !== true) {
					if (fromClient) {
						guard.report(player, { reason: "forbidden", actionId });
					}
					resolve({
						ok: false,
						error: `Aruna action ${actionId} refused the call: not authorized`,
						errorName: "ActionForbiddenError",
					});
					return;
				}
			}

			// Invoke the handler inside a pcall so a *synchronous* throw becomes
			// a result payload rather than rejecting the dispatch promise. A
			// rejection would leave the transport's `.then` success handler
			// unfired and the client waiting forever for a response.
			//
			// Output is checked here, in the innermost step: middleware sees a
			// failing output as a
			// rejection, and it reaches `onError` like any other run failure.
			//
			// A failing output is a server bug, not something the client did:
			// the errors raised here are public types (middleware and `onError`
			// see the real failure), but this dispatch remembers them and masks
			// them like any other internal error.
			const outputFailures = new Set<unknown>();
			const runAction = (): Promise<unknown> => {
				// The erased definition's ctx type always has `fail`; the context
				// carries it exactly when the action declares errors, which is when
				// the action's own type has it.
				const [invoked, runResult] = pcall(() =>
					definition.run(context as Parameters<typeof definition.run>[0], input as never),
				);
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
			if (timing !== undefined) {
				timing.checkedAt = readClock();
			}

			invoke().then(
				(output) => {
					resolve({ ok: true, output });
				},
				(rejection) => {
					let reason = rejection;
					let isPublic = isPublicActionError(reason) && !outputFailures.has(reason);
					// An error of a declared name that does not match its
					// declaration is reported, and masked, as the mismatch.
					if (isPublic) {
						const mismatch = declaredErrorMismatch(
							actionId,
							definition.errors,
							reason as PublicActionError,
						);
						if (mismatch !== undefined) {
							reason = mismatch;
							isPublic = false;
						}
					}
					// Every non-public failure gets an id for `onError`; the client
					// is sent it only when the failure is masked.
					const errorId = isPublic ? undefined : createErrorId();
					if (onError !== undefined) {
						onError(reason, errorId !== undefined ? { actionId, player, errorId } : { actionId, player });
					}
					resolve(rejectionResult(reason, isPublic, exposeInternalErrors, errorId));
				},
			);
		});
	};

	const notFound = (actionId: string): Promise<ActionDispatchResult> =>
		Promise.resolve({
			ok: false,
			error: `Aruna action not found: ${actionId}`,
			errorName: "ActionNotFoundError",
		});

	// The transport's path. A player's dispatches that may run at once are
	// capped, so a burst of slow calls cannot pile up behind one another.
	// Refused before any parsing.
	const dispatchCapped = (
		player: TPlayer,
		actionId: string,
		input: unknown,
		progress: { ran: boolean } | undefined,
		timing: { checkedAt?: number } | undefined,
		call: ResourceCallTag<TPlayer> | undefined,
	): Promise<ActionDispatchResult> => {
		const definition = actionsById.get(actionId);
		if (definition === undefined) {
			return notFound(actionId);
		}
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
		const settled = dispatchDefined(definition, player, actionId, input, progress, true, timing, call);
		settled.finally(() => {
			guard.finish(player);
		});
		return settled;
	};

	// Trusted server code's path: no in-flight cap.
	const dispatchUncapped = (
		player: TPlayer,
		actionId: string,
		input: unknown,
		progress: { ran: boolean } | undefined,
		timing: { checkedAt?: number } | undefined,
		call: ResourceCallTag<TPlayer> | undefined,
	): Promise<ActionDispatchResult> => {
		const definition = actionsById.get(actionId);
		if (definition === undefined) {
			return notFound(actionId);
		}
		return dispatchDefined(definition, player, actionId, input, progress, false, timing, call);
	};

	type DispatchOnce = typeof dispatchCapped;
	const withIdempotency = (
		dispatchOnce: DispatchOnce,
		player: TPlayer,
		actionId: string,
		input: unknown,
		idempotencyKey: unknown,
		optimistic: boolean,
		timing: { checkedAt?: number } | undefined,
	): Promise<ActionDispatchResult> => {
		if (isIdempotencyKey(idempotencyKey)) {
			// An optimistic call is tagged by its key; the action runs once per key,
			// so a retried attempt tags nothing a second time.
			const call = optimistic ? { caller: player, key: idempotencyKey } : undefined;
			return idempotency.run(player, actionId, idempotencyKey, (progress) =>
				dispatchOnce(player, actionId, input, progress, timing, call),
			);
		}
		return dispatchOnce(player, actionId, input, undefined, timing, undefined);
	};

	// The entry both dispatch paths share: with an observer, one clock read at
	// the start and one at the settle, and a report of names and timings. A
	// throwing observer is contained; it never costs a caller its response.
	const observed = (
		dispatchOnce: DispatchOnce,
		fromClient: boolean,
		player: TPlayer,
		actionId: string,
		input: unknown,
		idempotencyKey: unknown,
		optimistic: boolean,
	): Promise<ActionDispatchResult> => {
		if (observer === undefined) {
			return withIdempotency(dispatchOnce, player, actionId, input, idempotencyKey, optimistic, undefined);
		}
		const startedAt = readClock();
		const timing: { checkedAt?: number } = {};
		return withIdempotency(dispatchOnce, player, actionId, input, idempotencyKey, optimistic, timing).then((result) => {
			const durationMs = readClock() - startedAt;
			const errorName = result.ok ? undefined : result.errorName;
			const errors = actionsById.get(actionId)?.errors;
			const declared = errorName !== undefined && errors !== undefined && errors[errorName] !== undefined;
			const checkedAt = timing.checkedAt;
			const info: DispatchSettledInfo<TPlayer> = {
				actionId,
				player,
				ok: result.ok,
				...(errorName !== undefined ? { errorName } : {}),
				...(declared ? { declared: true } : {}),
				durationMs,
				...(checkedAt !== undefined ? { checkMs: checkedAt - startedAt } : {}),
				fromClient,
			};
			const [reported, failure] = pcall(() => observer.onSettled(info));
			if (!reported) {
				warn(`Aruna dispatch observer threw: ${tostring(failure)}`);
			}
			return result;
		});
	};

	return {
		isFireAndForget: (actionId) => actionsById.get(actionId)?.fireAndForget === true,
		admitEnvelope: (player, requestId, actionId) => {
			if (!admitEnvelope(guard, player, requestId, actionId)) {
				return false;
			}
			// Charged like any envelope, and dropped without the
			// ActionNotFoundError a response would carry: that would only tell a
			// prober which ids exist.
			if (!actionsById.has(actionId as string)) {
				guard.report(player, { reason: "unknown-action", actionId: actionId as string });
				return false;
			}
			return true;
		},
		refuseFrame: (player, reason) => refuseFrame(guard, player, reason),
		dispatch: (player, actionId, input, idempotencyKey, optimistic) =>
			observed(dispatchCapped, true, player, actionId, input, idempotencyKey, optimistic === true),
		dispatchInProcess: (player, actionId, input, idempotencyKey, optimistic) =>
			observed(dispatchUncapped, false, player, actionId, input, idempotencyKey, optimistic === true),
		forgetPlayer: (player) => {
			idempotency.forget(player);
			guard.forget(player);
			departed.add(player);
		},
		readmitPlayer: (player) => {
			departed.remove(player);
		},
		admitItem: (player, id, maxLength) => {
			if (guard.hasDeparted(player)) {
				return false;
			}
			if (!typeIs(id, "string") || id.size() > maxLength) {
				guard.admit(player);
				guard.report(player, { reason: "malformed-envelope" });
				return false;
			}
			if (!guard.admit(player)) {
				guard.report(player, { reason: "budget-exhausted", actionId: id });
				return false;
			}
			return true;
		},
		reportAbuse: (player, info) => {
			guard.report(player, info);
		},
	};
}
