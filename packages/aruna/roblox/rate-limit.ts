// Aruna roblox-ts native runtime — per-action fixed-window rate limiter.

import type { ActionRateLimitOptions } from "./server";

interface RateLimitBucket {
	windowStart: number;
	count: number;
}

export interface ActionRateLimiter {
	readonly check: (actionId: string, key: string, options: ActionRateLimitOptions) => boolean;
}

function bucketId(actionId: string, key: string): string {
	return `${actionId}::${key}`;
}

export function createActionRateLimiter(): ActionRateLimiter {
	const buckets = new Map<string, RateLimitBucket>();

	return {
		check: (actionId, key, options) => {
			const windowSeconds = options.windowMs / 1000;
			const now = os.clock();
			const windowStart = math.floor(now / windowSeconds) * windowSeconds;
			const id = bucketId(actionId, key);
			const bucket = buckets.get(id);

			if (bucket === undefined || bucket.windowStart !== windowStart) {
				buckets.set(id, { windowStart, count: 1 });
				return true;
			}

			if (bucket.count >= options.max) {
				return false;
			}

			bucket.count += 1;
			return true;
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
