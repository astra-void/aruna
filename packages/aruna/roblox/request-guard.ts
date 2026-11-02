// Aruna roblox-ts native runtime — per-player request limits in front of dispatch.
//
// A per-action `rateLimit` only counts calls that passed validation, which is
// right for it ("invalid input does not consume quota") but leaves the parsing
// itself unpriced: an exploiter could fire malformed payloads for free, each one
// costing a wire-safety walk, defaults, and a schema validation. The guard
// charges every envelope against a token bucket before any of that runs, and
// caps how many of a player's dispatches can be running at once.
//
// A call its action's own rate limit admits gets its token back: that limit
// already prices it, and charging it twice would let the budget throttle an
// action below the rate it declares (a fire-and-forget input at 60 a second).
// What the budget is left pricing is the work that leads nowhere — malformed
// envelopes, unknown actions, invalid input, refused calls — and calls to an
// action with no rate limit at all.

import { refilledTokens } from "./rate-limit";

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

// How long a player who left is remembered as gone. Long enough to cover an
// envelope Roblox delivered after PlayerRemoving (a few frames, in practice),
// short enough that the entry — which holds the Player — does not pin it.
export const DEPARTED_PLAYER_TTL_MS = 30_000;

// Players who left recently. An envelope that arrives after PlayerRemoving
// would otherwise recreate the per-player state leave just dropped, and nothing
// would ever drop it again: it would hold the Player forever. The guard and the
// idempotency cache consult this before creating state, and the transport
// drops such an envelope. An entry is cleared when the player joins again, or
// once it is older than DEPARTED_PLAYER_TTL_MS.
export interface DepartedPlayers<TPlayer = unknown> {
	// Marks a player as gone. Called on leave.
	readonly add: (player: TPlayer) => void;
	readonly has: (player: TPlayer) => boolean;
	// Unmarks a player who joined again.
	readonly remove: (player: TPlayer) => void;
	readonly clear: () => void;
}

export function createDepartedPlayers<TPlayer>(nowMs?: () => number): DepartedPlayers<TPlayer> {
	const readNow = nowMs !== undefined ? nowMs : () => os.clock() * 1000;
	const departedAt = new Map<TPlayer, number>();
	// Expired entries are swept whenever the set changes, so none outlives the
	// next join or leave by much.
	const sweep = (): void => {
		const at = readNow();
		for (const [player, leftAt] of departedAt) {
			if (at - leftAt > DEPARTED_PLAYER_TTL_MS) {
				departedAt.delete(player);
			}
		}
	};
	return {
		add: (player) => {
			sweep();
			departedAt.set(player, readNow());
		},
		has: (player) => {
			const leftAt = departedAt.get(player);
			if (leftAt === undefined) {
				return false;
			}
			if (readNow() - leftAt > DEPARTED_PLAYER_TTL_MS) {
				departedAt.delete(player);
				return false;
			}
			return true;
		},
		remove: (player) => {
			departedAt.delete(player);
			sweep();
		},
		clear: () => {
			departedAt.clear();
		},
	};
}

export type RequestAbuseReason =
	| "budget-exhausted"
	| "malformed-envelope"
	| "too-many-in-flight"
	// A frame whose protocol version this server does not speak
	// (docs/wire-protocol.md). Dropped whole.
	| "unknown-protocol-version"
	// A frame with more than WIRE_MAX_FRAME_ITEMS calls. Dropped whole, before
	// any call in it is read.
	| "oversize-batch"
	// A call to an action this server does not define. Dropped with no
	// response: a client always runs its server's build, so only a forged id
	// gets here, and a response would tell it which ids exist.
	| "unknown-action"
	// A call whose input failed wire safety or its schema. Answered as usual
	// (ActionSerializationError / ActionValidationError).
	| "invalid-input"
	// A call its action's rate limit refused. Answered as usual
	// (ActionRateLimitError). A well-behaved client can get here too, by
	// calling faster than the limit; whether that is abuse is the game's call.
	| "rate-limited"
	// A call its action's `authorize` refused. Answered as usual
	// (ActionForbiddenError).
	| "forbidden"
	// A resource subscription naming a resource this server does not define.
	// Dropped with no answer, like an unknown action.
	| "unknown-resource";

export interface RequestAbuseInfo {
	readonly reason: RequestAbuseReason;
	readonly actionId?: string;
	// How many times this player has been reported for this reason since they
	// joined, this report included: what a game decides a kick on.
	readonly count: number;
}

export type RequestAbuseHandler<TPlayer = unknown> = (player: TPlayer, info: RequestAbuseInfo) => void;

export interface RequestGuard<TPlayer = unknown> {
	// Charges one envelope. False when the player's budget is empty: drop it.
	readonly admit: (player: TPlayer) => boolean;
	// Gives back the token of a call its action's own rate limit admitted.
	readonly refund: (player: TPlayer) => void;
	// Claims an in-flight slot. False when the player is at the cap.
	readonly begin: (player: TPlayer) => boolean;
	readonly finish: (player: TPlayer) => void;
	readonly maxInFlight: number;
	// Counts the report for the player and passes it to `onAbuse`.
	readonly report: (
		player: TPlayer,
		info: { readonly reason: RequestAbuseReason; readonly actionId?: string },
	) => void;
	// Drops a player's budget, in-flight count, and report counts. Called on
	// leave.
	readonly forget: (player: TPlayer) => void;
	// True for a player who left (see DepartedPlayers): their envelopes are
	// dropped, and no state is created for them.
	readonly hasDeparted: (player: TPlayer) => boolean;
}

interface PlayerBudget {
	tokens: number;
	refilledAtMs: number;
	inFlight: number;
	reports: Map<RequestAbuseReason, number>;
}

function positiveOr(value: number | undefined, fallback: number): number {
	return value !== undefined && value > 0 && value < math.huge ? value : fallback;
}

export function createRequestGuard<TPlayer>(options?: {
	readonly budget?: RequestBudgetOptions;
	readonly onAbuse?: RequestAbuseHandler<TPlayer>;
	readonly nowMs?: () => number;
	readonly departed?: DepartedPlayers<TPlayer>;
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
	const departed = options !== undefined ? options.departed : undefined;
	const players = new Map<TPlayer, PlayerBudget>();
	const hasDeparted = (player: TPlayer): boolean => departed !== undefined && departed.has(player);

	const stateFor = (player: TPlayer): PlayerBudget => {
		let state = players.get(player);
		if (state === undefined) {
			state = { tokens: burst, refilledAtMs: readNow(), inFlight: 0, reports: new Map() };
			players.set(player, state);
		}
		return state;
	};

	return {
		admit: (player) => {
			if (hasDeparted(player)) {
				return false;
			}
			const state = stateFor(player);
			const at = readNow();
			state.tokens = refilledTokens(state.tokens, (at - state.refilledAtMs) / 1000, perSecond, burst);
			state.refilledAtMs = at;
			if (state.tokens < 1) {
				return false;
			}
			state.tokens -= 1;
			return true;
		},
		refund: (player) => {
			const state = players.get(player);
			if (state !== undefined) {
				state.tokens = math.min(burst, state.tokens + 1);
			}
		},
		begin: (player) => {
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
		finish: (player) => {
			// A player who left mid-dispatch has no state any more; nothing to undo.
			const state = players.get(player);
			if (state !== undefined && state.inFlight > 0) {
				state.inFlight -= 1;
			}
		},
		maxInFlight,
		report: (player, info) => {
			// A player who left gets no state back for a late report.
			if (hasDeparted(player)) {
				return;
			}
			const reports = stateFor(player).reports;
			const count = (reports.get(info.reason) ?? 0) + 1;
			reports.set(info.reason, count);
			if (onAbuse !== undefined) {
				onAbuse(player, {
					reason: info.reason,
					...(info.actionId !== undefined ? { actionId: info.actionId } : {}),
					count,
				});
			}
		},
		forget: (player) => {
			players.delete(player);
		},
		hasDeparted,
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

// The transport's gate for a frame it drops whole (not a frame, an unknown
// protocol version, too many calls): charged one request, like a malformed
// envelope, and reported. A frame from a player who already left is dropped
// without a report.
export function refuseFrame<TPlayer>(
	guard: RequestGuard<TPlayer>,
	player: TPlayer,
	reason: "malformed-frame" | "unknown-protocol-version" | "oversize-batch",
): void {
	if (guard.hasDeparted(player)) {
		return;
	}
	guard.admit(player);
	guard.report(player, { reason: reason === "malformed-frame" ? "malformed-envelope" : reason });
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
