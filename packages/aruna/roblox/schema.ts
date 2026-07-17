// Aruna roblox-ts native runtime — schema DSL.
//
// Hand-authored to compile under roblox-ts. This is the Roblox-targeted runtime
// (vendored into a project's src/.aruna/runtime/), distinct from the Node
// reference runtime that vitest validates.
//
// Builder functions are named `*Schema` rather than `string`/`number`/... because
// roblox-ts reserves identifiers that collide with Lua globals (e.g. `string`).
// The public API stays `schema.string()` etc. via the exported `schema` object.

export type SchemaTypeName =
	| "string"
	| "number"
	| "boolean"
	| "object"
	| "array"
	| "optional"
	| "record"
	| "tuple"
	| "literal"
	| "enum"
	| "union"
	| "vector3"
	| "color3"
	| "cframe";

export type SchemaLiteral = string | number | boolean;

// A runtime-only validation refinement: a predicate plus the message reported
// when it fails. Constraints like `.min(0)` / `.maxLength(20)` are built-in
// refinements. They run after the structural check passes and never change the
// wire format or the rendered type, so the compiler ignores them.
export interface Refinement {
	readonly check: (value: unknown) => boolean;
	readonly message: string;
}

// Structural metadata is carried alongside `validate` so schema-driven tools
// (the binary codec, manifest emission) can read the layout without re-deriving
// it. Mirrors the Node reference schema's discriminated shape; fields are
// populated per typeName by the builders below.
export interface Schema<T = unknown> {
	readonly typeName: SchemaTypeName;
	readonly validate: (value: unknown) => boolean;
	readonly _output?: T;
	// Array item schema; also the value schema of a `record` (string-keyed map).
	readonly item?: Schema;
	readonly fields?: { readonly [key: string]: Schema };
	readonly inner?: Schema;
	readonly value?: SchemaLiteral;
	readonly values?: readonly SchemaLiteral[];
	readonly members?: readonly Schema[];
	// Tuple element schemas, in positional order.
	readonly items?: readonly Schema[];
	readonly format?: NumberFormat;
	// Chainable constraint/refine predicates, run after the structural check.
	readonly refinements?: readonly Refinement[];
	// Present on a discriminated union: the shared field whose literal value
	// selects the member. Wire/type-transparent (same as a plain union).
	readonly discriminant?: string;
}

// Numeric width hints, mirroring the Node reference schema. The binary codec
// reads `format` to pick a packed wire encoding; integer formats also constrain
// validation to whole numbers within range.
export type NumberFormat = "f64" | "f32" | "u8" | "u16" | "u32" | "i8" | "i16" | "i32";

interface NumberFormatRange {
	readonly min: number;
	readonly max: number;
}

const NUMBER_FORMAT_RANGES = new Map<NumberFormat, NumberFormatRange>([
	["u8", { min: 0, max: 255 }],
	["u16", { min: 0, max: 65535 }],
	["u32", { min: 0, max: 4294967295 }],
	["i8", { min: -128, max: 127 }],
	["i16", { min: -32768, max: 32767 }],
	["i32", { min: -2147483648, max: 2147483647 }],
]);

export type Infer<S> = S extends Schema<infer T> ? T : never;

type FieldRecord = { readonly [key: string]: Schema };

type Simplify<T> = { [K in keyof T]: T[K] };

// A field whose inferred type admits `undefined` (i.e. `schema.optional(...)`)
// becomes an optional key, matching the Node reference schema's object
// inference — so consumers can omit optional fields (`return { ok }`) instead of
// being forced to write `{ ok, reason: undefined }`.
type InferFields<F extends FieldRecord> = Simplify<
	{ [K in keyof F as undefined extends Infer<F[K]> ? never : K]: Infer<F[K]> } & {
		[K in keyof F as undefined extends Infer<F[K]> ? K : never]?: Infer<F[K]>;
	}
>;

function primitiveSchema<T>(
	typeName: SchemaTypeName,
	luaType: "string" | "number" | "boolean",
): Schema<T> {
	return {
		typeName,
		validate: (value) => typeIs(value, luaType),
	};
}

// Runs each refinement against a value that already passed its structural check.
function refinementsPass(refinements: readonly Refinement[], value: unknown): boolean {
	for (const refinement of refinements) {
		if (!refinement.check(value)) {
			return false;
		}
	}
	return true;
}

// A string schema carrying its accumulated refinements; validate runs them after
// the type check.
function stringSchemaCore(refinements: readonly Refinement[]): Schema<string> {
	return {
		typeName: "string",
		refinements,
		validate: (value) => typeIs(value, "string") && refinementsPass(refinements, value),
	};
}

function numberSchemaWithFormat(
	format: NumberFormat,
	refinements: readonly Refinement[],
): Schema<number> {
	const range = NUMBER_FORMAT_RANGES.get(format);
	return {
		typeName: "number",
		format,
		refinements,
		validate: (value) => {
			if (!typeIs(value, "number")) {
				return false;
			}
			if (range !== undefined) {
				if (value !== math.floor(value)) {
					return false;
				}
				if (value < range.min || value > range.max) {
					return false;
				}
			}
			return refinementsPass(refinements, value);
		},
	};
}

function booleanSchema(): Schema<boolean> {
	return primitiveSchema<boolean>("boolean", "boolean");
}

function arraySchemaCore<S extends Schema>(
	item: S,
	refinements: readonly Refinement[],
): Schema<Array<Infer<S>>> {
	return {
		typeName: "array",
		item,
		refinements,
		validate: (value) => {
			if (!typeIs(value, "table")) {
				return false;
			}
			const list = value as Array<unknown>;
			for (const entry of list) {
				if (!item.validate(entry)) {
					return false;
				}
			}
			return refinementsPass(refinements, value);
		},
	};
}

// Chainable schema variants. Methods are arrow-function fields (not methods) so
// roblox-ts treats them as plain properties. Each returns a fresh schema whose
// validate closure re-runs the full refinement list.
export interface StringSchemaChain extends Schema<string> {
	readonly minLength: (value: number) => StringSchemaChain;
	readonly maxLength: (value: number) => StringSchemaChain;
	readonly length: (value: number) => StringSchemaChain;
	readonly refine: (check: (value: unknown) => boolean, message: string) => StringSchemaChain;
}

export interface NumberSchemaChain extends Schema<number> {
	readonly min: (value: number) => NumberSchemaChain;
	readonly max: (value: number) => NumberSchemaChain;
	readonly int: () => NumberSchemaChain;
	readonly refine: (check: (value: unknown) => boolean, message: string) => NumberSchemaChain;
}

export interface ArraySchemaChain<T = unknown> extends Schema<Array<T>> {
	readonly minItems: (value: number) => ArraySchemaChain<T>;
	readonly maxItems: (value: number) => ArraySchemaChain<T>;
	readonly length: (value: number) => ArraySchemaChain<T>;
	readonly refine: (check: (value: unknown) => boolean, message: string) => ArraySchemaChain<T>;
}

function stringSchemaChain(refinements: readonly Refinement[]): StringSchemaChain {
	const core = stringSchemaCore(refinements);
	return {
		...core,
		minLength: (value) =>
			stringSchemaChain([
				...refinements,
				{
					check: (candidate) => typeIs(candidate, "string") && (candidate as string).size() >= value,
					message: `expected length >= ${value}`,
				},
			]),
		maxLength: (value) =>
			stringSchemaChain([
				...refinements,
				{
					check: (candidate) => typeIs(candidate, "string") && (candidate as string).size() <= value,
					message: `expected length <= ${value}`,
				},
			]),
		length: (value) =>
			stringSchemaChain([
				...refinements,
				{
					check: (candidate) => typeIs(candidate, "string") && (candidate as string).size() === value,
					message: `expected length ${value}`,
				},
			]),
		refine: (check, message) => stringSchemaChain([...refinements, { check, message }]),
	};
}

function numberSchemaChain(
	format: NumberFormat,
	refinements: readonly Refinement[],
): NumberSchemaChain {
	const core = numberSchemaWithFormat(format, refinements);
	return {
		...core,
		min: (value) =>
			numberSchemaChain(format, [
				...refinements,
				{
					check: (candidate) => typeIs(candidate, "number") && (candidate as number) >= value,
					message: `expected a number >= ${value}`,
				},
			]),
		max: (value) =>
			numberSchemaChain(format, [
				...refinements,
				{
					check: (candidate) => typeIs(candidate, "number") && (candidate as number) <= value,
					message: `expected a number <= ${value}`,
				},
			]),
		int: () =>
			numberSchemaChain(format, [
				...refinements,
				{
					check: (candidate) =>
						typeIs(candidate, "number") && (candidate as number) === math.floor(candidate as number),
					message: "expected an integer",
				},
			]),
		refine: (check, message) => numberSchemaChain(format, [...refinements, { check, message }]),
	};
}

function arraySchemaChain<S extends Schema>(
	item: S,
	refinements: readonly Refinement[],
): ArraySchemaChain<Infer<S>> {
	const core = arraySchemaCore(item, refinements);
	return {
		...core,
		minItems: (value) =>
			arraySchemaChain(item, [
				...refinements,
				{
					check: (candidate) =>
						typeIs(candidate, "table") && (candidate as Array<unknown>).size() >= value,
					message: `expected at least ${value} items`,
				},
			]),
		maxItems: (value) =>
			arraySchemaChain(item, [
				...refinements,
				{
					check: (candidate) =>
						typeIs(candidate, "table") && (candidate as Array<unknown>).size() <= value,
					message: `expected at most ${value} items`,
				},
			]),
		length: (value) =>
			arraySchemaChain(item, [
				...refinements,
				{
					check: (candidate) =>
						typeIs(candidate, "table") && (candidate as Array<unknown>).size() === value,
					message: `expected exactly ${value} items`,
				},
			]),
		refine: (check, message) => arraySchemaChain(item, [...refinements, { check, message }]),
	};
}

function optionalSchema<S extends Schema>(inner: S): Schema<Infer<S> | undefined> {
	return {
		typeName: "optional",
		inner,
		validate: (value) => value === undefined || inner.validate(value),
	};
}

function objectSchema<F extends FieldRecord>(fields: F): Schema<InferFields<F>> {
	const entries: Array<[string, Schema]> = [];
	for (const [key, fieldSchema] of pairs(fields as { [key: string]: Schema })) {
		entries.push([key as string, fieldSchema]);
	}
	return {
		typeName: "object",
		fields,
		validate: (value) => {
			if (!typeIs(value, "table")) {
				return false;
			}
			const record = value as { [key: string]: unknown };
			for (const [key, fieldSchema] of entries) {
				if (!fieldSchema.validate(record[key])) {
					return false;
				}
			}
			return true;
		},
	};
}

// A homogeneous string-keyed map (`{ [key: string]: V }`). Keys must be strings
// — a table with a non-string key fails validation, since non-string keys don't
// survive the plain-data boundary. Carried on the shared `item` field.
function recordSchema<S extends Schema>(value: S): Schema<{ [key: string]: Infer<S> }> {
	return {
		typeName: "record",
		item: value,
		validate: (candidate) => {
			if (!typeIs(candidate, "table")) {
				return false;
			}
			for (const [key, entry] of pairs(candidate as { [key: string]: unknown })) {
				if (!typeIs(key, "string")) {
					return false;
				}
				if (!value.validate(entry)) {
					return false;
				}
			}
			return true;
		},
	};
}

type InferTupleItems<TItems extends readonly Schema[]> = {
	-readonly [TIndex in keyof TItems]: Infer<TItems[TIndex]>;
};

// A fixed-length heterogeneous array (`[A, B, ...]`). Length is part of the
// contract: a value with a different length fails validation.
function tupleSchema<const TItems extends readonly Schema[]>(
	items: TItems,
): Schema<InferTupleItems<TItems>> {
	return {
		typeName: "tuple",
		items,
		validate: (candidate) => {
			if (!typeIs(candidate, "table")) {
				return false;
			}
			const list = candidate as Array<unknown>;
			if (list.size() !== items.size()) {
				return false;
			}
			for (let index = 0; index < items.size(); index += 1) {
				const itemSchema = items[index];
				if (itemSchema === undefined || !itemSchema.validate(list[index])) {
					return false;
				}
			}
			return true;
		},
	};
}

function literalSchema<const TValue extends SchemaLiteral>(value: TValue): Schema<TValue> {
	return {
		typeName: "literal",
		value,
		validate: (candidate) => candidate === value,
	};
}

function enumSchema<const TValues extends readonly SchemaLiteral[]>(
	values: TValues,
): Schema<TValues[number]> {
	return {
		typeName: "enum",
		values,
		validate: (candidate) => {
			for (const value of values) {
				if (candidate === value) {
					return true;
				}
			}
			return false;
		},
	};
}

function unionSchema<const TMembers extends readonly Schema[]>(
	members: TMembers,
): Schema<Infer<TMembers[number]>> {
	return {
		typeName: "union",
		members,
		validate: (candidate) => {
			for (const member of members) {
				if (member.validate(candidate)) {
					return true;
				}
			}
			return false;
		},
	};
}

// A tagged union: members share a `discriminant` field carrying a distinct
// literal, so validation dispatches on it (O(1), precise errors) instead of
// trying each member. Same inferred type and wire encoding as `union`.
function discriminatedUnionSchema<const TMembers extends readonly Schema[]>(
	discriminant: string,
	members: TMembers,
): Schema<Infer<TMembers[number]>> {
	return {
		typeName: "union",
		members,
		discriminant,
		validate: (candidate) => {
			if (!typeIs(candidate, "table")) {
				return false;
			}
			const tag = (candidate as { [key: string]: unknown })[discriminant];
			for (const member of members) {
				const fields = member.fields;
				if (fields !== undefined) {
					const tagSchema = fields[discriminant];
					if (
						tagSchema !== undefined &&
						tagSchema.typeName === "literal" &&
						tagSchema.value === tag
					) {
						return member.validate(candidate);
					}
				}
			}
			return false;
		},
	};
}

// Roblox userdata schemas. Validation defers to the native runtime type; the
// RemoteEvent transport serializes these directly, and the binary codec packs
// them as f32 components (see ./binary.ts).
function vector3Schema(): Schema<Vector3> {
	return {
		typeName: "vector3",
		validate: (value) => typeIs(value, "Vector3"),
	};
}

function color3Schema(): Schema<Color3> {
	return {
		typeName: "color3",
		validate: (value) => typeIs(value, "Color3"),
	};
}

function cframeSchema(): Schema<CFrame> {
	return {
		typeName: "cframe",
		validate: (value) => typeIs(value, "CFrame"),
	};
}

function joinPath(path: string, segment: string): string {
	return path === "" ? segment : `${path}.${segment}`;
}

function indexPath(path: string, index: number): string {
	return `${path === "" ? "" : path}[${index}]`;
}

function withPath(path: string, message: string): string {
	return path === "" ? message : `${path}: ${message}`;
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
		if (!typeIs(value, "number")) {
			return withPath(at, "expected number");
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
	} else if (typeName === "optional") {
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
		return undefined;
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
		return typeIs(value, "Vector3") ? undefined : withPath(at, "expected Vector3");
	} else if (typeName === "color3") {
		return typeIs(value, "Color3") ? undefined : withPath(at, "expected Color3");
	} else if (typeName === "cframe") {
		return typeIs(value, "CFrame") ? undefined : withPath(at, "expected CFrame");
	}
	return undefined;
}

export const schema = {
	string: () => stringSchemaChain([]),
	number: () => numberSchemaChain("f64", []),
	f32: () => numberSchemaChain("f32", []),
	u8: () => numberSchemaChain("u8", []),
	u16: () => numberSchemaChain("u16", []),
	u32: () => numberSchemaChain("u32", []),
	i8: () => numberSchemaChain("i8", []),
	i16: () => numberSchemaChain("i16", []),
	i32: () => numberSchemaChain("i32", []),
	boolean: booleanSchema,
	array: <S extends Schema>(item: S) => arraySchemaChain(item, []),
	optional: optionalSchema,
	record: recordSchema,
	tuple: tupleSchema,
	object: objectSchema,
	literal: literalSchema,
	enum: enumSchema,
	union: unionSchema,
	discriminatedUnion: discriminatedUnionSchema,
	vector3: vector3Schema,
	color3: color3Schema,
	cframe: cframeSchema,
};
