// Per-player request limits that sit in front of dispatch.
//
// A per-action `rateLimit` only counts calls that passed validation, which is
// right for it ("invalid input does not consume quota") but leaves the parsing
// itself unpriced: an exploiter could fire malformed payloads for free, each one
// costing a wire-safety walk, defaults, and a schema validation. The guard
// charges every envelope against a token bucket before any of that runs, and
// caps how many of a player's dispatches can be running at once. Mirrors the
// native runtime's roblox/request-guard.ts.

export type RequestBudgetOptions = {
  // Envelopes a player may send in a burst. Default 60.
  readonly burst?: number;
  // Tokens refilled per second. Default 30.
  readonly perSecond?: number;
  // A player's dispatches that may be running at once; the next is refused
  // with ActionRateLimitError. Default 32.
  readonly maxInFlight?: number;
};

export const DEFAULT_REQUEST_BURST = 60;
export const DEFAULT_REQUEST_PER_SECOND = 30;
export const DEFAULT_MAX_IN_FLIGHT = 32;
// How long a client told "too many in flight" is asked to wait.
export const IN_FLIGHT_RETRY_AFTER_MS = 100;

// The longest request id and action id an envelope may carry; anything else is
// dropped before dispatch.
export const MAX_REQUEST_ID_LENGTH = 64;
export const MAX_ACTION_ID_LENGTH = 128;

// How long a player who left is remembered as gone. Long enough to cover an
// envelope Roblox delivered after PlayerRemoving (a few frames, in practice),
// short enough that the entry — which holds the Player — does not pin it.
export const DEPARTED_PLAYER_TTL_MS = 30_000;

// Players who left recently. An envelope that arrives after PlayerRemoving
// would otherwise recreate the per-player state leave just dropped, and nothing
// would ever drop it again: it would hold the Player forever. The guard and the
// idempotency cache consult this before creating state, and the transport
// drops such an envelope. An entry is cleared when the player joins again, or
// once it is older than DEPARTED_PLAYER_TTL_MS. Mirrors the native runtime.
export type DepartedPlayers<TPlayer = unknown> = {
  // Marks a player as gone. Called on leave.
  readonly add: (player: TPlayer) => void;
  readonly has: (player: TPlayer) => boolean;
  // Unmarks a player who joined again.
  readonly remove: (player: TPlayer) => void;
  readonly clear: () => void;
};

export function createDepartedPlayers<TPlayer>(
  nowMs: () => number = Date.now,
): DepartedPlayers<TPlayer> {
  const departedAt = new Map<TPlayer, number>();
  // Expired entries are swept whenever the set changes, so none outlives the
  // next join or leave by much.
  const sweep = (): void => {
    const at = nowMs();
    for (const [player, leftAt] of departedAt) {
      if (at - leftAt > DEPARTED_PLAYER_TTL_MS) {
        departedAt.delete(player);
      }
    }
  };
  return {
    add(player) {
      sweep();
      departedAt.set(player, nowMs());
    },
    has(player) {
      const leftAt = departedAt.get(player);
      if (leftAt === undefined) {
        return false;
      }
      if (nowMs() - leftAt > DEPARTED_PLAYER_TTL_MS) {
        departedAt.delete(player);
        return false;
      }
      return true;
    },
    remove(player) {
      departedAt.delete(player);
      sweep();
    },
    clear() {
      departedAt.clear();
    },
  };
}

export type RequestAbuseReason = "budget-exhausted" | "malformed-envelope" | "too-many-in-flight";

export type RequestAbuseHandler<TPlayer = unknown> = (
  player: TPlayer,
  info: { readonly reason: RequestAbuseReason; readonly actionId?: string },
) => void;

export type RequestGuard<TPlayer = unknown> = {
  // Charges one envelope. False when the player's budget is empty: drop it.
  readonly admit: (player: TPlayer) => boolean;
  // Claims an in-flight slot. False when the player is at the cap.
  readonly begin: (player: TPlayer) => boolean;
  readonly finish: (player: TPlayer) => void;
  readonly maxInFlight: number;
  readonly report: RequestAbuseHandler<TPlayer>;
  // Drops a player's budget and in-flight count. Called on leave.
  readonly forget: (player: TPlayer) => void;
  // True for a player who left (see DepartedPlayers): their envelopes are
  // dropped, and no state is created for them.
  readonly hasDeparted: (player: TPlayer) => boolean;
  readonly clear: () => void;
};

type PlayerBudget = { tokens: number; refilledAtMs: number; inFlight: number };

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function createRequestGuard<TPlayer>(options?: {
  readonly budget?: RequestBudgetOptions;
  readonly onAbuse?: RequestAbuseHandler<TPlayer>;
  readonly nowMs?: () => number;
  readonly departed?: DepartedPlayers<TPlayer>;
}): RequestGuard<TPlayer> {
  const burst = positiveOr(options?.budget?.burst, DEFAULT_REQUEST_BURST);
  const perSecond = positiveOr(options?.budget?.perSecond, DEFAULT_REQUEST_PER_SECOND);
  const maxInFlight = positiveOr(options?.budget?.maxInFlight, DEFAULT_MAX_IN_FLIGHT);
  const nowMs = options?.nowMs ?? Date.now;
  const onAbuse = options?.onAbuse;
  const departed = options?.departed;
  const players = new Map<TPlayer, PlayerBudget>();
  const hasDeparted = (player: TPlayer): boolean => departed?.has(player) === true;

  const stateFor = (player: TPlayer): PlayerBudget => {
    let state = players.get(player);
    if (state === undefined) {
      state = { tokens: burst, refilledAtMs: nowMs(), inFlight: 0 };
      players.set(player, state);
    }
    return state;
  };

  return {
    admit(player) {
      if (hasDeparted(player)) {
        return false;
      }
      const state = stateFor(player);
      const at = nowMs();
      const elapsedMs = Math.max(0, at - state.refilledAtMs);
      state.tokens = Math.min(burst, state.tokens + (elapsedMs / 1000) * perSecond);
      state.refilledAtMs = at;
      if (state.tokens < 1) {
        return false;
      }
      state.tokens -= 1;
      return true;
    },
    begin(player) {
      // Nothing to cap for a player who is gone, and no state to create.
      if (hasDeparted(player)) {
        return true;
      }
      const state = stateFor(player);
      if (state.inFlight >= maxInFlight) {
        return false;
      }
      state.inFlight += 1;
      return true;
    },
    finish(player) {
      // A player who left mid-dispatch has no state any more; nothing to undo.
      const state = players.get(player);
      if (state !== undefined && state.inFlight > 0) {
        state.inFlight -= 1;
      }
    },
    maxInFlight,
    report(player, info) {
      onAbuse?.(player, info);
    },
    forget(player) {
      players.delete(player);
    },
    hasDeparted,
    clear() {
      players.clear();
    },
  };
}

// The envelope fields every transport checks first: ids are bounded strings.
export function isValidEnvelopeIds(requestId: unknown, actionId: unknown): boolean {
  return (
    typeof requestId === "string" &&
    requestId.length <= MAX_REQUEST_ID_LENGTH &&
    typeof actionId === "string" &&
    actionId.length <= MAX_ACTION_ID_LENGTH
  );
}

// The transport's gate, before it reads anything else from an envelope: the
// envelope check, then the budget. A malformed envelope is charged too — the
// budget counts every envelope, valid or not — and both are dropped without a
// response. An envelope from a player who already left is dropped first, and
// not reported: it is late, not abusive. True when the envelope may go on to
// dispatch.
export function admitEnvelope<TPlayer>(
  guard: RequestGuard<TPlayer>,
  player: TPlayer,
  requestId: unknown,
  actionId: unknown,
): boolean {
  if (guard.hasDeparted(player)) {
    return false;
  }
  if (!isValidEnvelopeIds(requestId, actionId)) {
    guard.admit(player);
    guard.report(player, { reason: "malformed-envelope" });
    return false;
  }
  if (!guard.admit(player)) {
    guard.report(player, { reason: "budget-exhausted", actionId: actionId as string });
    return false;
  }
  return true;
}
