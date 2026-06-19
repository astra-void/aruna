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
	| "union";

export type SchemaLiteral = string | number | boolean;

export interface Schema<T = unknown> {
	readonly typeName: SchemaTypeName;
	readonly validate: (value: unknown) => boolean;
	readonly _output?: T;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

type FieldRecord = { readonly [key: string]: Schema };
type InferFields<F extends FieldRecord> = { [K in keyof F]: Infer<F[K]> };

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

function numberSchema(): Schema<number> {
	return primitiveSchema<number>("number", "number");
}

function booleanSchema(): Schema<boolean> {
	return primitiveSchema<boolean>("boolean", "boolean");
}

function arraySchema<S extends Schema>(item: S): Schema<Array<Infer<S>>> {
	return {
		typeName: "array",
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
		validate: (candidate) => candidate === value,
	};
}

function enumSchema<const TValues extends readonly SchemaLiteral[]>(
	values: TValues,
): Schema<TValues[number]> {
	return {
		typeName: "enum",
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

export const schema = {
	string: stringSchema,
	number: numberSchema,
	boolean: booleanSchema,
	array: arraySchema,
	optional: optionalSchema,
	object: objectSchema,
	literal: literalSchema,
	enum: enumSchema,
	union: unionSchema,
};
