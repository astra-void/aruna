import type { ActionInvoker } from "./client.js";
import {
  dispatchAction,
  type ActionRateLimitKeyResolver,
  type ActionRateLimiter,
  type ActionRegistry,
  type ActionRunContext,
  type DispatchActionOptions,
} from "./server.js";

export type RobloxPlayer = Player;
export type RobloxRemoteFunction = RemoteFunction;

export type RemoteFunctionClientLike = {
  InvokeServer: (actionId: string, input: unknown) => unknown;
};

export type RemoteFunctionServerLike = {
  OnServerInvoke?:
    | ((player: RobloxPlayer, actionId: string, input: unknown) => unknown)
    | undefined;
};

export type RemoteFunctionBinding = {
  readonly dispose: () => void;
};

export type RemoteActionContextFactory<TPlayer = RobloxPlayer> = (
  player: RobloxPlayer,
) => ActionRunContext<TPlayer>;

export type BindRemoteFunctionActionsOptions<TPlayer = RobloxPlayer> = {
  readonly createContext?: RemoteActionContextFactory<TPlayer>;
  readonly rateLimiter?: ActionRateLimiter;
  readonly rateLimitKey?: ActionRateLimitKeyResolver<TPlayer>;
  readonly nowMs?: () => number;
};

export function createRemoteFunctionActionInvoker(remote: RemoteFunctionClientLike): ActionInvoker {
  return async (actionId: string, input: unknown): Promise<unknown> => {
    return await Promise.resolve(remote.InvokeServer(actionId, input));
  };
}

export function bindRemoteFunctionActions<
  TPlayer = RobloxPlayer,
  TActions extends ActionRegistry<TPlayer> = ActionRegistry<TPlayer>,
>(
  remote: RemoteFunctionServerLike,
  registry: TActions,
  options?: BindRemoteFunctionActionsOptions<TPlayer> | RemoteActionContextFactory<TPlayer>,
): RemoteFunctionBinding {
  const resolvedOptions =
    typeof options === "function" ? { createContext: options } : options;
  const previousOnServerInvoke = remote.OnServerInvoke;
  let disposed = false;

  // Roblox RemoteFunction handlers may yield, so the async dispatch result is returned directly.
  const onServerInvoke = async (player: RobloxPlayer, actionId: string, input: unknown): Promise<unknown> => {
    const context =
      resolvedOptions?.createContext?.(player) ?? ({ player } as ActionRunContext<TPlayer>);

    const dispatchOptions =
      resolvedOptions === undefined
        ? undefined
        : ({
            ...(resolvedOptions.rateLimiter !== undefined
              ? { rateLimiter: resolvedOptions.rateLimiter }
              : {}),
            ...(resolvedOptions.rateLimitKey !== undefined
              ? { rateLimitKey: resolvedOptions.rateLimitKey }
              : {}),
            ...(resolvedOptions.nowMs !== undefined ? { nowMs: resolvedOptions.nowMs } : {}),
          } satisfies DispatchActionOptions<TPlayer>);

    return await dispatchAction(registry, actionId, context, input, dispatchOptions);
  };

  remote.OnServerInvoke = onServerInvoke;

  return {
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;

      if (previousOnServerInvoke === undefined) {
        remote.OnServerInvoke = undefined;
        return;
      }

      remote.OnServerInvoke = previousOnServerInvoke;
    },
  };
}

export function unbindRemoteFunctionActions(remote: RemoteFunctionServerLike): void {
  remote.OnServerInvoke = undefined;
}
