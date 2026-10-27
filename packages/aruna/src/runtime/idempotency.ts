// Server-side de-duplication of retried action calls.
//
// A client that retries a call (see `withRetry`) sends the same idempotency key
// with every attempt. The server remembers, per player, what a key's dispatch
// settled to: a duplicate that arrives while the first is still running attaches
// to it, and one that arrives later gets the settled result. Either way the
// action runs once. Mirrors the native runtime's roblox/idempotency.ts.

// The longest key the server accepts. Anything else (wrong type, too long) is
// ignored and the call is dispatched without de-duplication.
export const IDEMPOTENCY_KEY_MAX_LENGTH = 64;
// How long a settled result is kept: twice the client's default request timeout
// (10s), which covers a timed-out attempt plus the retry that follows it.
export const IDEMPOTENCY_TTL_MS = 2 * 10_000;
// Settled and in-flight keys kept per player; the oldest is evicted first.
export const IDEMPOTENCY_MAX_ENTRIES_PER_PLAYER = 64;

export function isIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= IDEMPOTENCY_KEY_MAX_LENGTH
  );
}

type Entry<TResult> = {
  readonly promise: Promise<TResult>;
  settledAtMs?: number;
};

type PlayerEntries<TResult> = {
  readonly entries: Map<string, Entry<TResult>>;
  // Insertion order, for evicting the oldest key. Kept apart from the Map so
  // the native runtime, whose tables have no iteration order, does the same.
  readonly order: string[];
};

export type IdempotencyCache<TPlayer, TResult> = {
  // Runs `dispatch` once per (player, actionId, key). `dispatch` sets
  // `progress.ran` when the action reached its handler: a call refused before
  // that (rate limited, invalid input, unknown action) is not remembered, since
  // the action did not run and a later attempt must be allowed to.
  readonly run: (
    player: TPlayer,
    actionId: string,
    key: string,
    dispatch: (progress: { ran: boolean }) => Promise<TResult>,
  ) => Promise<TResult>;
  // Drops everything remembered for a player. Called on leave.
  readonly forget: (player: TPlayer) => void;
  readonly clear: () => void;
};

export function createIdempotencyCache<TPlayer, TResult>(options?: {
  readonly nowMs?: () => number;
}): IdempotencyCache<TPlayer, TResult> {
  const nowMs = options?.nowMs ?? Date.now;
  const players = new Map<TPlayer, PlayerEntries<TResult>>();

  const remove = (state: PlayerEntries<TResult>, slot: string): void => {
    state.entries.delete(slot);
    const at = state.order.indexOf(slot);
    if (at !== -1) {
      state.order.splice(at, 1);
    }
  };

  return {
    run(player, actionId, key, dispatch) {
      // Scoped by action: a key reused for a different action is a different call.
      const slot = `${actionId}\n${key}`;
      let state = players.get(player);
      if (state !== undefined) {
        const existing = state.entries.get(slot);
        if (existing !== undefined) {
          if (
            existing.settledAtMs === undefined ||
            nowMs() - existing.settledAtMs <= IDEMPOTENCY_TTL_MS
          ) {
            return existing.promise;
          }
          remove(state, slot);
        }
      } else {
        state = { entries: new Map(), order: [] };
        players.set(player, state);
      }

      while (state.order.length >= IDEMPOTENCY_MAX_ENTRIES_PER_PLAYER) {
        const oldest = state.order[0];
        if (oldest === undefined) {
          break;
        }
        remove(state, oldest);
      }

      const progress = { ran: false };
      const promise = dispatch(progress);
      const entry: Entry<TResult> = { promise };
      state.entries.set(slot, entry);
      state.order.push(slot);

      const settle = (): void => {
        const current = players.get(player);
        if (current === undefined || current.entries.get(slot) !== entry) {
          return;
        }
        if (progress.ran) {
          entry.settledAtMs = nowMs();
        } else {
          remove(current, slot);
        }
      };
      promise.then(settle, settle);
      return promise;
    },
    forget(player) {
      players.delete(player);
    },
    clear() {
      players.clear();
    },
  };
}
