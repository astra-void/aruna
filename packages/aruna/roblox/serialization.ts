// Aruna roblox-ts native runtime — plain-data-v1 serialization boundary.
//
// Action input/output must be wire-safe plain data. Roblox userdata (Instance,
// Vector3, CFrame, ...), functions, threads, and cyclic tables are rejected by
// default; only strings, numbers, booleans, nil, and plain tables are allowed.

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
	if (!typeIs(value, "table")) {
		// Instance, function, thread, Vector3, and other userdata are forbidden.
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
