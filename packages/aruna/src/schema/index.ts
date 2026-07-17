export type SchemaLiteral = string | number | boolean | undefined;

// A runtime-only validation refinement: a predicate plus the message reported
// when it fails. Constraints like `.min(0)` / `.maxLength(20)` are built-in
// refinements. Refinements run after the structural check passes and never
// change the rendered TypeScript type or the wire format, so the compiler
// ignores them — they are pure runtime validation.
export type Refinement = {
  readonly check: (value: unknown) => boolean;
  readonly message: string;
};

export type StringSchema = {
  readonly kind: "string";
  readonly refinements?: readonly Refinement[];
};

// Numeric width hints. The codec uses these to pick a packed wire encoding;
// `f64` (the default for schema.number()) is the lossless full-width form.
// Integer formats additionally constrain validation to whole numbers in range.
export type NumberFormat = "f64" | "f32" | "u8" | "u16" | "u32" | "i8" | "i16" | "i32";

export type NumberSchema = {
  readonly kind: "number";
  readonly format: NumberFormat;
  readonly refinements?: readonly Refinement[];
};

// Inclusive [min, max] ranges for the integer formats. Float formats (f32/f64)
// are not range-checked beyond requiring a finite number.
export const NUMBER_FORMAT_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  u8: [0, 255],
  u16: [0, 65_535],
  u32: [0, 4_294_967_295],
  i8: [-128, 127],
  i16: [-32_768, 32_767],
  i32: [-2_147_483_648, 2_147_483_647],
};

export type BooleanSchema = {
  readonly kind: "boolean";
};

export type LiteralSchema<TValue extends SchemaLiteral = SchemaLiteral> = {
  readonly kind: "literal";
  readonly value: TValue;
};

export interface SchemaShape {
  readonly [key: string]: Schema;
}

export type ArraySchema = {
  readonly kind: "array";
  readonly item: Schema;
  readonly refinements?: readonly Refinement[];
};

export type ObjectSchema<TShape extends SchemaShape = SchemaShape> = {
  readonly kind: "object";
  readonly shape: TShape;
};

export type OptionalSchema = {
  readonly kind: "optional";
  readonly inner: Schema;
};

// A homogeneous string-keyed map (`{ [key: string]: V }`). Keys are always
// strings — the wire format is a Luau table, and non-string keys don't survive
// the plain-data boundary.
export type RecordSchema = {
  readonly kind: "record";
  readonly value: Schema;
};

// A fixed-length heterogeneous array (`[A, B, ...]`). Length is part of the
// contract: a value with a different length fails validation.
export type TupleSchema = {
  readonly kind: "tuple";
  readonly items: readonly Schema[];
};

export type EnumSchema<TValues extends readonly SchemaLiteral[] = readonly SchemaLiteral[]> = {
  readonly kind: "enum";
  readonly values: TValues;
};

export type UnionSchema = {
  readonly kind: "union";
  readonly members: readonly Schema[];
  // Present for a discriminated union: the shared field whose literal value
  // selects the member. Enables O(1) member dispatch and a precise error, and is
  // wire/type-transparent (a discriminated union has the same TS type and wire
  // encoding as a plain union of the same members).
  readonly discriminant?: string;
};

// Roblox userdata schema kinds. The roblox-ts runtime maps these to the native
// Vector3/Color3/CFrame and relies on RemoteEvent serialization to carry them;
// the Node reference runtime (and the binary wire contract) models them as plain
// numeric records so the same schema validates and round-trips off-Roblox.
export type Vector3Schema = {
  readonly kind: "vector3";
};

export type Vector2Schema = {
  readonly kind: "vector2";
};

export type Color3Schema = {
  readonly kind: "color3";
};

export type CFrameSchema = {
  readonly kind: "cframe";
};

export type UDimSchema = {
  readonly kind: "udim";
};

export type UDim2Schema = {
  readonly kind: "udim2";
};

export type Vector3Value = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
};

export type Vector2Value = {
  readonly x: number;
  readonly y: number;
};

// A Roblox UDim: a fractional `scale` plus an integer pixel `offset`.
export type UDimValue = {
  readonly scale: number;
  readonly offset: number;
};

export type UDim2Value = {
  readonly x: UDimValue;
  readonly y: UDimValue;
};

export type Color3Value = {
  readonly r: number;
  readonly g: number;
  readonly b: number;
};

// 12 numbers in CFrame:GetComponents() order: x, y, z, then the 3x3 rotation
// matrix (R00, R01, R02, R10, R11, R12, R20, R21, R22).
export type CFrameValue = {
  readonly components: readonly number[];
};

export type Schema =
  | StringSchema
  | NumberSchema
  | BooleanSchema
  | LiteralSchema
  | ArraySchema
  | ObjectSchema
  | OptionalSchema
  | RecordSchema
  | TupleSchema
  | EnumSchema
  | UnionSchema
  | Vector3Schema
  | Vector2Schema
  | Color3Schema
  | CFrameSchema
  | UDimSchema
  | UDim2Schema;

type OptionalKeys<TShape extends SchemaShape> = {
  [TKey in keyof TShape]-?: TShape[TKey] extends OptionalSchema ? TKey : never;
}[keyof TShape];

type RequiredKeys<TShape extends SchemaShape> = Exclude<keyof TShape, OptionalKeys<TShape>>;

type Simplify<T> = {
  [TKey in keyof T]: T[TKey];
};

type InferObjectSchema<TShape extends SchemaShape> = Simplify<
  {
    [TKey in RequiredKeys<TShape>]: Infer<TShape[TKey]>;
  } & {
    [TKey in OptionalKeys<TShape>]?: TShape[TKey] extends OptionalSchema
      ? TShape[TKey]["inner"] extends Schema
        ? Infer<TShape[TKey]["inner"]> | undefined
        : unknown
      : never;
  }
>;

// Canonical schema type inference. `aruna/schema` exports this name in both the
// Node reference runtime and the roblox-ts native runtime, so consumer code can
// import `Infer` from either and get the same result.
export type Infer<TSchema extends Schema> = TSchema extends StringSchema
  ? string
  : TSchema extends NumberSchema
    ? number
    : TSchema extends BooleanSchema
      ? boolean
      : TSchema extends LiteralSchema<infer TValue>
        ? TValue
        : TSchema extends ArraySchema
          ? TSchema["item"] extends Schema
            ? Infer<TSchema["item"]>[]
            : never
          : TSchema extends ObjectSchema<infer TShape>
            ? InferObjectSchema<TShape>
            : TSchema extends OptionalSchema
              ? TSchema["inner"] extends Schema
                ? Infer<TSchema["inner"]> | undefined
                : unknown
              : TSchema extends TupleSchema
                ? InferTupleSchema<TSchema["items"]>
                : TSchema extends RecordSchema
                  ? TSchema["value"] extends Schema
                    ? Record<string, Infer<TSchema["value"]>>
                    : never
                  : TSchema extends EnumSchema<infer TValues>
                    ? TValues[number]
                    : TSchema extends UnionSchema
                      ? TSchema["members"][number] extends Schema
                        ? Infer<TSchema["members"][number]>
                        : never
                      : TSchema extends Vector3Schema
                        ? Vector3Value
                        : TSchema extends Vector2Schema
                          ? Vector2Value
                          : TSchema extends Color3Schema
                            ? Color3Value
                            : TSchema extends CFrameSchema
                              ? CFrameValue
                              : TSchema extends UDimSchema
                                ? UDimValue
                                : TSchema extends UDim2Schema
                                  ? UDim2Value
                                  : never;

type InferTupleSchema<TItems extends readonly Schema[]> = {
  -readonly [TIndex in keyof TItems]: Infer<TItems[TIndex]>;
};

export type SchemaValidationIssue = {
  readonly path: readonly string[];
  readonly message: string;
};

export type SchemaValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly SchemaValidationIssue[] };

export class SchemaValidationError extends Error {
  override readonly name = "SchemaValidationError";
  readonly actionId?: string;
  readonly role?: "input" | "output";
  readonly issues: readonly SchemaValidationIssue[];

  constructor(
    message: string,
    options: {
      readonly actionId?: string;
      readonly role?: "input" | "output";
      readonly issues: readonly SchemaValidationIssue[];
    },
  ) {
    super(message);
    this.issues = options.issues;

    if (options.actionId !== undefined) {
      this.actionId = options.actionId;
    }

    if (options.role !== undefined) {
      this.role = options.role;
    }

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function formatLiteralValue(value: SchemaLiteral): string {
  if (typeof value === "string") {
    return JSON.stringify(value) ?? '""';
  }

  if (value === undefined) {
    return "undefined";
  }

  return String(value);
}

function formatPath(path: readonly string[]): string {
  if (path.length === 0) {
    return "$";
  }

  let formatted = "$";

  for (const segment of path) {
    if (segment.startsWith("[")) {
      formatted += segment;
      continue;
    }

    if (formatted === "$") {
      formatted = segment;
      continue;
    }

    formatted += `.${segment}`;
  }

  return formatted;
}

function formatIssue(issue: SchemaValidationIssue): string {
  return `${formatPath(issue.path)}: ${issue.message}`;
}

function createIssue(path: readonly string[], message: string): SchemaValidationIssue {
  return { path, message };
}

// Runs each refinement (built-in constraint or user `.refine`) against a value
// that already passed its structural check, collecting an issue per failure.
function runRefinements(
  refinements: readonly Refinement[] | undefined,
  value: unknown,
  path: readonly string[],
): readonly SchemaValidationIssue[] {
  if (refinements === undefined) {
    return [];
  }

  const issues: SchemaValidationIssue[] = [];
  for (const refinement of refinements) {
    if (!refinement.check(value)) {
      issues.push(createIssue(path, refinement.message));
    }
  }
  return issues;
}

function appendPathSegment(path: readonly string[], segment: string): readonly string[] {
  return [...path, segment];
}

function appendIndexSegment(path: readonly string[], index: number): readonly string[] {
  return [...path, `[${index}]`];
}

function isRecordLike(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The literal values a discriminated union's members carry in their discriminant
// field, for error messages.
function discriminantValues(schema: UnionSchema): readonly SchemaLiteral[] {
  const discriminant = schema.discriminant;
  if (discriminant === undefined) {
    return [];
  }

  const values: SchemaLiteral[] = [];
  for (const member of schema.members) {
    if (member.kind === "object") {
      const tagSchema = member.shape[discriminant];
      if (tagSchema?.kind === "literal") {
        values.push(tagSchema.value);
      }
    }
  }
  return values;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isVector3Value(value: unknown): value is Vector3Value {
  return (
    isRecordLike(value) &&
    isFiniteNumber(value["x"]) &&
    isFiniteNumber(value["y"]) &&
    isFiniteNumber(value["z"])
  );
}

function isVector2Value(value: unknown): value is Vector2Value {
  return isRecordLike(value) && isFiniteNumber(value["x"]) && isFiniteNumber(value["y"]);
}

function isUDimValue(value: unknown): value is UDimValue {
  return (
    isRecordLike(value) && isFiniteNumber(value["scale"]) && isFiniteNumber(value["offset"])
  );
}

function isUDim2Value(value: unknown): value is UDim2Value {
  return isRecordLike(value) && isUDimValue(value["x"]) && isUDimValue(value["y"]);
}

function isColor3Value(value: unknown): value is Color3Value {
  return (
    isRecordLike(value) &&
    isFiniteNumber(value["r"]) &&
    isFiniteNumber(value["g"]) &&
    isFiniteNumber(value["b"])
  );
}

function isCFrameValue(value: unknown): value is CFrameValue {
  if (!isRecordLike(value)) {
    return false;
  }

  const components = value["components"];
  return Array.isArray(components) && components.length === 12 && components.every(isFiniteNumber);
}

function validateSchemaAtPath(
  schema: Schema,
  value: unknown,
  path: readonly string[],
): readonly SchemaValidationIssue[] {
  switch (schema.kind) {
    case "string":
      if (typeof value !== "string") {
        return [createIssue(path, "expected string")];
      }
      return runRefinements(schema.refinements, value, path);
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return [createIssue(path, "expected finite number")];
      }

      const range = NUMBER_FORMAT_RANGES[schema.format];
      if (range !== undefined) {
        if (!Number.isInteger(value)) {
          return [createIssue(path, `expected integer for ${schema.format}`)];
        }
        if (value < range[0] || value > range[1]) {
          return [
            createIssue(path, `expected ${schema.format} in range ${range[0]}..${range[1]}`),
          ];
        }
      }

      return runRefinements(schema.refinements, value, path);
    }
    case "boolean":
      return typeof value === "boolean" ? [] : [createIssue(path, "expected boolean")];
    case "literal":
      return Object.is(value, schema.value)
        ? []
        : [createIssue(path, `expected literal ${formatLiteralValue(schema.value)}`)];
    case "array": {
      if (!Array.isArray(value)) {
        return [createIssue(path, "expected array")];
      }

      const issues: SchemaValidationIssue[] = [];

      for (let index = 0; index < value.length; index += 1) {
        issues.push(
          ...validateSchemaAtPath(schema.item, value[index], appendIndexSegment(path, index)),
        );
      }

      // Length/refinement constraints apply to the whole array once its elements
      // conform.
      if (issues.length === 0) {
        issues.push(...runRefinements(schema.refinements, value, path));
      }

      return issues;
    }
    case "object": {
      if (!isRecordLike(value)) {
        return [createIssue(path, "expected object")];
      }

      const issues: SchemaValidationIssue[] = [];

      for (const key of Object.keys(schema.shape)) {
        const propertySchema = schema.shape[key];

        if (propertySchema === undefined) {
          continue;
        }

        issues.push(
          ...validateSchemaAtPath(propertySchema, value[key], appendPathSegment(path, key)),
        );
      }

      return issues;
    }
    case "optional":
      return value === undefined ? [] : validateSchemaAtPath(schema.inner, value, path);
    case "record": {
      if (!isRecordLike(value)) {
        return [createIssue(path, "expected record object")];
      }

      const issues: SchemaValidationIssue[] = [];

      for (const key of Object.keys(value)) {
        issues.push(
          ...validateSchemaAtPath(schema.value, value[key], appendPathSegment(path, key)),
        );
      }

      return issues;
    }
    case "tuple": {
      if (!Array.isArray(value)) {
        return [createIssue(path, "expected tuple array")];
      }
      if (value.length !== schema.items.length) {
        return [
          createIssue(
            path,
            `expected tuple of length ${schema.items.length}, got ${value.length}`,
          ),
        ];
      }

      const issues: SchemaValidationIssue[] = [];

      for (let index = 0; index < schema.items.length; index += 1) {
        const itemSchema = schema.items[index];
        if (itemSchema === undefined) {
          continue;
        }
        issues.push(
          ...validateSchemaAtPath(itemSchema, value[index], appendIndexSegment(path, index)),
        );
      }

      return issues;
    }
    case "enum": {
      const allowed = schema.values.some((candidate) => Object.is(candidate, value));

      return allowed
        ? []
        : [
            createIssue(
              path,
              `expected one of ${schema.values
                .map((candidate: SchemaLiteral) => formatLiteralValue(candidate))
                .join(", ")}`,
            ),
          ];
    }
    case "union": {
      // Discriminated union: dispatch on the discriminant field so the error
      // points at the actual member instead of "none matched".
      const discriminant = schema.discriminant;
      if (discriminant !== undefined && isRecordLike(value)) {
        const tag = value[discriminant];
        for (const member of schema.members) {
          if (member.kind !== "object") {
            continue;
          }
          const tagSchema = member.shape[discriminant];
          if (tagSchema?.kind === "literal" && Object.is(tagSchema.value, tag)) {
            return validateSchemaAtPath(member, value, path);
          }
        }
        return [
          createIssue(
            appendPathSegment(path, discriminant),
            `expected one of ${discriminantValues(schema).map(formatLiteralValue).join(", ")}`,
          ),
        ];
      }

      for (const member of schema.members) {
        if (validateSchemaAtPath(member, value, path).length === 0) {
          return [];
        }
      }

      return [createIssue(path, "expected a value matching one of the union members")];
    }
    case "vector3":
      return isVector3Value(value) ? [] : [createIssue(path, "expected Vector3 { x, y, z }")];
    case "vector2":
      return isVector2Value(value) ? [] : [createIssue(path, "expected Vector2 { x, y }")];
    case "color3":
      return isColor3Value(value) ? [] : [createIssue(path, "expected Color3 { r, g, b }")];
    case "cframe":
      return isCFrameValue(value)
        ? []
        : [createIssue(path, "expected CFrame { components: number[12] }")];
    case "udim":
      return isUDimValue(value) ? [] : [createIssue(path, "expected UDim { scale, offset }")];
    case "udim2":
      return isUDim2Value(value)
        ? []
        : [createIssue(path, "expected UDim2 { x: UDim, y: UDim }")];
    default:
      throw new Error("Unsupported schema kind.");
  }
}

function buildValidationMessage(
  issues: readonly SchemaValidationIssue[],
  options?: {
    readonly actionId?: string;
    readonly role?: "input" | "output";
  },
): string {
  const actionId = options?.actionId;
  const role = options?.role;
  const prefix =
    actionId === undefined
      ? "Aruna schema validation failed"
      : role === undefined
        ? `Aruna action ${actionId} validation failed`
        : `Aruna action ${actionId} ${role} validation failed`;

  return `${prefix}: ${issues.map(formatIssue).join("; ")}`;
}

export function validateSchema(schema: Schema, value: unknown): SchemaValidationResult {
  const issues = validateSchemaAtPath(schema, value, []);

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export function assertSchema(
  schema: Schema,
  value: unknown,
  options?: {
    readonly actionId?: string;
    readonly role?: "input" | "output";
  },
): void {
  const result = validateSchema(schema, value);

  if (result.ok) {
    return;
  }

  const errorOptions: {
    actionId?: string;
    role?: "input" | "output";
    issues: readonly SchemaValidationIssue[];
  } = {
    issues: result.issues,
  };

  if (options?.actionId !== undefined) {
    errorOptions.actionId = options.actionId;
  }

  if (options?.role !== undefined) {
    errorOptions.role = options.role;
  }

  throw new SchemaValidationError(
    buildValidationMessage(result.issues, options),
    errorOptions,
  );
}

// A string schema with chainable length/refine constraints.
export interface StringSchemaChain extends StringSchema {
  minLength(value: number): StringSchemaChain;
  maxLength(value: number): StringSchemaChain;
  length(value: number): StringSchemaChain;
  refine(check: (value: unknown) => boolean, message: string): StringSchemaChain;
}

// A number schema with chainable range/int/refine constraints.
export interface NumberSchemaChain extends NumberSchema {
  min(value: number): NumberSchemaChain;
  max(value: number): NumberSchemaChain;
  int(): NumberSchemaChain;
  refine(check: (value: unknown) => boolean, message: string): NumberSchemaChain;
}

// An array schema with chainable length/refine constraints.
export interface ArraySchemaChain<TItem extends Schema = Schema> extends ArraySchema {
  readonly item: TItem;
  minItems(value: number): ArraySchemaChain<TItem>;
  maxItems(value: number): ArraySchemaChain<TItem>;
  length(value: number): ArraySchemaChain<TItem>;
  refine(check: (value: unknown) => boolean, message: string): ArraySchemaChain<TItem>;
}

function appendRefinement<TSchema extends { readonly refinements?: readonly Refinement[] }>(
  base: TSchema,
  refinement: Refinement,
): TSchema {
  return { ...base, refinements: [...(base.refinements ?? []), refinement] };
}

function stringSchemaChain(base: StringSchema): StringSchemaChain {
  return {
    ...base,
    minLength(value) {
      return stringSchemaChain(
        appendRefinement(base, {
          check: (candidate) => typeof candidate === "string" && candidate.length >= value,
          message: `expected length >= ${value}`,
        }),
      );
    },
    maxLength(value) {
      return stringSchemaChain(
        appendRefinement(base, {
          check: (candidate) => typeof candidate === "string" && candidate.length <= value,
          message: `expected length <= ${value}`,
        }),
      );
    },
    length(value) {
      return stringSchemaChain(
        appendRefinement(base, {
          check: (candidate) => typeof candidate === "string" && candidate.length === value,
          message: `expected length ${value}`,
        }),
      );
    },
    refine(check, message) {
      return stringSchemaChain(appendRefinement(base, { check, message }));
    },
  };
}

function numberSchemaChain(base: NumberSchema): NumberSchemaChain {
  return {
    ...base,
    min(value) {
      return numberSchemaChain(
        appendRefinement(base, {
          check: (candidate) => typeof candidate === "number" && candidate >= value,
          message: `expected a number >= ${value}`,
        }),
      );
    },
    max(value) {
      return numberSchemaChain(
        appendRefinement(base, {
          check: (candidate) => typeof candidate === "number" && candidate <= value,
          message: `expected a number <= ${value}`,
        }),
      );
    },
    int() {
      return numberSchemaChain(
        appendRefinement(base, {
          check: (candidate) => typeof candidate === "number" && Number.isInteger(candidate),
          message: "expected an integer",
        }),
      );
    },
    refine(check, message) {
      return numberSchemaChain(appendRefinement(base, { check, message }));
    },
  };
}

function arraySchemaChain<TItem extends Schema>(
  base: ArraySchema & { readonly item: TItem },
): ArraySchemaChain<TItem> {
  return {
    ...base,
    minItems(value) {
      return arraySchemaChain(
        appendRefinement(base, {
          check: (candidate) => Array.isArray(candidate) && candidate.length >= value,
          message: `expected at least ${value} items`,
        }),
      );
    },
    maxItems(value) {
      return arraySchemaChain(
        appendRefinement(base, {
          check: (candidate) => Array.isArray(candidate) && candidate.length <= value,
          message: `expected at most ${value} items`,
        }),
      );
    },
    length(value) {
      return arraySchemaChain(
        appendRefinement(base, {
          check: (candidate) => Array.isArray(candidate) && candidate.length === value,
          message: `expected exactly ${value} items`,
        }),
      );
    },
    refine(check, message) {
      return arraySchemaChain(appendRefinement(base, { check, message }));
    },
  };
}

export const schema = {
  string(): StringSchemaChain {
    return stringSchemaChain({ kind: "string" });
  },

  number(): NumberSchemaChain {
    return numberSchemaChain({ kind: "number", format: "f64" });
  },

  f32(): NumberSchemaChain {
    return numberSchemaChain({ kind: "number", format: "f32" });
  },

  u8(): NumberSchemaChain {
    return numberSchemaChain({ kind: "number", format: "u8" });
  },

  u16(): NumberSchemaChain {
    return numberSchemaChain({ kind: "number", format: "u16" });
  },

  u32(): NumberSchemaChain {
    return numberSchemaChain({ kind: "number", format: "u32" });
  },

  i8(): NumberSchemaChain {
    return numberSchemaChain({ kind: "number", format: "i8" });
  },

  i16(): NumberSchemaChain {
    return numberSchemaChain({ kind: "number", format: "i16" });
  },

  i32(): NumberSchemaChain {
    return numberSchemaChain({ kind: "number", format: "i32" });
  },

  boolean(): BooleanSchema {
    return { kind: "boolean" };
  },

  literal<TValue extends SchemaLiteral>(value: TValue): LiteralSchema<TValue> {
    return { kind: "literal", value };
  },

  array<const TItem extends Schema>(item: TItem): ArraySchemaChain<TItem> {
    return arraySchemaChain({ kind: "array", item });
  },

  object<const TShape extends SchemaShape>(shape: TShape): ObjectSchema<TShape> {
    return { kind: "object", shape };
  },

  optional<const TInner extends Schema>(
    inner: TInner,
  ): OptionalSchema & {
    readonly inner: TInner;
  } {
    return { kind: "optional", inner };
  },

  // Returned as an exact object type (not `RecordSchema & {...}`): an
  // intersection here makes `Infer`'s indexed accesses produce `Schema & TValue`
  // intersections, which TypeScript expands explosively (TS2589).
  record<const TValue extends Schema>(
    value: TValue,
  ): { readonly kind: "record"; readonly value: TValue } {
    return { kind: "record", value };
  },

  tuple<const TItems extends readonly Schema[]>(
    items: TItems,
  ): { readonly kind: "tuple"; readonly items: TItems } {
    return { kind: "tuple", items };
  },

  enum<const TValues extends readonly SchemaLiteral[]>(values: TValues): EnumSchema<TValues> {
    return { kind: "enum", values };
  },

  union<const TMembers extends readonly Schema[]>(
    members: TMembers,
  ): UnionSchema & { readonly members: TMembers } {
    return { kind: "union", members };
  },

  // A tagged union: members share a `discriminant` field carrying a distinct
  // literal, so validation dispatches on it (O(1), precise errors) rather than
  // trying each member. Same inferred type and wire encoding as `union`.
  discriminatedUnion<
    const TDiscriminant extends string,
    const TMembers extends readonly ObjectSchema[],
  >(
    discriminant: TDiscriminant,
    members: TMembers,
  ): UnionSchema & { readonly members: TMembers; readonly discriminant: TDiscriminant } {
    return { kind: "union", members, discriminant };
  },

  vector3(): Vector3Schema {
    return { kind: "vector3" };
  },

  vector2(): Vector2Schema {
    return { kind: "vector2" };
  },

  color3(): Color3Schema {
    return { kind: "color3" };
  },

  cframe(): CFrameSchema {
    return { kind: "cframe" };
  },

  udim(): UDimSchema {
    return { kind: "udim" };
  },

  udim2(): UDim2Schema {
    return { kind: "udim2" };
  },
};
