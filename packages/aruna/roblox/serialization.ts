// Aruna roblox-ts native runtime — plain-data-v1 serialization boundary.
//
// Action input/output must be wire-safe plain data. Functions, threads, cyclic
// tables, and most userdata (Instance, ...) are rejected; strings, finite
// numbers, booleans, nil, plain tables, and the Roblox value types that
// RemoteEvents serialize natively (Vector3, Vector2, Color3, CFrame, UDim, UDim2,
// with finite components) are allowed.

const MAX_DEPTH = 32;
// Values a single walk may visit. Depth alone does not bound the work: a flat
// array of a million numbers is one level deep. Mirrors the Node runtime.
export const DEFAULT_MAX_WIRE_NODES = 2048;

interface WalkState {
	readonly seen: Set<object>;
	readonly maxNodes: number;
	nodes: number;
}

// NaN, math.huge and -math.huge are numbers to `typeIs`, and they pass any
// comparison guard the wrong way: `amount > balance` is false for NaN, so a
// NaN slips past it and poisons whatever it is added to. They never cross the
// action boundary, matching the Node runtime's Number.isFinite.
export function isFiniteNumber(value: number): boolean {
	return value === value && value !== math.huge && value !== -math.huge;
}

// True when every numeric component of a Roblox value type is finite. The
// engine happily builds Vector3.new(0/0, 0, 0), and a client can send one.
// Other values (including non-Roblox ones) are left to the caller's type check.
export function hasFiniteComponents(value: unknown): boolean {
	if (typeIs(value, "Vector3")) {
		return isFiniteNumber(value.X) && isFiniteNumber(value.Y) && isFiniteNumber(value.Z);
	}
	if (typeIs(value, "Vector2")) {
		return isFiniteNumber(value.X) && isFiniteNumber(value.Y);
	}
	if (typeIs(value, "Color3")) {
		return isFiniteNumber(value.R) && isFiniteNumber(value.G) && isFiniteNumber(value.B);
	}
	if (typeIs(value, "CFrame")) {
		const [x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22] = value.GetComponents();
		return (
			isFiniteNumber(x) &&
			isFiniteNumber(y) &&
			isFiniteNumber(z) &&
			isFiniteNumber(r00) &&
			isFiniteNumber(r01) &&
			isFiniteNumber(r02) &&
			isFiniteNumber(r10) &&
			isFiniteNumber(r11) &&
			isFiniteNumber(r12) &&
			isFiniteNumber(r20) &&
			isFiniteNumber(r21) &&
			isFiniteNumber(r22)
		);
	}
	if (typeIs(value, "UDim")) {
		return isFiniteNumber(value.Scale) && isFiniteNumber(value.Offset);
	}
	if (typeIs(value, "UDim2")) {
		return (
			isFiniteNumber(value.X.Scale) &&
			isFiniteNumber(value.X.Offset) &&
			isFiniteNumber(value.Y.Scale) &&
			isFiniteNumber(value.Y.Offset)
		);
	}
	return true;
}

function checkWireSafe(value: unknown, depth: number, state: WalkState): boolean {
	if (depth > MAX_DEPTH) {
		return false;
	}
	state.nodes += 1;
	if (state.nodes > state.maxNodes) {
		return false;
	}
	if (value === undefined) {
		return true;
	}
	if (typeIs(value, "number")) {
		return isFiniteNumber(value);
	}
	if (typeIs(value, "string") || typeIs(value, "boolean")) {
		return true;
	}
	// Roblox value types carried natively by RemoteEvents. These back the
	// schema.vector3()/vector2()/color3()/cframe()/udim()/udim2() kinds, which the
	// wire codec rejected before they were first-class schema types. Their
	// numeric components must be finite, like any other number.
	if (
		typeIs(value, "Vector3") ||
		typeIs(value, "Vector2") ||
		typeIs(value, "Color3") ||
		typeIs(value, "CFrame") ||
		typeIs(value, "UDim") ||
		typeIs(value, "UDim2")
	) {
		return hasFiniteComponents(value);
	}
	if (
		typeIs(value, "DateTime") ||
		typeIs(value, "BrickColor") ||
		typeIs(value, "Instance")
	) {
		return true;
	}
	if (!typeIs(value, "table")) {
		// Other userdata (Instance, function, thread, ...) remain forbidden.
		return false;
	}

	const seen = state.seen;
	const tableValue = value as object;
	if (seen.has(tableValue)) {
		return false;
	}
	seen.add(tableValue);

	let safe = true;
	for (const [key, entry] of pairs(value as Record<string, unknown>)) {
		if (!typeIs(key, "string") && !typeIs(key, "number")) {
			safe = false;
			break;
		}
		if (!checkWireSafe(entry, depth + 1, state)) {
			safe = false;
			break;
		}
	}

	seen.delete(tableValue);
	return safe;
}

// `maxNodes` bounds the values visited (default DEFAULT_MAX_WIRE_NODES), so a
// client's input costs at most that much to check. Pass `math.huge` for a
// server-authored value (an action's output, a signal payload).
export function isWireSafe(value: unknown, maxNodes?: number): boolean {
	return checkWireSafe(value, 0, {
		seen: new Set<object>(),
		maxNodes: maxNodes !== undefined ? maxNodes : DEFAULT_MAX_WIRE_NODES,
		nodes: 0,
	});
}
