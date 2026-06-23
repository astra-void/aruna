import { assertSchema, type InferSchema, type Schema } from "../schema/index.js";
import { assertSerializableActionValue } from "./serialization.js";
import {
  ActionRateLimitError,
  createActionRateLimiter,
  defaultActionRateLimitKeyResolver,
  type ActionRateLimitKeyResolver,
  type ActionRateLimitOptions,
  type ActionRateLimiter,
} from "./rate-limit.js";

export {
  ActionRateLimitError,
  createActionRateLimiter,
  defaultActionRateLimitKeyResolver,
} from "./rate-limit.js";
export type {
  ActionRateLimitConfig,
  ActionRateLimitKeyResolver,
  ActionRateLimitOptions,
  ActionRateLimitResult,
  ActionRateLimiter,
} from "./rate-limit.js";

export type ActionRunContext<TPlayer = unknown> = {
  player?: TPlayer;
};

type ActionSchemaInput<TSchema extends Schema | undefined> = [TSchema] extends [Schema]
  ? InferSchema<TSchema>
  : unknown;

type ActionSchemaOutput<TSchema extends Schema | undefined> = [TSchema] extends [Schema]
  ? InferSchema<TSchema>
  : unknown;

export type ActionDefinition<
  TInputSchema extends Schema | undefined = undefined,
  TOutputSchema extends Schema | undefined = undefined,
  TPlayer = unknown,
> = {
  readonly id: string;
  readonly rateLimit?: ActionRateLimitOptions;
  readonly input?: TInputSchema;
  readonly output?: TOutputSchema;
  run(
    ctx: ActionRunContext<TPlayer>,
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
  readonly rateLimitKey?: ActionRateLimitKeyResolver<TPlayer>;
  // Applied to any action that does not declare its own `rateLimit`. A
  // per-action `rateLimit` always takes precedence over this fallback.
  readonly defaultRateLimit?: ActionRateLimitOptions;
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

  const output = await Promise.resolve(action.run(ctx, input));

  if (action.output !== undefined) {
    assertSchema(action.output, output, { actionId, role: "output" });
  }

  assertSerializableActionValue(output, "output", actionId);

  return output;
}
