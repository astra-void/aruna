import type { ActionRegistry, ActionRunContext } from "../runtime/server.js";
import { dispatchAction } from "../runtime/server.js";
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
};

export function createServerApp<
  TPlayer = unknown,
  TActions extends ActionRegistry<TPlayer> = ActionRegistry<TPlayer>,
>(options: CreateServerAppOptions<TPlayer, TActions>): ServerApp<TPlayer, TActions> {
  return {
    actions: options.actions,
    dispatch(actionId, ctx, input) {
      return dispatchAction(options.actions, actionId, ctx, input);
    },
    bind(binder) {
      return normalizeServerBinding(binder(options.actions));
    },
  };
}
