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

// Cancels a pending scheduled timeout. Returned by ActionTimeoutScheduler.
export type ActionTimeoutCanceler = () => void;

// Schedules `callback` to run after `delayMs` milliseconds and returns a
// canceler. Injectable so the same invoker works under Node (setTimeout) and
// the roblox-ts native runtime (task.delay), which share no timer global, and
// so tests can drive timers deterministically.
export type ActionTimeoutScheduler = (
  callback: () => void,
  delayMs: number,
) => ActionTimeoutCanceler;

// Recommended request timeout. Timeouts are opt-in: invoke() arms a timer only
// when requestTimeoutMs is a positive number; 0 or undefined keeps the
// historical "wait for the response forever" behavior.
export const DEFAULT_ACTION_REQUEST_TIMEOUT_MS = 10_000;

export class TimeoutError extends Error {
  override readonly name = "ActionTimeoutError";
  readonly actionId: string;
  readonly timeoutMs: number;

  constructor(actionId: string, timeoutMs: number) {
    super(`Aruna action ${actionId} timed out after ${timeoutMs}ms.`);
    this.actionId = actionId;
    this.timeoutMs = timeoutMs;
  }
}

export type RemoteEventActionInvokerOptions = {
  readonly createRequestId?: RemoteEventRequestIdFactory;
  // Milliseconds to wait for a server response before rejecting with
  // TimeoutError. 0 or undefined (the default) disables the timeout.
  readonly requestTimeoutMs?: number;
  // Overrides how request timeouts are scheduled. Defaults to a setTimeout
  // based scheduler; inject this under Luau or to drive timers in tests.
  readonly scheduleTimeout?: ActionTimeoutScheduler;
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

function createDefaultTimeoutScheduler(): ActionTimeoutScheduler {
  return (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(handle);
    };
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isValidRequestEnvelope(value: unknown): value is RemoteEventActionRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { readonly requestId?: unknown; readonly actionId?: unknown };
  return isString(candidate.requestId) && isString(candidate.actionId);
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
  const requestTimeoutMs = options?.requestTimeoutMs ?? 0;
  const scheduleTimeout = options?.scheduleTimeout ?? createDefaultTimeoutScheduler();
  type PendingRequest = {
    readonly resolve: (value: unknown) => void;
    readonly reject: (reason: unknown) => void;
    cancelTimeout?: ActionTimeoutCanceler;
  };
  const pendingRequests = new Map<string, PendingRequest>();
  let disposed = false;

  const connection = remote.OnClientEvent.Connect((response) => {
    const pending = pendingRequests.get(response.requestId);

    if (pending === undefined) {
      return;
    }

    pendingRequests.delete(response.requestId);
    pending.cancelTimeout?.();

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
      const pending: PendingRequest = { resolve, reject };
      pendingRequests.set(requestId, pending);

      try {
        remote.FireServer({
          requestId,
          actionId,
          input,
        });
      } catch (error) {
        pendingRequests.delete(requestId);
        reject(error);
        return;
      }

      // The response may have already settled synchronously during FireServer
      // (some in-process transports emit immediately). Only arm a timer if the
      // request is still pending.
      if (requestTimeoutMs > 0 && pendingRequests.get(requestId) === pending) {
        pending.cancelTimeout = scheduleTimeout(() => {
          if (pendingRequests.get(requestId) !== pending) {
            return;
          }

          pendingRequests.delete(requestId);
          reject(new TimeoutError(actionId, requestTimeoutMs));
        }, requestTimeoutMs);
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
        pending.cancelTimeout?.();
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
    // Clients can fire arbitrary payloads. Reject malformed envelopes before
    // touching the registry: respond with an error when there is a usable
    // requestId to address, otherwise drop the packet entirely.
    if (!isValidRequestEnvelope(request)) {
      const requestId = (request as { readonly requestId?: unknown } | null | undefined)?.requestId;

      if (isString(requestId)) {
        remote.FireClient(player, {
          requestId,
          ok: false,
          error: {
            message: "Invalid Aruna action request envelope.",
            name: "ActionRequestError",
          },
        });
      }

      return;
    }

    const context = options?.createContext?.(player) ?? ({ player } as ActionRunContext<TPlayer>);

    try {
      const dispatchOptions =
        options === undefined
          ? undefined
          : ({
              ...(options.rateLimiter !== undefined ? { rateLimiter: options.rateLimiter } : {}),
              ...(options.rateLimitKey !== undefined ? { rateLimitKey: options.rateLimitKey } : {}),
              ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
            } satisfies DispatchActionOptions<TPlayer>);
      const output = await dispatchAction(
        registry,
        request.actionId,
        context,
        request.input,
        dispatchOptions,
      );

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
