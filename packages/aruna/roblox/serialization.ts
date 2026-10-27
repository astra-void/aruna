// Aruna roblox-ts native runtime — plain-data-v1 serialization boundary.
//
// Action input/output must be wire-safe plain data. Functions, threads, cyclic
// tables, and other userdata are rejected; strings, finite numbers, booleans,
// nil, plain tables, and the Roblox value types that RemoteEvents serialize
// natively (Vector3, Vector2, Color3, CFrame, UDim, UDim2 with finite
// components; DateTime; BrickColor) are allowed. An Instance is allowed only
// where the value's schema declares `schema.instance()`: it is a reference into
// the DataModel, not data, so it must be asked for.

import type { Schema } from "./schema";

const MAX_DEPTH = 32;
// Values a single walk may visit. Depth alone does not bound the work: a flat
// array of a million numbers is one level deep. Mirrors the Node runtime.
export const DEFAULT_MAX_WIRE_NODES = 2048;

interface WalkState {
	readonly seen: Set<object>;
	readonly maxNodes: number;
	nodes: number;
}

// The schemas a value at one position may be checked against: optional and
// default wrappers peeled, and every member of a union. A union is never
// narrowed by validating the value against its members — `validate` walks the
// value's whole subtree outside the node budget, and over again for each nested
// union — so all of them stay candidates, and the validation that runs after
// this walk enforces the exact shape. Mirrors the Node runtime.
function expandCandidates(schemas: ReadonlyArray<Schema>): Array<Schema> {
	const expanded = new Array<Schema>();
	const visited = new Set<Schema>();
	const pending = [...schemas];
	while (pending.size() > 0) {
		const current = pending.pop() as Schema;
		if (visited.has(current)) {
			continue;
		}
		visited.add(current);
		const typeName = current.typeName;
		if (typeName === "optional" || typeName === "default") {
			const inner = current.inner;
			if (inner !== undefined) {
				pending.push(inner);
			}
		} else if (typeName === "union") {
			const members = current.members;
			if (members !== undefined) {
				for (const member of members) {
					pending.push(member);
				}
			}
		} else {
			expanded.push(current);
		}
	}
	return expanded;
}

// The schema for one entry of a table checked against `schema`. Undefined for
// a key the schema does not declare.
function childSchema(schema: Schema, key: unknown): Schema | undefined {
	const typeName = schema.typeName;
	if (typeName === "object") {
		const fields = schema.fields;
		return fields !== undefined && typeIs(key, "string") ? fields[key] : undefined;
	}
	if (typeName === "array" || typeName === "record") {
		return schema.item;
	}
	if (typeName === "tuple") {
		const items = schema.items;
		return items !== undefined && typeIs(key, "number") ? items[key - 1] : undefined;
	}
	return undefined;
}

// The schemas for one entry, from every candidate that declares it. Empty for a
// key none of them declares, which is where an Instance is refused.
function childCandidates(schemas: ReadonlyArray<Schema>, key: unknown): Array<Schema> {
	const children = new Array<Schema>();
	for (const candidate of schemas) {
		const child = childSchema(candidate, key);
		if (child !== undefined) {
			children.push(child);
		}
	}
	return children;
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

function checkWireSafe(
	value: unknown,
	depth: number,
	state: WalkState,
	schemas: ReadonlyArray<Schema>,
): boolean {
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
	if (typeIs(value, "DateTime") || typeIs(value, "BrickColor")) {
		return true;
	}
	if (typeIs(value, "Instance")) {
		for (const candidate of expandCandidates(schemas)) {
			if (candidate.typeName === "instance") {
				return true;
			}
		}
		return false;
	}
	if (!typeIs(value, "table")) {
		// Other userdata, functions, and threads remain forbidden.
		return false;
	}
	const seen = state.seen;
	const tableValue = value as object;
	if (seen.has(tableValue)) {
		return false;
	}
	seen.add(tableValue);
	const tableSchemas = expandCandidates(schemas);

	let safe = true;
	for (const [key, entry] of pairs(value as Record<string, unknown>)) {
		if (!typeIs(key, "string") && !typeIs(key, "number")) {
			safe = false;
			break;
		}
		if (!checkWireSafe(entry, depth + 1, state, childCandidates(tableSchemas, key))) {
			safe = false;
			break;
		}
	}

	seen.delete(tableValue);
	return safe;
}

// `maxNodes` bounds the values visited (default DEFAULT_MAX_WIRE_NODES), so a
// client's input costs at most that much to check. Pass `math.huge` for a
// server-authored value (an action's output, a signal payload). `schema` is the
// value's declared schema, if any: it is what lets an Instance through, and only
// where it says `schema.instance()`.
export function isWireSafe(value: unknown, maxNodes?: number, schema?: Schema): boolean {
	return checkWireSafe(
		value,
		0,
		{
			seen: new Set<object>(),
			maxNodes: maxNodes !== undefined ? maxNodes : DEFAULT_MAX_WIRE_NODES,
			nodes: 0,
		},
		schema !== undefined ? [schema] : [],
	);
}
