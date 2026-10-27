// Aruna roblox-ts native runtime — per-player request limits in front of dispatch.
//
// A per-action `rateLimit` only counts calls that passed validation, which is
// right for it ("invalid input does not consume quota") but leaves the parsing
// itself unpriced: an exploiter could fire malformed payloads for free, each one
// costing a wire-safety walk, defaults, and a schema validation. The guard
// charges every envelope against a token bucket before any of that runs, and
// caps how many of a player's dispatches can be running at once. Mirrors the
// Node reference runtime's src/runtime/request-guard.ts.

export interface RequestBudgetOptions {
	// Envelopes a player may send in a burst. Default 60.
	readonly burst?: number;
	// Tokens refilled per second. Default 30.
	readonly perSecond?: number;
	// A player's dispatches that may be running at once; the next is refused
	// with ActionRateLimitError. Default 32.
	readonly maxInFlight?: number;
}

export const DEFAULT_REQUEST_BURST = 60;
export const DEFAULT_REQUEST_PER_SECOND = 30;
export const DEFAULT_MAX_IN_FLIGHT = 32;
// How long a client told "too many in flight" is asked to wait.
export const IN_FLIGHT_RETRY_AFTER_MS = 100;

// The longest request id and action id an envelope may carry; anything else is
// dropped before dispatch.
export const MAX_REQUEST_ID_LENGTH = 64;
export const MAX_ACTION_ID_LENGTH = 128;

export type RequestAbuseReason = "budget-exhausted" | "malformed-envelope" | "too-many-in-flight";

export type RequestAbuseHandler<TPlayer = unknown> = (
	player: TPlayer,
	info: { readonly reason: RequestAbuseReason; readonly actionId?: string },
) => void;

export interface RequestGuard<TPlayer = unknown> {
	// Charges one envelope. False when the player's budget is empty: drop it.
	readonly admit: (player: TPlayer) => boolean;
	// Claims an in-flight slot. False when the player is at the cap.
	readonly begin: (player: TPlayer) => boolean;
	readonly finish: (player: TPlayer) => void;
	readonly maxInFlight: number;
	readonly report: RequestAbuseHandler<TPlayer>;
	// Drops a player's budget and in-flight count. Called on leave.
	readonly forget: (player: TPlayer) => void;
}

interface PlayerBudget {
	tokens: number;
	refilledAtMs: number;
	inFlight: number;
}

function positiveOr(value: number | undefined, fallback: number): number {
	return value !== undefined && value > 0 && value < math.huge ? value : fallback;
}

export function createRequestGuard<TPlayer>(options?: {
	readonly budget?: RequestBudgetOptions;
	readonly onAbuse?: RequestAbuseHandler<TPlayer>;
	readonly nowMs?: () => number;
}): RequestGuard<TPlayer> {
	const budget = options !== undefined ? options.budget : undefined;
	const burst = positiveOr(budget !== undefined ? budget.burst : undefined, DEFAULT_REQUEST_BURST);
	const perSecond = positiveOr(
		budget !== undefined ? budget.perSecond : undefined,
		DEFAULT_REQUEST_PER_SECOND,
	);
	const maxInFlight = positiveOr(
		budget !== undefined ? budget.maxInFlight : undefined,
		DEFAULT_MAX_IN_FLIGHT,
	);
	const injectedNow = options !== undefined ? options.nowMs : undefined;
	const readNow = injectedNow !== undefined ? injectedNow : () => os.clock() * 1000;
	const onAbuse = options !== undefined ? options.onAbuse : undefined;
	const players = new Map<TPlayer, PlayerBudget>();

	const stateFor = (player: TPlayer): PlayerBudget => {
		let state = players.get(player);
		if (state === undefined) {
			state = { tokens: burst, refilledAtMs: readNow(), inFlight: 0 };
			players.set(player, state);
		}
		return state;
	};

	return {
		admit: (player) => {
			const state = stateFor(player);
			const at = readNow();
			const elapsedMs = math.max(0, at - state.refilledAtMs);
			state.tokens = math.min(burst, state.tokens + (elapsedMs / 1000) * perSecond);
			state.refilledAtMs = at;
			if (state.tokens < 1) {
				return false;
			}
			state.tokens -= 1;
			return true;
		},
		begin: (player) => {
			const state = stateFor(player);
			if (state.inFlight >= maxInFlight) {
				return false;
			}
			state.inFlight += 1;
			return true;
		},
		finish: (player) => {
			// A player who left mid-dispatch has no state any more; nothing to undo.
			const state = players.get(player);
			if (state !== undefined && state.inFlight > 0) {
				state.inFlight -= 1;
			}
		},
		maxInFlight,
		report: (player, info) => {
			if (onAbuse !== undefined) {
				onAbuse(player, info);
			}
		},
		forget: (player) => {
			players.delete(player);
		},
	};
}

// The envelope fields every transport checks first: ids are bounded strings.
export function isValidEnvelopeIds(requestId: unknown, actionId: unknown): boolean {
	return (
		typeIs(requestId, "string") &&
		requestId.size() <= MAX_REQUEST_ID_LENGTH &&
		typeIs(actionId, "string") &&
		actionId.size() <= MAX_ACTION_ID_LENGTH
	);
}

// The transport's gate, before it reads anything else from an envelope: the
// envelope check, then the budget. A malformed envelope is charged too — the
// budget counts every envelope, valid or not — and both are dropped without a
// response. True when the envelope may go on to dispatch.
export function admitEnvelope<TPlayer>(
	guard: RequestGuard<TPlayer>,
	player: TPlayer,
	requestId: unknown,
	actionId: unknown,
): boolean {
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
