import { assertSchema, type Infer, type Schema } from "../schema/index.js";
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
  ActionRateLimitResult,
  ActionRateLimiter,
  RateLimitKeyResolver,
} from "./rate-limit.js";

export type ActionRunContext<
  TPlayer = unknown,
  TSignals extends SignalRegistry = SignalRegistry,
> = {
  readonly player?: TPlayer;
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
};

// Like ActionRunContext but with `publisher` guaranteed present and typed against
// a concrete signal registry and player. Produced by `createActionDefiner<TSignals,
// TPlayer>()`, whose authored action's `TPlayer` matches the app, so the precise
// player typing introduces no variance hazard. Defined as an intersection so it
// stays a structural subtype of ActionRunContext (the definer returns it as one).
export type PublishingActionRunContext<
  TPlayer,
  TSignals extends SignalRegistry,
> = ActionRunContext<TPlayer, TSignals> & {
  readonly publisher: RemoteSignalPublisher<TSignals, TPlayer>;
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

  assertSerializableActionValue(input, "input", actionId);

  if (action.input !== undefined) {
    assertSchema(action.input, input, { actionId, role: "input" });
  }

  // A per-action `rateLimit` always wins; otherwise fall back to the app-wide
  // default. Only when neither is present is the action left unthrottled.
  const effectiveRateLimit = action.rateLimit ?? options?.defaultRateLimit;
  if (effectiveRateLimit !== undefined) {
    const rateLimiter = options?.rateLimiter ?? defaultActionRateLimiter;
    const rateLimitKey = options?.rateLimitKey ?? defaultActionRateLimitKeyResolver<TPlayer>;
    const result = rateLimiter.check(
      actionId,
      rateLimitKey(actionId, ctx),
      effectiveRateLimit,
      options?.nowMs?.(),
    );

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

  // Inject the app-owned publisher into the ctx so `run` can publish signals.
  // Only fills it in when the caller did not already supply one — a custom
  // `createContext` always wins.
  const runCtx =
    options?.publisher !== undefined && ctx.publisher === undefined
      ? { ...ctx, publisher: options.publisher }
      : ctx;

  const output = await Promise.resolve(action.run(runCtx, input));

  if (action.output !== undefined) {
    assertSchema(action.output, output, { actionId, role: "output" });
  }

  assertSerializableActionValue(output, "output", actionId);

  return output;
}
