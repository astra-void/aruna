// Aruna roblox-ts native runtime — per-action rate limiter: fixed windows by
// default, or token buckets (`strategy: "tokenBucket"`).

import type { ActionRateLimitKeyFn, ActionRateLimitKeyInfo, ActionRateLimitOptions } from "./server";

interface FixedWindowBucket {
	readonly kind: "fixedWindow";
	windowStart: number;
	windowSeconds: number;
	count: number;
}

interface TokenBucket {
	readonly kind: "tokenBucket";
	tokens: number;
	refilledAt: number;
	capacity: number;
	perSecond: number;
}

type RateLimitBucket = FixedWindowBucket | TokenBucket;

// Structured check result: a rejection
// carries when the caller may retry, so the wire can surface it to the client.
export type RateLimitCheckResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly retryAfterMs: number; readonly resetAtMs: number };

export interface ActionRateLimiter {
	// `nowSeconds` overrides the clock, so a caller that owns time — the test
	// harness, which freezes it and advances on demand — gets a deterministic
	// window instead of one that only elapses in real time. Defaults to
	// os.clock(), which is what a game always uses.
	readonly check: (
		actionId: string,
		key: string,
		options: ActionRateLimitOptions,
		nowSeconds?: number,
	) => RateLimitCheckResult;
	// Removes buckets that hold nothing a fresh one would not — a fixed window
	// that has fully elapsed, a token bucket that has refilled — at `now`
	// (seconds, defaults to os.clock()), and returns how many were removed.
	readonly purge: (now?: number) => number;
}

// A token bucket's level after `elapsed` (in whatever unit `rate` counts per),
// capped at `capacity`. The request guard's envelope budget refills the same way.
export function refilledTokens(tokens: number, elapsed: number, rate: number, capacity: number): number {
	return math.min(capacity, tokens + math.max(0, elapsed) * rate);
}

function bucketId(actionId: string, key: string): string {
	return `${actionId}::${key}`;
}

// When a bucket stops holding anything a fresh one would not.
function idleAt(bucket: RateLimitBucket): number {
	if (bucket.kind === "fixedWindow") {
		return bucket.windowStart + bucket.windowSeconds;
	}
	return bucket.refilledAt + (bucket.capacity - bucket.tokens) / bucket.perSecond;
}

function checkFixedWindow(
	buckets: Map<string, RateLimitBucket>,
	id: string,
	options: ActionRateLimitOptions,
	now: number,
): RateLimitCheckResult {
	const windowSeconds = options.windowMs / 1000;
	const windowStart = math.floor(now / windowSeconds) * windowSeconds;
	const bucket = buckets.get(id);

	if (bucket === undefined || bucket.kind !== "fixedWindow" || bucket.windowStart !== windowStart) {
		buckets.set(id, { kind: "fixedWindow", windowStart, windowSeconds, count: 1 });
		return { ok: true };
	}

	if (bucket.count >= options.max) {
		const resetAtSeconds = bucket.windowStart + bucket.windowSeconds;
		const retryAfterMs = math.max(0, math.floor((resetAtSeconds - now) * 1000));
		return { ok: false, retryAfterMs, resetAtMs: math.floor(resetAtSeconds * 1000) };
	}

	bucket.count += 1;
	return { ok: true };
}

// A bucket starts full. Each call takes a token; tokens come back at
// `max / windowMs`. A refusal says when the next token arrives — rounded up, so
// a retry at `retryAfterMs` finds one.
function checkTokenBucket(
	buckets: Map<string, RateLimitBucket>,
	id: string,
	options: ActionRateLimitOptions,
	now: number,
): RateLimitCheckResult {
	const capacity = options.max;
	const perSecond = options.max / (options.windowMs / 1000);
	let bucket = buckets.get(id);
	if (bucket === undefined || bucket.kind !== "tokenBucket") {
		bucket = { kind: "tokenBucket", tokens: capacity, refilledAt: now, capacity, perSecond };
		buckets.set(id, bucket);
	} else {
		bucket.tokens = refilledTokens(bucket.tokens, now - bucket.refilledAt, perSecond, capacity);
		bucket.refilledAt = now;
		bucket.capacity = capacity;
		bucket.perSecond = perSecond;
	}

	if (bucket.tokens >= 1) {
		bucket.tokens -= 1;
		return { ok: true };
	}

	const retryAfterMs = math.max(0, math.ceil(((1 - bucket.tokens) / perSecond) * 1000));
	return { ok: false, retryAfterMs, resetAtMs: math.floor(now * 1000) + retryAfterMs };
}

export function createActionRateLimiter(): ActionRateLimiter {
	const buckets = new Map<string, RateLimitBucket>();
	let lastPurge = -math.huge;

	function purgeIdle(now: number): number {
		const idle = new Array<string>();
		for (const [id, bucket] of buckets) {
			if (idleAt(bucket) <= now) {
				idle.push(id);
			}
		}
		for (const id of idle) {
			buckets.delete(id);
		}
		return idle.size();
	}

	return {
		check: (actionId, key, options, nowSeconds) => {
			const windowSeconds = options.windowMs / 1000;
			const now = nowSeconds !== undefined ? nowSeconds : os.clock();

			// Opportunistic cleanup, at most once per window, so abandoned keys
			// (e.g. players who left) do not accumulate.
			if (now - lastPurge >= windowSeconds) {
				purgeIdle(now);
				lastPurge = now;
			}

			const id = bucketId(actionId, key);
			return options.strategy === "tokenBucket"
				? checkTokenBucket(buckets, id, options, now)
				: checkFixedWindow(buckets, id, options, now);
		},
		purge: (now) => {
			return purgeIdle(now !== undefined ? now : os.clock());
		},
	};
}

export function resolveRateLimitKey(
	options: ActionRateLimitOptions,
	info: ActionRateLimitKeyInfo,
): string {
	const key = options.key;
	// A per-action custom key function is most specific and wins.
	if (typeIs(key, "function")) {
		return (key as ActionRateLimitKeyFn)(info);
	}
	if (key === "global") {
		return "global";
	}
	const candidate = info.player as { UserId?: number } | undefined;
	if (candidate !== undefined && candidate.UserId !== undefined) {
		return `player:${candidate.UserId}`;
	}
	return `player:${tostring(info.player)}`;
}
