// Aruna roblox-ts native runtime — schema checking the runtime does on its own:
// filling `.default(...)` values in, and naming the first path a value fails.
//
// Kept out of `schema.ts` because that module is the `aruna/schema` entry point:
// what it exports is public API, and these are the runtime's internals
// (dispatch, stores, resources and signals call them).

import { hasFiniteComponents, isFiniteNumber } from "./serialization";
import type { NumberFormat, Refinement, Schema } from "./schema";

// The integer number formats and the range each one admits. `schema.ts` reads it
// to validate, and `firstSchemaIssue` to explain a failure.
interface NumberFormatRange {
	readonly min: number;
	readonly max: number;
}

export const NUMBER_FORMAT_RANGES = new Map<NumberFormat, NumberFormatRange>([
	["u8", { min: 0, max: 255 }],
	["u16", { min: 0, max: 65535 }],
	["u32", { min: 0, max: 4294967295 }],
	["i8", { min: -128, max: 127 }],
	["i16", { min: -32768, max: 32767 }],
	["i32", { min: -2147483648, max: 2147483647 }],
]);

function joinPath(path: string, segment: string): string {
	return path === "" ? segment : `${path}.${segment}`;
}

function indexPath(path: string, index: number): string {
	return `${path === "" ? "" : path}[${index}]`;
}

function withPath(path: string, message: string): string {
	return path === "" ? message : `${path}: ${message}`;
}

// Fills `.default(...)` values into a value tree, returning a value where every
// absent defaulted field is populated. Returns the input unchanged when nothing
// is filled. Recurses through default/optional/object/array; other containers
// pass through.
export function applyDefaults(schema: Schema, value: unknown): unknown {
	const typeName = schema.typeName;
	if (typeName === "default") {
		if (value === undefined) {
			return schema.defaultValue;
		}
		const inner = schema.inner;
		return inner !== undefined ? applyDefaults(inner, value) : value;
	} else if (typeName === "optional") {
		if (value === undefined) {
			return undefined;
		}
		const inner = schema.inner;
		return inner !== undefined ? applyDefaults(inner, value) : value;
	} else if (typeName === "object") {
		if (!typeIs(value, "table")) {
			return value;
		}
		const fields = schema.fields;
		if (fields === undefined) {
			return value;
		}
		const record = value as { [key: string]: unknown };
		let result: { [key: string]: unknown } | undefined;
		for (const [key, fieldSchema] of pairs(fields as { [key: string]: Schema })) {
			const original = record[key as string];
			const filled = applyDefaults(fieldSchema, original);
			if (filled !== original) {
				if (result === undefined) {
					result = {};
					for (const [existingKey, existingValue] of pairs(record)) {
						result[existingKey as string] = existingValue;
					}
				}
				result[key as string] = filled;
			}
		}
		return result !== undefined ? result : value;
	} else if (typeName === "array") {
		if (!typeIs(value, "table")) {
			return value;
		}
		const item = schema.item;
		if (item === undefined) {
			return value;
		}
		const list = value as Array<unknown>;
		let result: Array<unknown> | undefined;
		for (let index = 0; index < list.size(); index += 1) {
			const filled = applyDefaults(item, list[index]);
			if (filled !== list[index]) {
				if (result === undefined) {
					result = [];
					for (let copyIndex = 0; copyIndex < list.size(); copyIndex += 1) {
						result[copyIndex] = list[copyIndex];
					}
				}
				result[index] = filled;
			}
		}
		return result !== undefined ? result : value;
	}
	return value;
}

// Returns the first refinement whose check fails as a path-qualified message.
function firstRefinementIssue(
	refinements: readonly Refinement[] | undefined,
	value: unknown,
	path: string,
): string | undefined {
	if (refinements === undefined) {
		return undefined;
	}
	for (const refinement of refinements) {
		if (!refinement.check(value)) {
			return withPath(path, refinement.message);
		}
	}
	return undefined;
}

// Walks the schema metadata and returns the first failing path + reason, or
// undefined when the value conforms. This is the production error-detail
// counterpart of `validate` (which stays a cheap boolean): dispatch calls it
// only after `validate` already failed, so the happy path pays nothing.
export function firstSchemaIssue(schema: Schema, value: unknown, path?: string): string | undefined {
	const at = path ?? "";
	const typeName = schema.typeName;

	if (typeName === "string") {
		if (!typeIs(value, "string")) {
			return withPath(at, "expected string");
		}
		return firstRefinementIssue(schema.refinements, value, at);
	} else if (typeName === "number") {
		if (!typeIs(value, "number") || !isFiniteNumber(value)) {
			return withPath(at, "expected finite number");
		}
		const format = schema.format;
		const range = format !== undefined ? NUMBER_FORMAT_RANGES.get(format) : undefined;
		if (range !== undefined) {
			if (value !== math.floor(value)) {
				return withPath(at, `expected a whole number (${format})`);
			}
			if (value < range.min || value > range.max) {
				return withPath(at, `expected ${format} in [${range.min}, ${range.max}]`);
			}
		}
		return firstRefinementIssue(schema.refinements, value, at);
	} else if (typeName === "boolean") {
		return typeIs(value, "boolean") ? undefined : withPath(at, "expected boolean");
	} else if (typeName === "literal") {
		return value === schema.value
			? undefined
			: withPath(at, `expected literal ${tostring(schema.value)}`);
	} else if (typeName === "optional" || typeName === "default") {
		if (value === undefined) {
			return undefined;
		}
		const inner = schema.inner;
		return inner !== undefined ? firstSchemaIssue(inner, value, at) : undefined;
	} else if (typeName === "object") {
		if (!typeIs(value, "table")) {
			return withPath(at, "expected object");
		}
		const fields = schema.fields;
		if (fields === undefined) {
			return undefined;
		}
		const record = value as { [key: string]: unknown };
		for (const [key, fieldSchema] of pairs(fields as { [key: string]: Schema })) {
			const issue = firstSchemaIssue(fieldSchema, record[key as string], joinPath(at, key as string));
			if (issue !== undefined) {
				return issue;
			}
		}
		return undefined;
	} else if (typeName === "array") {
		if (!typeIs(value, "table")) {
			return withPath(at, "expected array");
		}
		const item = schema.item;
		if (item === undefined) {
			return undefined;
		}
		const list = value as Array<unknown>;
		for (let index = 0; index < list.size(); index += 1) {
			const issue = firstSchemaIssue(item, list[index], indexPath(at, index));
			if (issue !== undefined) {
				return issue;
			}
		}
		return firstRefinementIssue(schema.refinements, value, at);
	} else if (typeName === "record") {
		if (!typeIs(value, "table")) {
			return withPath(at, "expected record");
		}
		const item = schema.item;
		for (const [key, entry] of pairs(value as { [key: string]: unknown })) {
			if (!typeIs(key, "string")) {
				return withPath(at, "record keys must be strings");
			}
			if (item !== undefined) {
				const issue = firstSchemaIssue(item, entry, joinPath(at, key));
				if (issue !== undefined) {
					return issue;
				}
			}
		}
		return firstRefinementIssue(schema.refinements, value, at);
	} else if (typeName === "tuple") {
		if (!typeIs(value, "table")) {
			return withPath(at, "expected tuple");
		}
		const items = schema.items;
		if (items === undefined) {
			return undefined;
		}
		const list = value as Array<unknown>;
		if (list.size() !== items.size()) {
			return withPath(at, `expected a tuple of length ${items.size()}`);
		}
		for (let index = 0; index < items.size(); index += 1) {
			const itemSchema = items[index];
			if (itemSchema !== undefined) {
				const issue = firstSchemaIssue(itemSchema, list[index], indexPath(at, index));
				if (issue !== undefined) {
					return issue;
				}
			}
		}
		return undefined;
	} else if (typeName === "enum") {
		const values = schema.values;
		if (values !== undefined) {
			for (const candidate of values) {
				if (candidate === value) {
					return undefined;
				}
			}
			const parts: Array<string> = [];
			for (const candidate of values) {
				parts.push(tostring(candidate));
			}
			return withPath(at, `expected one of ${parts.join(" | ")}`);
		}
		return undefined;
	} else if (typeName === "union") {
		const members = schema.members;
		if (members !== undefined) {
			const discriminant = schema.discriminant;
			if (discriminant !== undefined && typeIs(value, "table")) {
				const tag = (value as { [key: string]: unknown })[discriminant];
				for (const member of members) {
					const fields = member.fields;
					if (fields !== undefined) {
						const tagSchema = fields[discriminant];
						if (
							tagSchema !== undefined &&
							tagSchema.typeName === "literal" &&
							tagSchema.value === tag
						) {
							return firstSchemaIssue(member, value, at);
						}
					}
				}
				return withPath(at, `expected ${discriminant} to match a known variant`);
			}
			for (const member of members) {
				if (member.validate(value)) {
					return undefined;
				}
			}
			return withPath(at, "expected a value matching one of the union members");
		}
		return undefined;
	} else if (typeName === "vector3") {
		return typeIs(value, "Vector3") && hasFiniteComponents(value)
			? undefined
			: withPath(at, "expected Vector3 { x, y, z }");
	} else if (typeName === "vector2") {
		return typeIs(value, "Vector2") && hasFiniteComponents(value)
			? undefined
			: withPath(at, "expected Vector2 { x, y }");
	} else if (typeName === "color3") {
		return typeIs(value, "Color3") && hasFiniteComponents(value)
			? undefined
			: withPath(at, "expected Color3 { r, g, b }");
	} else if (typeName === "cframe") {
		return typeIs(value, "CFrame") && hasFiniteComponents(value)
			? undefined
			: withPath(at, "expected CFrame { components: number[12] }");
	} else if (typeName === "udim") {
		return typeIs(value, "UDim") && hasFiniteComponents(value)
			? undefined
			: withPath(at, "expected UDim { scale, offset }");
	} else if (typeName === "udim2") {
		return typeIs(value, "UDim2") && hasFiniteComponents(value)
			? undefined
			: withPath(at, "expected UDim2 { x: UDim, y: UDim }");
	} else if (typeName === "dateTime") {
		return typeIs(value, "DateTime") ? undefined : withPath(at, "expected DateTime");
	} else if (typeName === "brickColor") {
		return typeIs(value, "BrickColor") ? undefined : withPath(at, "expected BrickColor");
	} else if (typeName === "instance") {
		return typeIs(value, "Instance") ? undefined : withPath(at, "expected a Roblox Instance");
	}
	return undefined;
}
