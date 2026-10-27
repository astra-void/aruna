import {
  applyDefaults,
  assertSchema,
  SchemaValidationError,
  type Infer,
  type Schema,
} from "../schema/index.js";
import { assertSerializableActionValue } from "./serialization.js";
import { ActionInternalError, createErrorId, isPublicActionError } from "./action-error.js";
import { isIdempotencyKey, type IdempotencyCache } from "./idempotency.js";
import { IN_FLIGHT_RETRY_AFTER_MS, type RequestGuard } from "./request-guard.js";
// Type-only, so the store runtime is not pulled into the dispatch module's
// require graph.
import type { StoreDocument } from "./player-store.js";
import type { RemoteSignalPublisher } from "./remote-signal.js";
import type { SignalRegistry } from "./signal.js";
import {
  ActionRateLimitError,
  createActionRateLimiter,
  defaultActionRateLimitKeyResolver,
  type ActionRateLimitOptions,
  type ActionRateLimiter,
  type RateLimitKeyResolver,
} from "./rate-limit.js";

export {
  ActionRateLimitError,
  createActionRateLimiter,
  defaultActionRateLimitKeyResolver,
} from "./rate-limit.js";
export type {
  ActionRateLimitConfig,
  ActionRateLimitOptions,
  ActionRateLimitKey,
  ActionRateLimitKeyFn,
  ActionRateLimitKeyInfo,
  ActionRateLimitResult,
  ActionRateLimiter,
  RateLimitKeyResolver,
} from "./rate-limit.js";

export type ActionRunContext<
  TPlayer = unknown,
  TSignals extends SignalRegistry = SignalRegistry,
  TSession = unknown,
> = {
  // Always present: every wire dispatch carries the calling player, and
  // in-process dispatches (`app.dispatch`, tests) supply one in the context
  // they pass. Matches the native runtime.
  readonly player: TPlayer;
  // The app-owned signal publisher, injected by `createServerApp` when it owns a
  // publisher (`{ signals, createPublisher }`). Lets an action push server→client
  // signals from inside `run` without a hand-written plumbing module. Optional on
  // the base context (an app may own no publisher); use the typed definer from
  // `createActionDefiner` to get a non-optional, signal-registry-checked publisher.
  //
  // The player type is deliberately `unknown` here, NOT `TPlayer`: a publisher's
  // `to(player, ...)` is contravariant in the player, so tying it to `TPlayer`
  // would make an `unknown`-player action (`defineAction` from `aruna/server`)
  // no longer assignable into a `createServerApp<Player>` registry. The precise,
  // player-typed publisher lives on `PublishingActionRunContext` via the definer.
  readonly publisher?: RemoteSignalPublisher<TSignals, unknown>;
  // Per-player session state, created by `createServerApp({ createSession })` on
  // player-add and injected into every action ctx for that player. Absent when no
  // session factory is configured. Optional on the base context; use the typed
  // definer from `createActionDefiner<TSignals, TPlayer, TSession>` for a
  // non-optional, typed one.
  readonly session?: TSession;
  // The calling player's open store document, injected by `createServerApp` when
  // it owns a `playerStore`. Stays optional even under the typed definer, and
  // deliberately so: a document is absent while the load is still in flight, and
  // after a load failure there is no trustworthy value to hand out. An action
  // that persists state has to decide what to do when the save file is not
  // there, rather than being handed a default that would overwrite it.
  //
  // Carried value-erased (`unknown`) for the same reason `publisher` is carried
  // player-erased: `StoreDocument<T>` is invariant in T (it both returns and
  // accepts one), so binding it here would stop an `unknown`-store action from
  // being assignable into a typed app's registry. The precise value type lives on
  // `PublishingActionRunContext` via the definer.
  readonly store?: StoreDocument<unknown>;
};

// Like ActionRunContext but with `publisher` and `session` guaranteed present and
// typed against a concrete signal registry, player, and session. Produced by
// `createActionDefiner<TSignals, TPlayer, TSession>()`, whose authored action's
// `TPlayer` matches the app, so the precise player typing introduces no variance
// hazard. Defined as an intersection so it stays a structural subtype of
// ActionRunContext (the definer returns it as one).
export type PublishingActionRunContext<
  TPlayer,
  TSignals extends SignalRegistry,
  TSession = unknown,
  TStore = unknown,
> = ActionRunContext<TPlayer, TSignals, TSession> & {
  readonly publisher: RemoteSignalPublisher<TSignals, TPlayer>;
  readonly session: TSession;
  // Narrows the erased `store` from the base context to the value your player
  // store holds. Still optional: the document may not be loaded yet.
  readonly store?: StoreDocument<TStore>;
};

export type ActionSchemaInput<TSchema extends Schema | undefined> = [TSchema] extends [Schema]
  ? Infer<TSchema>
  : unknown;

export type ActionSchemaOutput<TSchema extends Schema | undefined> = [TSchema] extends [Schema]
  ? Infer<TSchema>
  : unknown;

export type ActionDefinition<
  TInputSchema extends Schema | undefined = undefined,
  TOutputSchema extends Schema | undefined = undefined,
  TPlayer = unknown,
  TSignals extends SignalRegistry = SignalRegistry,
> = {
  readonly id: string;
  readonly rateLimit?: ActionRateLimitOptions;
  // One-way action: the client does not wait for an ack and the server skips the
  // response, trading delivery confirmation for throughput on high-frequency
  // commands. The default (false/undefined) keeps the request/response roundtrip.
  readonly fireAndForget?: boolean;
  // Declares that running this action twice has the same effect as running it
  // once. Only then does the client's default retry policy retry a timeout: a
  // timeout does not mean the server did not run the action, only that the
  // response was late. Must be a boolean literal (the compiler reads it into the
  // manifest and passes it from the generated client stub).
  readonly idempotent?: boolean;
  readonly input?: TInputSchema;
  readonly output?: TOutputSchema;
  run(
    ctx: ActionRunContext<TPlayer, TSignals>,
    input: ActionSchemaInput<TInputSchema>,
  ): ActionSchemaOutput<TOutputSchema> | Promise<ActionSchemaOutput<TOutputSchema>>;
};

export type InferInput<
  TAction extends ActionDefinition<Schema | undefined, Schema | undefined, unknown>,
> =
  TAction extends ActionDefinition<infer TInputSchema, infer _TOutputSchema, infer _TPlayer>
    ? ActionSchemaInput<TInputSchema>
    : never;

export type InferOutput<
  TAction extends ActionDefinition<Schema | undefined, Schema | undefined, unknown>,
> =
  TAction extends ActionDefinition<infer _TInputSchema, infer TOutputSchema, infer _TPlayer>
    ? ActionSchemaOutput<TOutputSchema>
    : never;

export type ActionRegistry<TPlayer = unknown> = Record<
  string,
  ActionDefinition<Schema | undefined, Schema | undefined, TPlayer>
>;

// Around-run middleware. Runs after input validation and rate limiting (so a
// throttled or malformed request never reaches it) and wraps the action's `run`
// plus output validation. Short-circuit by throwing (or by not calling `next`);
// observe/transform by awaiting `next()`.
export type ActionMiddleware<TPlayer = unknown> = (
  info: {
    readonly actionId: string;
    readonly ctx: ActionRunContext<TPlayer>;
    readonly input: unknown;
  },
  next: () => Promise<unknown>,
) => Promise<unknown>;

// Observability hook for errors thrown from the action execution chain
// (middleware, `run`, output validation). Called before the error propagates to
// the transport; rate-limit and input-validation rejections are not routed here.
// `error` is the original value, never the masked one. `errorId` is set for
// every non-public error: it is the id a masked `ActionInternalError` carries
// to the client. The info shape matches the native runtime.
export type ActionErrorHandler<TPlayer = unknown> = (
  error: unknown,
  info: {
    readonly actionId: string;
    readonly player: TPlayer;
    readonly errorId?: string;
  },
) => void;

export type DispatchActionOptions<TPlayer = unknown> = {
  readonly rateLimiter?: ActionRateLimiter;
  readonly rateLimitKey?: RateLimitKeyResolver<TPlayer>;
  // Applied to any action that does not declare its own `rateLimit`. A
  // per-action `rateLimit` always takes precedence over this fallback.
  readonly defaultRateLimit?: ActionRateLimitOptions;
  // The app-owned signal publisher, injected into the action ctx so `run` can
  // publish signals. Carried registry- and player-erased (`unknown`) — the precise
  // typing lives on the action ctx via `createActionDefiner`; dispatch only
  // forwards the object, it never invokes it.
  readonly publisher?: RemoteSignalPublisher<SignalRegistry, unknown>;
  // Resolves the calling player's session, injected into the action ctx as
  // `ctx.session`. Supplied by `createServerApp` from its per-player session
  // store; dispatch only reads it. Returns undefined when the player has none.
  readonly getSession?: (player: TPlayer) => unknown;
  // Resolves the calling player's open store document, injected as `ctx.store`.
  // Supplied by `createServerApp` from its `playerStore`. Returns undefined
  // while the load is still in flight or after the document was released.
  readonly getStore?: (player: TPlayer) => StoreDocument<unknown> | undefined;
  // Remembers what each (player, action, idempotency key) settled to, so a
  // retried call runs once. Supplied by `createServerApp`, which clears a
  // player's entries on leave; without it, keys are ignored.
  readonly idempotency?: IdempotencyCache<TPlayer, unknown>;
  // The per-player envelope budget and in-flight cap. Supplied by
  // `createServerApp`; dispatch claims an in-flight slot, the transport charges
  // the budget.
  readonly requestGuard?: RequestGuard<TPlayer>;
  // Applied outermost-first around every action's execution.
  readonly middleware?: readonly ActionMiddleware<TPlayer>[];
  readonly onError?: ActionErrorHandler<TPlayer>;
  // Rethrows a non-public error as is instead of `ActionInternalError`, so its
  // own name and message reach the client. Off by default. Errors made with
  // `actionError`, and the framework's own failures, are public either way.
  readonly exposeInternalErrors?: boolean;
  readonly nowMs?: () => number;
};

// A schema failure at the action boundary (input or output). Subclasses
// SchemaValidationError so `instanceof SchemaValidationError` keeps matching; the
// distinct name is what crosses the wire, and is the one the native runtime sends.
export class ActionValidationError extends SchemaValidationError {
  override readonly name: string = "ActionValidationError";
  // Marks a framework error as public: its name and message reach the client.
  readonly __arunaActionError = true as const;
}

// A dispatch for an action id the registry does not hold. Public on the wire,
// like the other framework errors, and named the same in the native runtime.
export class ActionNotFoundError extends Error {
  override readonly name = "ActionNotFoundError";
  // Marks a framework error as public: its name and message reach the client.
  readonly __arunaActionError = true as const;
  readonly actionId: string;

  constructor(actionId: string) {
    super(`Aruna action not found: ${actionId}`);
    this.actionId = actionId;
  }
}

function assertActionSchema(
  schema: Schema,
  value: unknown,
  actionId: string,
  role: "input" | "output",
): void {
  try {
    assertSchema(schema, value, { actionId, role });
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw new ActionValidationError(error.message, { actionId, role, issues: error.issues });
    }
    throw error;
  }
}

const defaultActionRateLimiter = createActionRateLimiter();

// `idempotencyKey` is the key a retrying client sends with every attempt of one
// call. With `options.idempotency` set, a valid key makes the action run once
// however many attempts arrive; an invalid one is ignored.
export function dispatchAction<TPlayer = unknown>(
  registry: ActionRegistry<TPlayer>,
  actionId: string,
  ctx: ActionRunContext<TPlayer>,
  input: unknown,
  options?: DispatchActionOptions<TPlayer>,
  idempotencyKey?: unknown,
): Promise<unknown> {
  const idempotency = options?.idempotency;
  if (idempotency !== undefined && isIdempotencyKey(idempotencyKey)) {
    return idempotency.run(ctx.player, actionId, idempotencyKey, (progress) =>
      dispatchActionOnce(registry, actionId, ctx, input, options, progress),
    );
  }
  return dispatchActionOnce(registry, actionId, ctx, input, options);
}

function dispatchActionOnce<TPlayer>(
  registry: ActionRegistry<TPlayer>,
  actionId: string,
  ctx: ActionRunContext<TPlayer>,
  input: unknown,
  options: DispatchActionOptions<TPlayer> | undefined,
  progress?: { ran: boolean },
): Promise<unknown> {
  const action = registry[actionId];

  if (action === undefined) {
    return Promise.reject(new ActionNotFoundError(actionId));
  }

  // A player's dispatches that may run at once are capped, so a burst of slow
  // calls cannot pile up behind one another. Refused before any parsing.
  const guard = options?.requestGuard;
  if (guard === undefined) {
    return dispatchDefinedAction(action, actionId, ctx, input, options, progress);
  }
  if (!guard.begin(ctx.player)) {
    guard.report(ctx.player, { reason: "too-many-in-flight", actionId });
    return Promise.reject(
      new ActionRateLimitError(
        `Aruna action ${actionId} refused: ${guard.maxInFlight} requests already in flight.`,
        {
          actionId,
          max: guard.maxInFlight,
          windowMs: 0,
          retryAfterMs: IN_FLIGHT_RETRY_AFTER_MS,
          resetAtMs: (options?.nowMs ?? Date.now)() + IN_FLIGHT_RETRY_AFTER_MS,
        },
      ),
    );
  }
  return dispatchDefinedAction(action, actionId, ctx, input, options, progress).finally(() => {
    guard.finish(ctx.player);
  });
}

// Everything after the action lookup and the in-flight cap, in the order that
// keeps a hostile payload cheap: wire safety (bounded in depth and size) before
// defaults, defaults before validation, validation before the per-action rate
// limit (invalid input does not consume quota).
async function dispatchDefinedAction<TPlayer>(
  action: ActionRegistry<TPlayer>[string],
  actionId: string,
  ctx: ActionRunContext<TPlayer>,
  input: unknown,
  options: DispatchActionOptions<TPlayer> | undefined,
  progress?: { ran: boolean },
): Promise<unknown> {
  // The input schema decides where an Instance may appear.
  assertSerializableActionValue(
    input,
    "input",
    actionId,
    action.input !== undefined ? { schema: action.input } : undefined,
  );

  // Fill `.default(...)` values before validation and before the handler runs,
  // so an omitted defaulted field arrives populated. No-op when the schema has
  // no defaults.
  if (action.input !== undefined) {
    input = applyDefaults(action.input, input);
  }

  if (action.input !== undefined) {
    assertActionSchema(action.input, input, actionId, "input");
  }

  // A per-action `rateLimit` always wins; otherwise fall back to the app-wide
  // default. Only when neither is present is the action left unthrottled.
  const effectiveRateLimit = action.rateLimit ?? options?.defaultRateLimit;
  if (effectiveRateLimit !== undefined) {
    const rateLimiter = options?.rateLimiter ?? defaultActionRateLimiter;
    // Precedence: a per-action custom key function is most specific and wins;
    // then a "global" bucket collapses every caller into one; then an app-level
    // rateLimitKey resolver; then the default per-player bucket. Matches the
    // native runtime's resolveRateLimitKey.
    const perActionKey = effectiveRateLimit.key;
    let bucketKey: string;
    if (typeof perActionKey === "function") {
      bucketKey = perActionKey({ actionId, player: ctx.player, input });
    } else if (perActionKey === "global") {
      bucketKey = "global";
    } else if (options?.rateLimitKey !== undefined) {
      bucketKey = options.rateLimitKey(actionId, ctx);
    } else {
      bucketKey = defaultActionRateLimitKeyResolver<TPlayer>(actionId, ctx);
    }
    const result = rateLimiter.check(actionId, bucketKey, effectiveRateLimit, options?.nowMs?.());

    if (!result.ok) {
      throw new ActionRateLimitError(
        `Aruna action ${actionId} is rate limited. Retry after ${result.retryAfterMs}ms.`,
        {
          actionId,
          max: effectiveRateLimit.max,
          windowMs: effectiveRateLimit.windowMs,
          retryAfterMs: result.retryAfterMs,
          resetAtMs: result.resetAtMs,
        },
      );
    }
  }

  // Inject the app-owned publisher, the per-player session, and the player's
  // open store document into the ctx so `run` sees `ctx.publisher` /
  // `ctx.session` / `ctx.store`. Each is filled only when the caller did not
  // already supply one — a custom `createContext` always wins — and all are
  // merged in a single spread to avoid cloning the ctx more than once.
  const injectedPublisher =
    options?.publisher !== undefined && ctx.publisher === undefined ? options.publisher : undefined;
  const injectedSession =
    options?.getSession !== undefined && ctx.session === undefined
      ? options.getSession(ctx.player)
      : undefined;
  const injectedStore =
    options?.getStore !== undefined && ctx.store === undefined
      ? options.getStore(ctx.player)
      : undefined;
  const runCtx =
    injectedPublisher !== undefined || injectedSession !== undefined || injectedStore !== undefined
      ? {
          ...ctx,
          ...(injectedPublisher !== undefined ? { publisher: injectedPublisher } : {}),
          ...(injectedSession !== undefined ? { session: injectedSession } : {}),
          ...(injectedStore !== undefined ? { store: injectedStore } : {}),
        }
      : ctx;

  // An output that fails its schema or cannot cross the wire is a server bug,
  // not something the client did. The errors those checks raise are public
  // types (so middleware and `onError` see the real failure), but this
  // dispatch remembers them and masks them like any other internal error.
  const outputFailures = new Set<unknown>();
  const runAction = async (): Promise<unknown> => {
    const output = await Promise.resolve(action.run(runCtx, input));

    try {
      if (action.output !== undefined) {
        assertActionSchema(action.output, output, actionId, "output");
      }

      // Server-authored, so not held to the node budget that bounds a
      // client's input.
      assertSerializableActionValue(output, "output", actionId, {
        maxNodes: Infinity,
        ...(action.output !== undefined ? { schema: action.output } : {}),
      });
    } catch (error) {
      outputFailures.add(error);
      throw error;
    }

    return output;
  };

  // Compose middleware outermost-first around the run: middleware[0] is the
  // outermost layer, `runAction` the innermost `next`.
  let invoke = runAction;
  const middleware = options?.middleware;
  if (middleware !== undefined && middleware.length > 0) {
    const info = { actionId, ctx: runCtx, input };
    for (let index = middleware.length - 1; index >= 0; index -= 1) {
      const layer = middleware[index];
      if (layer === undefined) {
        continue;
      }
      const next = invoke;
      invoke = () => Promise.resolve(layer(info, next));
    }
  }

  // Past every check that refuses a call without running it.
  if (progress !== undefined) {
    progress.ran = true;
  }

  try {
    return await invoke();
  } catch (error) {
    if (isPublicActionError(error) && !outputFailures.has(error)) {
      options?.onError?.(error, { actionId, player: runCtx.player });
      throw error;
    }
    const errorId = createErrorId();
    options?.onError?.(error, { actionId, player: runCtx.player, errorId });
    if (options?.exposeInternalErrors === true) {
      throw error;
    }
    throw new ActionInternalError(errorId, error);
  }
}
