import type { ActionInvoker } from "./client.js";
import { dispatchAction, type ActionRegistry, type ActionRunContext } from "./server.js";

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
  createContext?: RemoteActionContextFactory<TPlayer>,
): RemoteFunctionBinding {
  const previousOnServerInvoke = remote.OnServerInvoke;
  let disposed = false;

  // Roblox RemoteFunction handlers may yield, so the async dispatch result is returned directly.
  const onServerInvoke = async (player: RobloxPlayer, actionId: string, input: unknown): Promise<unknown> => {
    const context = createContext?.(player) ?? ({ player } as ActionRunContext<TPlayer>);

    return await dispatchAction(registry, actionId, context, input);
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
