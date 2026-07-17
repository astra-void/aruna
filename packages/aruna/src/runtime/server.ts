import { applyDefaults, assertSchema, type Infer, type Schema } from "../schema/index.js";
import { assertSerializableActionValue } from "./serialization.js";
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
> = ActionRunContext<TPlayer, TSignals, TSession> & {
  readonly publisher: RemoteSignalPublisher<TSignals, TPlayer>;
  readonly session: TSession;
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
// The info shape is `{ actionId, player }`, matching the native runtime.
export type ActionErrorHandler<TPlayer = unknown> = (
  error: unknown,
  info: {
    readonly actionId: string;
    readonly player: TPlayer;
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
  // Applied outermost-first around every action's execution.
  readonly middleware?: readonly ActionMiddleware<TPlayer>[];
  readonly onError?: ActionErrorHandler<TPlayer>;
  readonly nowMs?: () => number;
};

const defaultActionRateLimiter = createActionRateLimiter();

export async function dispatchAction<TPlayer = unknown>(
  registry: ActionRegistry<TPlayer>,
  actionId: string,
  ctx: ActionRunContext<TPlayer>,
  input: unknown,
  options?: DispatchActionOptions<TPlayer>,
): Promise<unknown> {
  const action = registry[actionId];

  if (action === undefined) {
    throw new Error(`Aruna action not found: ${actionId}`);
  }

  // Fill `.default(...)` values before validation and before the handler runs,
  // so an omitted defaulted field arrives populated. No-op when the schema has
  // no defaults.
  if (action.input !== undefined) {
    input = applyDefaults(action.input, input);
  }

  assertSerializableActionValue(input, "input", actionId);

  if (action.input !== undefined) {
    assertSchema(action.input, input, { actionId, role: "input" });
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

  // Inject the app-owned publisher and the per-player session into the ctx so
  // `run` sees `ctx.publisher` / `ctx.session`. Each is filled only when the
  // caller did not already supply one — a custom `createContext` always wins —
  // and both are merged in a single spread to avoid cloning the ctx twice.
  const injectedPublisher =
    options?.publisher !== undefined && ctx.publisher === undefined ? options.publisher : undefined;
  const injectedSession =
    options?.getSession !== undefined && ctx.session === undefined
      ? options.getSession(ctx.player)
      : undefined;
  const runCtx =
    injectedPublisher !== undefined || injectedSession !== undefined
      ? {
          ...ctx,
          ...(injectedPublisher !== undefined ? { publisher: injectedPublisher } : {}),
          ...(injectedSession !== undefined ? { session: injectedSession } : {}),
        }
      : ctx;

  const runAction = async (): Promise<unknown> => {
    const output = await Promise.resolve(action.run(runCtx, input));

    if (action.output !== undefined) {
      assertSchema(action.output, output, { actionId, role: "output" });
    }

    assertSerializableActionValue(output, "output", actionId);

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

  try {
    return await invoke();
  } catch (error) {
    options?.onError?.(error, { actionId, player: runCtx.player });
    throw error;
  }
}
