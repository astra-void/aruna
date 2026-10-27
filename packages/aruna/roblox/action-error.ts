// Aruna roblox-ts native runtime — the public/internal split for action errors.
//
// Only an error that carries the brand reaches a client with its own `name` and
// `message`: the framework's own failures (validation, serialization, rate
// limiting, an unknown action) and anything an action throws through
// `actionError`. Everything else is reported to the client as
// `ActionInternalError` with an `errorId`, because a Luau runtime error carries
// the server script's path and line (`ServerScriptService.domains.shop.actions:42:
// attempt to index nil`). Mirrors the Node reference runtime.

export const ACTION_INTERNAL_ERROR_NAME = "ActionInternalError";
export const ACTION_INTERNAL_ERROR_MESSAGE = "internal error";

// An error whose `name` and `message` are safe to send to the client.
export interface PublicActionError {
	readonly name: string;
	readonly message: string;
	readonly __arunaActionError: true;
}

// Builds an error the client is meant to see:
// `throw actionError("OutOfStock", "Item is sold out")`. The client's rejection
// carries this `name` and `message`.
export function actionError(name: string, message: string): PublicActionError {
	return { name, message, __arunaActionError: true };
}

export function isPublicActionError(value: unknown): value is PublicActionError {
	if (!typeIs(value, "table")) {
		return false;
	}
	const record = value as { name?: unknown; message?: unknown; __arunaActionError?: unknown };
	return (
		record.__arunaActionError === true &&
		typeIs(record.name, "string") &&
		typeIs(record.message, "string")
	);
}

// A short id that ties a client's `ActionInternalError` to the server's
// `onError` report. Not a secret and not unique across servers: it only has to
// tell one failure in a log from the next.
export function createErrorId(): string {
	return string.format("%04x%04x", math.random(0, 0xffff), math.random(0, 0xffff));
}
