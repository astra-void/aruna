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
	| "literal"
	| "enum"
	| "union"
	| "vector3"
	| "color3"
	| "cframe";

export type SchemaLiteral = string | number | boolean;

// Structural metadata is carried alongside `validate` so schema-driven tools
// (the binary codec, manifest emission) can read the layout without re-deriving
// it. Mirrors the Node reference schema's discriminated shape; fields are
// populated per typeName by the builders below.
export interface Schema<T = unknown> {
	readonly typeName: SchemaTypeName;
	readonly validate: (value: unknown) => boolean;
	readonly _output?: T;
	readonly item?: Schema;
	readonly fields?: { readonly [key: string]: Schema };
	readonly inner?: Schema;
	readonly value?: SchemaLiteral;
	readonly values?: readonly SchemaLiteral[];
	readonly members?: readonly Schema[];
	readonly format?: NumberFormat;
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

// Alias for parity with the Node reference schema's `InferSchema`, so consumer
// code that imports `InferSchema` from `aruna/schema` works against the vendored
// runtime too.
export type InferSchema<S> = Infer<S>;

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

function stringSchema(): Schema<string> {
	return primitiveSchema<string>("string", "string");
}

function numberSchemaWithFormat(format: NumberFormat): Schema<number> {
	const range = NUMBER_FORMAT_RANGES.get(format);
	return {
		typeName: "number",
		format,
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
			return true;
		},
	};
}

function numberSchema(): Schema<number> {
	return numberSchemaWithFormat("f64");
}

function booleanSchema(): Schema<boolean> {
	return primitiveSchema<boolean>("boolean", "boolean");
}

function arraySchema<S extends Schema>(item: S): Schema<Array<Infer<S>>> {
	return {
		typeName: "array",
		item,
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
			return true;
		},
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

export const schema = {
	string: stringSchema,
	number: numberSchema,
	f32: () => numberSchemaWithFormat("f32"),
	u8: () => numberSchemaWithFormat("u8"),
	u16: () => numberSchemaWithFormat("u16"),
	u32: () => numberSchemaWithFormat("u32"),
	i8: () => numberSchemaWithFormat("i8"),
	i16: () => numberSchemaWithFormat("i16"),
	i32: () => numberSchemaWithFormat("i32"),
	boolean: booleanSchema,
	array: arraySchema,
	optional: optionalSchema,
	object: objectSchema,
	literal: literalSchema,
	enum: enumSchema,
	union: unionSchema,
	vector3: vector3Schema,
	color3: color3Schema,
	cframe: cframeSchema,
};
