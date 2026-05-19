import {
  dispatchAction,
  type ActionRegistry,
  type ActionRateLimitKeyResolver,
  type ActionRateLimiter,
  type ActionRunContext,
  type DispatchActionOptions,
} from "../runtime/server.js";
import { createActionRateLimiter } from "../runtime/rate-limit.js";
import { normalizeServerBinding, type ServerBinding } from "../runtime/binding.js";

export type { ServerBinding } from "../runtime/binding.js";

export type ServerActionBinder<
  TPlayer = unknown,
  TActions extends ActionRegistry<TPlayer> = ActionRegistry<TPlayer>,
> = (registry: TActions) => void | ServerBinding | (() => void);

export type ServerApp<
  TPlayer = unknown,
  TActions extends ActionRegistry<TPlayer> = ActionRegistry<TPlayer>,
> = {
  readonly actions: TActions;
  readonly dispatch: (
    actionId: string,
    ctx: ActionRunContext<TPlayer>,
    input: unknown,
  ) => Promise<unknown>;
  readonly bind: (binder: ServerActionBinder<TPlayer, TActions>) => ServerBinding;
};

export type CreateServerAppOptions<
  TPlayer = unknown,
  TActions extends ActionRegistry<TPlayer> = ActionRegistry<TPlayer>,
> = {
  readonly actions: TActions;
  readonly rateLimiter?: ActionRateLimiter;
  readonly rateLimitKey?: ActionRateLimitKeyResolver<TPlayer>;
  readonly nowMs?: () => number;
};

export function createServerApp<
  TPlayer = unknown,
  TActions extends ActionRegistry<TPlayer> = ActionRegistry<TPlayer>,
>(options: CreateServerAppOptions<TPlayer, TActions>): ServerApp<TPlayer, TActions> {
  const rateLimiter = options.rateLimiter ?? createActionRateLimiter();
  return {
    actions: options.actions,
    dispatch(actionId, ctx, input) {
      const dispatchOptions = {
        rateLimiter,
        ...(options.rateLimitKey !== undefined ? { rateLimitKey: options.rateLimitKey } : {}),
        ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
      } satisfies DispatchActionOptions<TPlayer>;
      return dispatchAction(options.actions, actionId, ctx, input, dispatchOptions);
    },
    bind(binder) {
      return normalizeServerBinding(binder(options.actions));
    },
  };
}
