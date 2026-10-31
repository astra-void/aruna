// Aruna roblox-ts native runtime — the public/internal split for action errors.
//
// Only an error that carries the brand reaches a client with its own `name` and
// `message`: the framework's own failures (validation, serialization, rate
// limiting, an unknown action) and anything an action throws through
// `actionError`. Everything else is reported to the client as
// `ActionInternalError` with an `errorId`, because a Luau runtime error carries
// the server script's path and line (`ServerScriptService.domains.shop.actions:42:
// attempt to index nil`).

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

// An error from an action's own `errors` declaration, thrown by
// `ctx.fail(name, data)`. Its `data` reaches the client, after the server has
// checked it against the declared schema.
export interface DeclaredActionError extends PublicActionError {
	readonly data?: unknown;
	readonly __arunaDeclared: true;
}

export function declaredActionError(name: string, data: unknown): DeclaredActionError {
	return {
		name,
		message: name,
		__arunaActionError: true,
		__arunaDeclared: true,
		...(data !== undefined ? { data } : {}),
	};
}

// Whether a public error came from `ctx.fail`, which only names declared errors.
export function isDeclaredActionError(failure: PublicActionError): failure is DeclaredActionError {
	return (failure as { readonly __arunaDeclared?: unknown }).__arunaDeclared === true;
}

// The `data` a public error carries, if any: what `ctx.fail` attached.
export function publicErrorData(failure: PublicActionError): unknown {
	return (failure as { readonly data?: unknown }).data;
}

// A short id that ties a client's `ActionInternalError` to the server's
// `onError` report. Not a secret and not unique across servers: it only has to
// tell one failure in a log from the next.
export function createErrorId(): string {
	return string.format("%04x%04x", math.random(0, 0xffff), math.random(0, 0xffff));
}
