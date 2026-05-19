import { createServerBinding, type ServerBinding } from "./binding.js";
import type { ActionInvoker } from "./client.js";
import {
  dispatchAction,
  type ActionRateLimitKeyResolver,
  type ActionRateLimiter,
  type ActionRegistry,
  type ActionRunContext,
  type DispatchActionOptions,
} from "./server.js";

export type RemoteEventActionRequest = {
  readonly requestId: string;
  readonly actionId: string;
  readonly input: unknown;
};

export type RemoteEventActionErrorPayload = {
  readonly message: string;
  readonly name?: string;
};

export type RemoteEventActionResponse =
  | {
      readonly requestId: string;
      readonly ok: true;
      readonly output: unknown;
    }
  | {
      readonly requestId: string;
      readonly ok: false;
      readonly error: RemoteEventActionErrorPayload;
    };

export type RemoteEventSignalConnectionLike = {
  readonly Disconnect: () => void;
};

export type RemoteEventSignalLike<TArgs extends readonly unknown[]> = {
  readonly Connect: (callback: (...args: TArgs) => void) => RemoteEventSignalConnectionLike;
};

export type RemoteEventClientLike = {
  readonly FireServer: (request: RemoteEventActionRequest) => void;
  readonly OnClientEvent: RemoteEventSignalLike<[RemoteEventActionResponse]>;
};

export type RemoteEventServerLike<TPlayer = unknown> = {
  readonly FireClient: (player: TPlayer, response: RemoteEventActionResponse) => void;
  readonly OnServerEvent: RemoteEventSignalLike<[TPlayer, RemoteEventActionRequest]>;
};

export type RemoteEventRequestIdFactory = () => string;

export type RemoteEventActionInvokerOptions = {
  readonly createRequestId?: RemoteEventRequestIdFactory;
};

export type DisposableActionInvoker = ActionInvoker & {
  readonly dispose: () => void;
};

export type RemoteEventActionContextFactory<TPlayer = unknown> = (
  player: TPlayer,
) => ActionRunContext<TPlayer>;

export type BindRemoteEventActionsOptions<TPlayer = unknown> = {
  readonly createContext?: RemoteEventActionContextFactory<TPlayer>;
  readonly rateLimiter?: ActionRateLimiter;
  readonly rateLimitKey?: ActionRateLimitKeyResolver<TPlayer>;
  readonly nowMs?: () => number;
};

let nextRequestId = 0;

function createDefaultRequestId(): string {
  nextRequestId += 1;
  return `aruna:${nextRequestId}`;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function toRemoteEventErrorPayload(error: unknown): RemoteEventActionErrorPayload {
  if (error instanceof Error) {
    if (isString(error.name)) {
      return {
        message: error.message,
        name: error.name,
      };
    }

    return {
      message: error.message,
    };
  }

  return {
    message: "Unknown Aruna action error.",
  };
}

export function createRemoteEventActionInvoker(
  remote: RemoteEventClientLike,
  options?: RemoteEventActionInvokerOptions,
): DisposableActionInvoker {
  const createRequestId = options?.createRequestId ?? createDefaultRequestId;
  const pendingRequests = new Map<
    string,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (reason: unknown) => void;
    }
  >();
  let disposed = false;

  const connection = remote.OnClientEvent.Connect((response) => {
    const pending = pendingRequests.get(response.requestId);

    if (pending === undefined) {
      return;
    }

    pendingRequests.delete(response.requestId);

    if (response.ok) {
      pending.resolve(response.output);
      return;
    }

    const error = new Error(response.error.message);

    if (isString(response.error.name)) {
      Object.defineProperty(error, "name", {
        configurable: true,
        value: response.error.name,
      });
    }

    pending.reject(error);
  });

  const invoke: ActionInvoker = (actionId, input) => {
    if (disposed) {
      return Promise.reject(new Error("RemoteEvent action invoker is disposed."));
    }

    const requestId = createRequestId();

    return new Promise<unknown>((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject });

      try {
        remote.FireServer({
          requestId,
          actionId,
          input,
        });
      } catch (error) {
        pendingRequests.delete(requestId);
        reject(error);
      }
    });
  };

  return Object.assign(invoke, {
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      connection.Disconnect();

      for (const [requestId, pending] of pendingRequests) {
        pendingRequests.delete(requestId);
        pending.reject(new Error("RemoteEvent action invoker is disposed."));
      }
    },
  });
}

export function bindRemoteEventActions<TPlayer = unknown>(
  remote: RemoteEventServerLike<TPlayer>,
  registry: ActionRegistry<TPlayer>,
  options?: BindRemoteEventActionsOptions<TPlayer>,
): ServerBinding {
  const connection = remote.OnServerEvent.Connect(async (player, request) => {
    const context = options?.createContext?.(player) ?? ({ player } as ActionRunContext<TPlayer>);

    try {
      const dispatchOptions =
        options === undefined
          ? undefined
          : ({
              ...(options.rateLimiter !== undefined ? { rateLimiter: options.rateLimiter } : {}),
              ...(options.rateLimitKey !== undefined
                ? { rateLimitKey: options.rateLimitKey }
                : {}),
              ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
            } satisfies DispatchActionOptions<TPlayer>);
      const output = await dispatchAction(registry, request.actionId, context, request.input, dispatchOptions);

      remote.FireClient(player, {
        requestId: request.requestId,
        ok: true,
        output,
      });
    } catch (error) {
      remote.FireClient(player, {
        requestId: request.requestId,
        ok: false,
        error: toRemoteEventErrorPayload(error),
      });
    }
  });

  return createServerBinding(() => {
    connection.Disconnect();
  });
}
