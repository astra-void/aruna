// The public/internal split for action errors.
//
// Only an error that carries the brand reaches a client with its own `name` and
// `message`: the framework's own failures (validation, serialization, rate
// limiting, an unknown action, a timeout) and anything an action throws through
// `actionError`. Everything else is reported to the client as
// `ActionInternalError` with an `errorId`, because an internal message can
// carry server detail the client has no business seeing. On Roblox that
// includes a script path and line number. Mirrors the native runtime.

export const ACTION_INTERNAL_ERROR_NAME = "ActionInternalError";
export const ACTION_INTERNAL_ERROR_MESSAGE = "internal error";

// The brand field. A plain string key, not a symbol, so the native runtime's
// Luau tables can carry the same field.
export const ACTION_ERROR_BRAND = "__arunaActionError";

// An error whose `name` and `message` are safe to send to the client.
export class PublicActionError extends Error {
  override readonly name: string;
  readonly __arunaActionError = true as const;

  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

// Builds an error the client is meant to see:
// `throw actionError("OutOfStock", "Item is sold out")`. The client's rejection
// carries this `name` and `message`.
export function actionError(name: string, message: string): PublicActionError {
  return new PublicActionError(name, message);
}

export function isPublicActionError(
  value: unknown,
): value is { readonly name: string; readonly message: string } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as { name?: unknown; message?: unknown; [ACTION_ERROR_BRAND]?: unknown };
  return (
    record[ACTION_ERROR_BRAND] === true &&
    typeof record.name === "string" &&
    typeof record.message === "string"
  );
}

// What dispatch throws in place of a non-public error when internal errors are
// not exposed. The original is kept as `cause` for server-side callers of
// `app.dispatch`; the wire carries only the name, message, and `errorId`.
export class ActionInternalError extends Error {
  override readonly name = ACTION_INTERNAL_ERROR_NAME;
  readonly errorId: string;
  readonly cause: unknown;

  constructor(errorId: string, cause: unknown) {
    super(ACTION_INTERNAL_ERROR_MESSAGE);
    this.errorId = errorId;
    this.cause = cause;
  }
}

// A short id that ties a client's `ActionInternalError` to the server's
// `onError` report. Not a secret and not unique across servers: it only has to
// tell one failure in a log from the next. Same shape as the native runtime's.
export function createErrorId(): string {
  const half = () =>
    Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, "0");
  return `${half()}${half()}`;
}
