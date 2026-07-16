import type { ActionRunContext } from "./server.js";

export type ActionRateLimitConfig = {
  // "player": one bucket per calling player (the default). "global": a single
  // shared bucket for every caller — for actions guarding an expensive shared
  // resource. Matches the native runtime's resolveRateLimitKey.
  readonly key: "player" | "global";
  readonly windowMs: number;
  readonly max: number;
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

export type RateLimitKeyResolver<TPlayer = unknown> = (
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
  // Removes buckets whose window has fully elapsed at nowMs (defaults to
  // Date.now()) and returns how many were removed. Prevents unbounded growth
  // from keys (players/actions) that never call check() again. Optional so
  // custom ActionRateLimiter implementations stay compatible.
  readonly purge?: (nowMs?: number) => number;
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
  readonly max: number;
  readonly windowMs: number;
  readonly retryAfterMs: number;
  readonly resetAtMs: number;

  constructor(
    message: string,
    options: {
      readonly actionId: string;
      readonly max: number;
      readonly windowMs: number;
      readonly retryAfterMs: number;
      readonly resetAtMs: number;
    },
  ) {
    super(message);
    this.actionId = options.actionId;
    this.max = options.max;
    this.windowMs = options.windowMs;
    this.retryAfterMs = options.retryAfterMs;
    this.resetAtMs = options.resetAtMs;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function createActionRateLimiter(): ActionRateLimiter {
  let buckets: ActionRateLimitStore = Object.create(null) as ActionRateLimitStore;
  let lastPurgeMs = Number.NEGATIVE_INFINITY;

  function purgeExpired(nowMs: number): number {
    let removed = 0;

    for (const bucketKey in buckets) {
      const bucket = buckets[bucketKey];

      if (bucket !== undefined && bucket.windowStartMs + bucket.windowMs <= nowMs) {
        delete buckets[bucketKey];
        removed += 1;
      }
    }

    return removed;
  }

  return {
    check(actionId, key, config, nowMs = Date.now()) {
      const currentNow = Math.floor(nowMs);

      // Opportunistic cleanup: sweep fully-elapsed buckets at most once per
      // window so abandoned keys don't accumulate. The active window's bucket
      // is never expired here, so this does not affect the result below.
      if (currentNow - lastPurgeMs >= config.windowMs) {
        purgeExpired(currentNow);
        lastPurgeMs = currentNow;
      }

      const windowStartMs = toBucketStart(currentNow, config.windowMs);
      const bucketKey = createBucketKey(actionId, key);
      const bucket = buckets[bucketKey];

      if (
        bucket === undefined ||
        bucket.windowStartMs !== windowStartMs ||
        bucket.limit !== config.max ||
        bucket.windowMs !== config.windowMs
      ) {
        buckets[bucketKey] = {
          windowStartMs,
          limit: config.max,
          windowMs: config.windowMs,
          count: 0,
        };
      }

      const currentBucket = buckets[bucketKey];
      if (currentBucket === undefined) {
        return {
          ok: true,
          remaining: config.max - 1,
          resetAtMs: windowStartMs + config.windowMs,
        };
      }

      if (currentBucket.count >= config.max) {
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
        remaining: config.max - currentBucket.count,
        resetAtMs: currentBucket.windowStartMs + currentBucket.windowMs,
      };
    },
    reset() {
      buckets = Object.create(null) as ActionRateLimitStore;
      lastPurgeMs = Number.NEGATIVE_INFINITY;
    },
    purge(nowMs = Date.now()) {
      return purgeExpired(Math.floor(nowMs));
    },
  };
}
