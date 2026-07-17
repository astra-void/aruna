// Aruna roblox-ts native runtime — plain-data-v1 serialization boundary.
//
// Action input/output must be wire-safe plain data. Functions, threads, cyclic
// tables, and most userdata (Instance, ...) are rejected; strings, numbers,
// booleans, nil, plain tables, and the Roblox value types that RemoteEvents
// serialize natively (Vector3, Vector2, Color3, CFrame, UDim, UDim2) are allowed.

const MAX_DEPTH = 32;

function checkWireSafe(value: unknown, depth: number, seen: Set<object>): boolean {
	if (depth > MAX_DEPTH) {
		return false;
	}
	if (value === undefined) {
		return true;
	}
	if (typeIs(value, "string") || typeIs(value, "number") || typeIs(value, "boolean")) {
		return true;
	}
	// Roblox value types carried natively by RemoteEvents. These back the
	// schema.vector3()/vector2()/color3()/cframe()/udim()/udim2() kinds, which the
	// wire codec rejected before they were first-class schema types.
	if (
		typeIs(value, "Vector3") ||
		typeIs(value, "Vector2") ||
		typeIs(value, "Color3") ||
		typeIs(value, "CFrame") ||
		typeIs(value, "UDim") ||
		typeIs(value, "UDim2")
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
