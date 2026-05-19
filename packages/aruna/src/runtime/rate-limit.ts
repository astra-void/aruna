import type { ActionRunContext } from "./server.js";

export type ActionRateLimitConfig = {
  readonly limit: number;
  readonly windowMs: number;
};

export type ActionRateLimitOptions = ActionRateLimitConfig;

export type ActionRateLimitResult =
  | {
      readonly ok: true;
      readonly remaining: number;
      readonly resetAtMs: number;
    }
  | {
      readonly ok: false;
      readonly retryAfterMs: number;
      readonly resetAtMs: number;
    };

export type ActionRateLimitKeyResolver<TPlayer = unknown> = (
  actionId: string,
  ctx: ActionRunContext<TPlayer>,
) => string;

export type ActionRateLimitState = {
  readonly windowStartMs: number;
  readonly limit: number;
  readonly windowMs: number;
  count: number;
};

export type ActionRateLimitStore = Record<string, ActionRateLimitState | undefined>;

export type ActionRateLimiter = {
  readonly check: (
    actionId: string,
    key: string,
    config: ActionRateLimitConfig,
    nowMs?: number,
  ) => ActionRateLimitResult;
  readonly reset: () => void;
};

function isRobloxPlayerLike(value: unknown): value is { readonly UserId: number } {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { readonly UserId?: unknown };
  return typeof candidate.UserId === "number" && Number.isFinite(candidate.UserId);
}

export function defaultActionRateLimitKeyResolver<TPlayer = unknown>(
  _actionId: string,
  ctx: ActionRunContext<TPlayer>,
): string {
  const player = ctx.player;

  if (player === undefined) {
    return "anonymous";
  }

  if (typeof player === "string" || typeof player === "number") {
    return `value:${String(player)}`;
  }

  if (isRobloxPlayerLike(player)) {
    return `user:${player.UserId}`;
  }

  return "object";
}

function toBucketStart(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

function createBucketKey(actionId: string, key: string): string {
  return `${actionId}::${key}`;
}

export class ActionRateLimitError extends Error {
  override readonly name = "ActionRateLimitError";
  readonly actionId: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly retryAfterMs: number;
  readonly resetAtMs: number;

  constructor(
    message: string,
    options: {
      readonly actionId: string;
      readonly limit: number;
      readonly windowMs: number;
      readonly retryAfterMs: number;
      readonly resetAtMs: number;
    },
  ) {
    super(message);
    this.actionId = options.actionId;
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.retryAfterMs = options.retryAfterMs;
    this.resetAtMs = options.resetAtMs;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function createActionRateLimiter(): ActionRateLimiter {
  let buckets: ActionRateLimitStore = Object.create(null) as ActionRateLimitStore;

  return {
    check(actionId, key, config, nowMs = Date.now()) {
      const currentNow = Math.floor(nowMs);
      const windowStartMs = toBucketStart(currentNow, config.windowMs);
      const bucketKey = createBucketKey(actionId, key);
      const bucket = buckets[bucketKey];

      if (
        bucket === undefined ||
        bucket.windowStartMs !== windowStartMs ||
        bucket.limit !== config.limit ||
        bucket.windowMs !== config.windowMs
      ) {
        buckets[bucketKey] = {
          windowStartMs,
          limit: config.limit,
          windowMs: config.windowMs,
          count: 0,
        };
      }

      const currentBucket = buckets[bucketKey];
      if (currentBucket === undefined) {
        return {
          ok: true,
          remaining: config.limit - 1,
          resetAtMs: windowStartMs + config.windowMs,
        };
      }

      if (currentBucket.count >= config.limit) {
        const resetAtMs = currentBucket.windowStartMs + currentBucket.windowMs;
        return {
          ok: false,
          retryAfterMs: Math.max(0, resetAtMs - currentNow),
          resetAtMs,
        };
      }

      currentBucket.count += 1;
      return {
        ok: true,
        remaining: config.limit - currentBucket.count,
        resetAtMs: currentBucket.windowStartMs + currentBucket.windowMs,
      };
    },
    reset() {
      buckets = Object.create(null) as ActionRateLimitStore;
    },
  };
}
