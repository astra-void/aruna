// Aruna roblox-ts native runtime — plain-data-v1 serialization boundary.
//
// Action input/output must be wire-safe plain data. Functions, threads, cyclic
// tables, and most userdata (Instance, ...) are rejected; strings, finite
// numbers, booleans, nil, plain tables, and the Roblox value types that
// RemoteEvents serialize natively (Vector3, Vector2, Color3, CFrame, UDim, UDim2,
// with finite components) are allowed.

const MAX_DEPTH = 32;

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

function checkWireSafe(value: unknown, depth: number, seen: Set<object>): boolean {
	if (depth > MAX_DEPTH) {
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
		if (!checkWireSafe(entry, depth + 1, seen)) {
			safe = false;
			break;
		}
	}

	seen.delete(tableValue);
	return safe;
}

export function isWireSafe(value: unknown): boolean {
	return checkWireSafe(value, 0, new Set<object>());
}
