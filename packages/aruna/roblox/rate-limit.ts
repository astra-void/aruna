// Aruna roblox-ts native runtime — per-action fixed-window rate limiter.

import type { ActionRateLimitOptions } from "./server";

interface RateLimitBucket {
	windowStart: number;
	windowSeconds: number;
	count: number;
}

export interface ActionRateLimiter {
	readonly check: (actionId: string, key: string, options: ActionRateLimitOptions) => boolean;
	// Removes buckets whose window has fully elapsed at `now` (seconds, defaults
	// to os.clock()) and returns how many were removed. Mirrors the Node
	// reference runtime's leftover-key cleanup path.
	readonly purge: (now?: number) => number;
}

function bucketId(actionId: string, key: string): string {
	return `${actionId}::${key}`;
}

export function createActionRateLimiter(): ActionRateLimiter {
	const buckets = new Map<string, RateLimitBucket>();
	let lastPurge = -math.huge;

	function purgeExpired(now: number): number {
		const expired = new Array<string>();
		for (const [id, bucket] of buckets) {
			if (bucket.windowStart + bucket.windowSeconds <= now) {
				expired.push(id);
			}
		}
		for (const id of expired) {
			buckets.delete(id);
		}
		return expired.size();
	}

	return {
		check: (actionId, key, options) => {
			const windowSeconds = options.windowMs / 1000;
			const now = os.clock();

			// Opportunistic cleanup, at most once per window, so abandoned keys
			// (e.g. players who left) do not accumulate.
			if (now - lastPurge >= windowSeconds) {
				purgeExpired(now);
				lastPurge = now;
			}

			const windowStart = math.floor(now / windowSeconds) * windowSeconds;
			const id = bucketId(actionId, key);
			const bucket = buckets.get(id);

			if (bucket === undefined || bucket.windowStart !== windowStart) {
				buckets.set(id, { windowStart, windowSeconds, count: 1 });
				return true;
			}

			if (bucket.count >= options.max) {
				return false;
			}

			bucket.count += 1;
			return true;
		},
		purge: (now) => {
			return purgeExpired(now !== undefined ? now : os.clock());
		},
	};
}

export function resolveRateLimitKey(options: ActionRateLimitOptions, player: unknown): string {
	if (options.key === "global") {
		return "global";
	}
	const candidate = player as { UserId?: number } | undefined;
	if (candidate !== undefined && candidate.UserId !== undefined) {
		return `player:${candidate.UserId}`;
	}
	return `player:${tostring(player)}`;
}
