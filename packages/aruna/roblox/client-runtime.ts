// Aruna roblox-ts native runtime — client action invoker registry.

// A cooperative cancellation token. Pass one as `ActionInvokeOptions.signal` to
// abort a pending action invoke: the invoker stops waiting for the server ack
// and rejects with a cancellation error. Build one with `createCancelToken()`.
export interface CancelToken {
	// True once the token has been cancelled.
	readonly isCancelled: boolean;
	// Registers a listener run when the token is cancelled — synchronously, if it
	// is already cancelled at call time. Returns an unsubscribe function.
	readonly onCancel: (listener: () => void) => () => void;
}

// A cancel token paired with its trigger. `createCancelToken()` returns this;
// hand it to `invoke(..., { signal })` and call `cancel()` to abort. `cancel()`
// is idempotent.
export interface CancelTokenSource extends CancelToken {
	readonly cancel: () => void;
}

class CancelTokenSourceImpl implements CancelTokenSource {
	public isCancelled = false;
	private readonly listeners = new Set<() => void>();

	// Arrow-function fields (not methods): the CancelToken interface types these
	// as plain function properties, and roblox-ts rejects assigning a method
	// where a non-method is expected.
	public readonly onCancel = (listener: () => void): (() => void) => {
		if (this.isCancelled) {
			listener();
			return () => {};
		}
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	public readonly cancel = (): void => {
		if (this.isCancelled) {
			return;
		}
		this.isCancelled = true;
		for (const listener of this.listeners) {
			listener();
		}
		this.listeners.clear();
	};
}

// Creates a fresh cancellation token. The returned object is both the token
// (passed to invokes via `options.signal`) and its trigger (`cancel()`).
export function createCancelToken(): CancelTokenSource {
	return new CancelTokenSourceImpl();
}

// Error name carried by a cancelled-invoke rejection, on both runtimes. The
// native runtime rejects a plain { message, name } object; the Node reference
// runtime rejects an ActionCancelledError instance with the same name — so
// detect cancellation by name via `isActionCancelledError`, never a type check.
export const ACTION_CANCELLED_ERROR_NAME = "ActionCancelledError";

// Error names the default retry predicate treats as retryable. Rate-limit
// rejections also carry `retryAfterMs`, which the backoff honors.
const ACTION_RATE_LIMIT_ERROR_NAME = "ActionRateLimitError";
const ACTION_TIMEOUT_ERROR_NAME = "ActionTimeoutError";

// Error name carried by an invoke rejected because the client's compiled-in
// contract hash disagreed with the server's, and `rejectOnMismatch` was set.
export const ACTION_VERSION_MISMATCH_ERROR_NAME = "ActionVersionMismatchError";

// What `onVersionMismatch` receives: the client's expected contract hash and the
// server's actual one.
export interface VersionMismatchInfo {
	readonly expected: string;
	readonly actual: string;
}

// Handshake options shared by the client invoker and `createClientApp`. When
// `expectedContractHash` is set, the client compares it against the server's
// advertised contract hash on boot: on a mismatch it fires `onVersionMismatch`
// once and, if `rejectOnMismatch` is set, rejects every invoke with a
// version-mismatch error. A server that advertises no hash (older build) is
// treated as unknown, never a mismatch.
export interface ContractHandshakeOptions {
	readonly expectedContractHash?: string;
	readonly onVersionMismatch?: (info: VersionMismatchInfo) => void;
	readonly rejectOnMismatch?: boolean;
}

// True when `value` is a version-mismatch rejection from either runtime.
export function isActionVersionMismatchError(value: unknown): boolean {
	return (
		typeIs(value, "table") &&
		(value as { readonly name?: unknown }).name === ACTION_VERSION_MISMATCH_ERROR_NAME
	);
}

// True when `value` is a cancelled-invoke rejection from either runtime.
export function isActionCancelledError(value: unknown): boolean {
	return (
		typeIs(value, "table") &&
		(value as { readonly name?: unknown }).name === ACTION_CANCELLED_ERROR_NAME
	);
}

// Per-call invoke options. `fireAndForget` requests one-way delivery: the
// transport fires the request without waiting for (or expecting) a server ack.
// Generated client stubs for fire-and-forget actions pass `{ fireAndForget:
// true }`; the option is optional so existing two-way invokers are unaffected.
// `signal` supplies a cancellation token; cancelling it aborts a pending two-way
// invoke (fire-and-forget invokes ignore it — there is nothing to wait on).
export interface ActionInvokeOptions {
	readonly fireAndForget?: boolean;
	readonly signal?: CancelToken;
}

export type ActionInvoker = (
	actionId: string,
	input: unknown,
	options?: ActionInvokeOptions,
) => Promise<unknown>;

// What a client middleware layer observes about the call it wraps.
export type ClientActionInfo = {
	readonly actionId: string;
	readonly input: unknown;
	readonly options?: ActionInvokeOptions;
};

// Around-invoke middleware for the client transport: auth-token injection,
// logging, timing, request de-duplication. Applied outermost-first, wrapping the
// whole invoke. Short-circuit by rejecting (or by not calling `next`); observe or
// transform the result by awaiting `next()`. Mirrors the server ActionMiddleware.
export type ClientMiddleware = (
	info: ClientActionInfo,
	next: () => Promise<unknown>,
) => Promise<unknown>;

// Wraps an ActionInvoker with a middleware chain. `middleware[0]` is the
// outermost layer and the underlying invoker is the innermost `next`. Each layer
// is routed through a resolved promise so a synchronous throw becomes a
// rejection. Returns the invoker unchanged when there is no middleware.
export function withClientMiddleware(
	invoker: ActionInvoker,
	middleware: readonly ClientMiddleware[],
): ActionInvoker {
	if (middleware.size() === 0) {
		return invoker;
	}

	return (actionId, input, options) => {
		const info: ClientActionInfo = {
			actionId,
			input,
			...(options !== undefined ? { options } : {}),
		};

		let invoke = (): Promise<unknown> => invoker(actionId, input, options);
		for (let index = middleware.size() - 1; index >= 0; index -= 1) {
			const layer = middleware[index];
			if (layer === undefined) {
				continue;
			}
			const nextInvoke = invoke;
			invoke = () => Promise.resolve().then(() => layer(info, nextInvoke));
		}

		return invoke();
	};
}

// Opt-in automatic retry for client invokes. `maxRetries` is the number of
// retries after the first attempt (0 = disabled). Backoff for retry N (1-based)
// is `baseDelayMs * 2^(N-1)` capped at `maxDelayMs`; a rate-limit rejection's
// `retryAfterMs` overrides that when `respectRetryAfter` is set. `retryOn`
// decides which rejections are retryable — the default retries rate-limit and
// timeout errors and never retries cancellation.
export interface ClientRetryPolicy {
	readonly maxRetries: number;
	readonly baseDelayMs?: number;
	readonly maxDelayMs?: number;
	readonly respectRetryAfter?: boolean;
	readonly retryOn?: (error: unknown, attempt: number) => boolean;
}

const DEFAULT_RETRY_BASE_DELAY_MS = 200;
const DEFAULT_RETRY_MAX_DELAY_MS = 5_000;

function readNumber(value: unknown, key: string): number | undefined {
	if (!typeIs(value, "table")) {
		return undefined;
	}
	const candidate = (value as { readonly [index: string]: unknown })[key];
	return typeIs(candidate, "number") ? candidate : undefined;
}

// Rate-limit (carries retryAfterMs or the rate-limit name) and timeout
// rejections are retryable; everything else — validation, serialization,
// cancellation — is not.
function defaultRetryOn(value: unknown): boolean {
	if (!typeIs(value, "table")) {
		return false;
	}
	const name = (value as { readonly name?: unknown }).name;
	return (
		readNumber(value, "retryAfterMs") !== undefined ||
		name === ACTION_RATE_LIMIT_ERROR_NAME ||
		name === ACTION_TIMEOUT_ERROR_NAME
	);
}

// How long to wait before retry N (0-based `retryIndex`): a rate-limit
// `retryAfterMs` when present and honored, else exponential backoff.
function computeRetryDelayMs(
	value: unknown,
	retryIndex: number,
	baseDelayMs: number,
	maxDelayMs: number,
	respectRetryAfter: boolean,
): number {
	if (respectRetryAfter) {
		const retryAfterMs = readNumber(value, "retryAfterMs");
		if (retryAfterMs !== undefined && retryAfterMs >= 0) {
			return math.min(retryAfterMs, maxDelayMs);
		}
	}
	return math.min(baseDelayMs * 2 ** retryIndex, maxDelayMs);
}

// Native default delay: a task.delay-backed sleep (delayMs → seconds).
function defaultRetryDelay(delayMs: number): Promise<void> {
	return new Promise<void>((resolve) => {
		task.delay(delayMs / 1000, resolve);
	});
}

// Wraps an ActionInvoker so failed two-way invokes retry per `policy`. Compose
// this OUTSIDE middleware (`withRetry(withClientMiddleware(...))`) so each
// attempt re-runs middleware and re-mints the underlying request. Returns the
// invoker unchanged when retries are disabled. Fire-and-forget invokes are never
// retried (no ack confirms delivery), and a cancelled signal stops retrying.
export function withRetry(
	invoker: ActionInvoker,
	policy: ClientRetryPolicy,
	delay?: (delayMs: number) => Promise<void>,
): ActionInvoker {
	const maxRetries = policy.maxRetries;
	if (maxRetries <= 0) {
		return invoker;
	}
	const baseDelayMs = policy.baseDelayMs !== undefined ? policy.baseDelayMs : DEFAULT_RETRY_BASE_DELAY_MS;
	const maxDelayMs = policy.maxDelayMs !== undefined ? policy.maxDelayMs : DEFAULT_RETRY_MAX_DELAY_MS;
	const respectRetryAfter = policy.respectRetryAfter !== undefined ? policy.respectRetryAfter : true;
	const retryOn = policy.retryOn !== undefined ? policy.retryOn : defaultRetryOn;
	const sleep = delay !== undefined ? delay : defaultRetryDelay;

	return (actionId, input, options) => {
		// One-way requests carry no ack, so a "failure" cannot be observed and a
		// retry would silently double-send. Pass through untouched.
		if (options !== undefined && options.fireAndForget === true) {
			return invoker(actionId, input, options);
		}

		const attempt = (retryIndex: number): Promise<unknown> =>
			invoker(actionId, input, options).catch((rejection: unknown) => {
				// Never retry a cancellation, an exhausted budget, a non-retryable
				// error, or once the caller's signal has been cancelled.
				const signalCancelled =
					options !== undefined && options.signal !== undefined && options.signal.isCancelled;
				if (
					isActionCancelledError(rejection) ||
					retryIndex >= maxRetries ||
					signalCancelled ||
					!retryOn(rejection, retryIndex + 1)
				) {
					return Promise.reject(rejection);
				}

				const waitMs = computeRetryDelayMs(
					rejection,
					retryIndex,
					baseDelayMs,
					maxDelayMs,
					respectRetryAfter,
				);
				return sleep(waitMs).then(() => attempt(retryIndex + 1));
			});

		return attempt(0);
	};
}

let activeInvoker: ActionInvoker | undefined;

export function setActionInvoker(invoker: ActionInvoker): void {
	activeInvoker = invoker;
}

export function clearActionInvoker(): void {
	activeInvoker = undefined;
}

export function invokeAction(
	actionId: string,
	input: unknown,
	options?: ActionInvokeOptions,
): Promise<unknown> {
	const invoker = activeInvoker;
	if (invoker === undefined) {
		throw `Aruna action runtime is not installed: ${actionId}`;
	}
	return invoker(actionId, input, options);
}
