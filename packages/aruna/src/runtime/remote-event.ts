import { createServerBinding, type ServerBinding } from "./binding.js";
import { ActionRateLimitError } from "./rate-limit.js";
import {
  ACTION_CANCELLED_ERROR_NAME,
  ACTION_VERSION_MISMATCH_ERROR_NAME,
  type ActionInvoker,
  type ContractHandshakeOptions,
  type VersionMismatchInfo,
} from "./client.js";
import {
  dispatchAction,
  type ActionRateLimitOptions,
  type ActionRateLimiter,
  type ActionRegistry,
  type ActionRunContext,
  type DispatchActionOptions,
  type RateLimitKeyResolver,
} from "./server.js";

export type RemoteEventActionRequest = {
  readonly requestId: string;
  readonly actionId: string;
  readonly input: unknown;
};

export type RemoteEventActionErrorPayload = {
  readonly message: string;
  readonly name?: string;
  // Present on rate-limit rejections so the client can back off precisely
  // instead of string-matching the message.
  readonly retryAfterMs?: number;
  readonly resetAtMs?: number;
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

// The default request timeout, applied when requestTimeoutMs is not given.
// Pass requestTimeoutMs: 0 to explicitly opt out (wait forever).
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

// Rejection raised when a pending two-way invoke is cancelled via its
// CancelToken. The native runtime rejects a plain { message, name } object with
// the same name; detect either with `isActionCancelledError`, not `instanceof`.
export class ActionCancelledError extends Error {
  override readonly name = ACTION_CANCELLED_ERROR_NAME;
  readonly actionId: string;

  constructor(actionId: string) {
    super(`Aruna action ${actionId} was cancelled.`);
    this.actionId = actionId;
  }
}

// Rejection raised for every invoke when the client's contract hash disagreed
// with the server's and `rejectOnMismatch` was set. Detect via
// `isActionVersionMismatchError`, never `instanceof` (the native runtime rejects
// a plain object with the same name).
export class ActionVersionMismatchError extends Error {
  override readonly name = ACTION_VERSION_MISMATCH_ERROR_NAME;
  readonly expected: string;
  readonly actual: string;

  constructor(info: VersionMismatchInfo) {
    super(`Aruna contract mismatch: client ${info.expected} vs server ${info.actual}.`);
    this.expected = info.expected;
    this.actual = info.actual;
  }
}

export type ActionInvokerOptions = ContractHandshakeOptions & {
  readonly createRequestId?: RemoteEventRequestIdFactory;
  // Milliseconds to wait for a server response before rejecting with
  // TimeoutError. Defaults to DEFAULT_ACTION_REQUEST_TIMEOUT_MS (10s); pass 0
  // to disable the timeout entirely.
  readonly requestTimeoutMs?: number;
  // Overrides how request timeouts are scheduled. Defaults to a setTimeout
  // based scheduler; inject this under Luau or to drive timers in tests.
  readonly scheduleTimeout?: ActionTimeoutScheduler;
  // Reads the server's advertised contract hash for the boot handshake. The
  // native runtime reads a RemoteEvent attribute directly; the reference
  // runtime's transport is abstract, so the source is injected (undefined = the
  // server advertised nothing). Only consulted when `expectedContractHash` is set.
  readonly fetchServerContractHash?: () => string | undefined;
};

export type DisposableActionInvoker = ActionInvoker & {
  readonly dispose: () => void;
};

export type ActionContextFactory<TPlayer = unknown> = (
  player: TPlayer,
) => ActionRunContext<TPlayer>;

export type BindActionsOptions<TPlayer = unknown> = {
  readonly createContext?: ActionContextFactory<TPlayer>;
  readonly rateLimiter?: ActionRateLimiter;
  readonly rateLimitKey?: RateLimitKeyResolver<TPlayer>;
  // Applied to any action that does not declare its own `rateLimit`. A
  // per-action `rateLimit` always takes precedence over this fallback. Forwarded
  // straight into the dispatch options so a config-level `defaultRateLimit`
  // actually throttles the wire, not just the in-process `dispatch` helper.
  readonly defaultRateLimit?: ActionRateLimitOptions;
  // The app-owned signal publisher, forwarded into dispatch so a wire-dispatched
  // action's `ctx.publisher` is the same one `app.dispatch` injects. Set by
  // `createServerApp` via the transport's dispatch options.
  readonly publisher?: DispatchActionOptions<TPlayer>["publisher"];
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
  if (error instanceof ActionRateLimitError) {
    return {
      message: error.message,
      name: error.name,
      retryAfterMs: error.retryAfterMs,
      resetAtMs: error.resetAtMs,
    };
  }

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
  options?: ActionInvokerOptions,
): DisposableActionInvoker {
  const createRequestId = options?.createRequestId ?? createDefaultRequestId;
  // Timeouts are on by default: a dropped response (disconnect, server crash
  // mid-dispatch) must not leave the caller pending forever. Pass 0 to opt out.
  const requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_ACTION_REQUEST_TIMEOUT_MS;
  const scheduleTimeout = options?.scheduleTimeout ?? createDefaultTimeoutScheduler();

  // Contract handshake: compare the client's compiled-in hash against the one the
  // server advertised. A mismatch fires the callback once; a server advertising
  // nothing (older build) is unknown, not a mismatch.
  let versionMismatch: VersionMismatchInfo | undefined;
  if (options?.expectedContractHash !== undefined) {
    const actual = options.fetchServerContractHash?.();
    if (typeof actual === "string" && actual !== options.expectedContractHash) {
      versionMismatch = { expected: options.expectedContractHash, actual };
      options.onVersionMismatch?.(versionMismatch);
    }
  }
  const rejectOnMismatch = versionMismatch !== undefined && options?.rejectOnMismatch === true;
  type PendingRequest = {
    readonly resolve: (value: unknown) => void;
    readonly reject: (reason: unknown) => void;
    cancelTimeout?: ActionTimeoutCanceler;
    // Removes the CancelToken listener when the request settles by any means,
    // so a resolved/timed-out request does not keep the token subscribed.
    unsubscribeCancel?: () => void;
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
    pending.unsubscribeCancel?.();

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

    // Rate-limit metadata survives the wire so callers can back off precisely.
    if (typeof response.error.retryAfterMs === "number") {
      Object.assign(error, {
        retryAfterMs: response.error.retryAfterMs,
        ...(typeof response.error.resetAtMs === "number"
          ? { resetAtMs: response.error.resetAtMs }
          : {}),
      });
    }

    pending.reject(error);
  });

  const invoke: ActionInvoker = (actionId, input, invokeOptions) => {
    if (disposed) {
      return Promise.reject(new Error("RemoteEvent action invoker is disposed."));
    }

    // Hard-block every invoke when the contract hash mismatched and the caller
    // opted into rejecting; otherwise the mismatch is warn-only.
    if (rejectOnMismatch && versionMismatch !== undefined) {
      return Promise.reject(new ActionVersionMismatchError(versionMismatch));
    }

    const requestId = createRequestId();

    // Fire-and-forget: fire the request and resolve immediately. No pending
    // entry is registered (so the ignored server ack, if any, is dropped) and no
    // timeout is armed. Matches the server binder skipping its response.
    if (invokeOptions?.fireAndForget === true) {
      try {
        remote.FireServer({ requestId, actionId, input });
      } catch (error) {
        return Promise.reject(error);
      }
      return Promise.resolve(undefined);
    }

    return new Promise<unknown>((resolve, reject) => {
      const signal = invokeOptions?.signal;

      // Already cancelled before we fire: reject without touching the wire.
      if (signal?.isCancelled === true) {
        reject(new ActionCancelledError(actionId));
        return;
      }

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
      // (some in-process transports emit immediately). Only arm the timer and
      // cancellation listener if the request is still pending.
      if (pendingRequests.get(requestId) !== pending) {
        return;
      }

      if (signal !== undefined) {
        pending.unsubscribeCancel = signal.onCancel(() => {
          if (pendingRequests.get(requestId) !== pending) {
            return;
          }

          pendingRequests.delete(requestId);
          pending.cancelTimeout?.();
          reject(new ActionCancelledError(actionId));
        });
      }

      if (requestTimeoutMs > 0) {
        pending.cancelTimeout = scheduleTimeout(() => {
          if (pendingRequests.get(requestId) !== pending) {
            return;
          }

          pendingRequests.delete(requestId);
          pending.unsubscribeCancel?.();
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
        pending.unsubscribeCancel?.();
        pending.reject(new Error("RemoteEvent action invoker is disposed."));
      }
    },
  });
}

export function bindRemoteEventActions<TPlayer = unknown>(
  remote: RemoteEventServerLike<TPlayer>,
  registry: ActionRegistry<TPlayer>,
  options?: BindActionsOptions<TPlayer>,
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

    // Fire-and-forget actions are one-way: dispatch still runs (for its side
    // effects and rate limiting), but no response — success or error — is sent
    // back, since the client is not waiting for one.
    const fireAndForget = registry[request.actionId]?.fireAndForget === true;

    try {
      const dispatchOptions =
        options === undefined
          ? undefined
          : ({
              ...(options.rateLimiter !== undefined ? { rateLimiter: options.rateLimiter } : {}),
              ...(options.rateLimitKey !== undefined ? { rateLimitKey: options.rateLimitKey } : {}),
              ...(options.defaultRateLimit !== undefined
                ? { defaultRateLimit: options.defaultRateLimit }
                : {}),
              ...(options.publisher !== undefined ? { publisher: options.publisher } : {}),
              ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
            } satisfies DispatchActionOptions<TPlayer>);
      const output = await dispatchAction(
        registry,
        request.actionId,
        context,
        request.input,
        dispatchOptions,
      );

      if (!fireAndForget) {
        remote.FireClient(player, {
          requestId: request.requestId,
          ok: true,
          output,
        });
      }
    } catch (error) {
      if (!fireAndForget) {
        remote.FireClient(player, {
          requestId: request.requestId,
          ok: false,
          error: toRemoteEventErrorPayload(error),
        });
      }
    }
  });

  return createServerBinding(() => {
    connection.Disconnect();
  });
}
