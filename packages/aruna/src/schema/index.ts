export type SchemaLiteral = string | number | boolean | undefined;

export type StringSchema = {
  readonly kind: "string";
};

// Numeric width hints. The codec uses these to pick a packed wire encoding;
// `f64` (the default for schema.number()) is the lossless full-width form.
// Integer formats additionally constrain validation to whole numbers in range.
export type NumberFormat = "f64" | "f32" | "u8" | "u16" | "u32" | "i8" | "i16" | "i32";

export type NumberSchema = {
  readonly kind: "number";
  readonly format: NumberFormat;
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
};

export type ObjectSchema<TShape extends SchemaShape = SchemaShape> = {
  readonly kind: "object";
  readonly shape: TShape;
};

export type OptionalSchema = {
  readonly kind: "optional";
  readonly inner: Schema;
};

export type EnumSchema<TValues extends readonly SchemaLiteral[] = readonly SchemaLiteral[]> = {
  readonly kind: "enum";
  readonly values: TValues;
};

export type UnionSchema = {
  readonly kind: "union";
  readonly members: readonly Schema[];
};

// Roblox userdata schema kinds. The roblox-ts runtime maps these to the native
// Vector3/Color3/CFrame and relies on RemoteEvent serialization to carry them;
// the Node reference runtime (and the binary wire contract) models them as plain
// numeric records so the same schema validates and round-trips off-Roblox.
export type Vector3Schema = {
  readonly kind: "vector3";
};

export type Color3Schema = {
  readonly kind: "color3";
};

export type CFrameSchema = {
  readonly kind: "cframe";
};

export type Vector3Value = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
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
  | EnumSchema
  | UnionSchema
  | Vector3Schema
  | Color3Schema
  | CFrameSchema;

type OptionalKeys<TShape extends SchemaShape> = {
  [TKey in keyof TShape]-?: TShape[TKey] extends OptionalSchema ? TKey : never;
}[keyof TShape];

type RequiredKeys<TShape extends SchemaShape> = Exclude<keyof TShape, OptionalKeys<TShape>>;

type Simplify<T> = {
  [TKey in keyof T]: T[TKey];
};

type InferObjectSchema<TShape extends SchemaShape> = Simplify<
  {
    [TKey in RequiredKeys<TShape>]: InferSchema<TShape[TKey]>;
  } & {
    [TKey in OptionalKeys<TShape>]?: TShape[TKey] extends OptionalSchema
      ? TShape[TKey]["inner"] extends Schema
        ? InferSchema<TShape[TKey]["inner"]> | undefined
        : unknown
      : never;
  }
>;

export type InferSchema<TSchema extends Schema> = TSchema extends StringSchema
  ? string
  : TSchema extends NumberSchema
    ? number
    : TSchema extends BooleanSchema
      ? boolean
      : TSchema extends LiteralSchema<infer TValue>
        ? TValue
        : TSchema extends ArraySchema
          ? TSchema["item"] extends Schema
            ? InferSchema<TSchema["item"]>[]
            : never
          : TSchema extends ObjectSchema<infer TShape>
            ? InferObjectSchema<TShape>
            : TSchema extends OptionalSchema
              ? TSchema["inner"] extends Schema
                ? InferSchema<TSchema["inner"]> | undefined
                : unknown
              : TSchema extends EnumSchema<infer TValues>
                ? TValues[number]
                : TSchema extends UnionSchema
                  ? TSchema["members"][number] extends Schema
                    ? InferSchema<TSchema["members"][number]>
                    : never
                  : TSchema extends Vector3Schema
                    ? Vector3Value
                    : TSchema extends Color3Schema
                      ? Color3Value
                      : TSchema extends CFrameSchema
                        ? CFrameValue
                        : never;

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

function appendPathSegment(path: readonly string[], segment: string): readonly string[] {
  return [...path, segment];
}

function appendIndexSegment(path: readonly string[], index: number): readonly string[] {
  return [...path, `[${index}]`];
}

function isRecordLike(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      return typeof value === "string" ? [] : [createIssue(path, "expected string")];
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

      return [];
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
      for (const member of schema.members) {
        if (validateSchemaAtPath(member, value, path).length === 0) {
          return [];
        }
      }

      return [createIssue(path, "expected a value matching one of the union members")];
    }
    case "vector3":
      return isVector3Value(value) ? [] : [createIssue(path, "expected Vector3 { x, y, z }")];
    case "color3":
      return isColor3Value(value) ? [] : [createIssue(path, "expected Color3 { r, g, b }")];
    case "cframe":
      return isCFrameValue(value)
        ? []
        : [createIssue(path, "expected CFrame { components: number[12] }")];
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

export const schema = {
  string(): StringSchema {
    return { kind: "string" };
  },

  number(): NumberSchema {
    return { kind: "number", format: "f64" };
  },

  f32(): NumberSchema {
    return { kind: "number", format: "f32" };
  },

  u8(): NumberSchema {
    return { kind: "number", format: "u8" };
  },

  u16(): NumberSchema {
    return { kind: "number", format: "u16" };
  },

  u32(): NumberSchema {
    return { kind: "number", format: "u32" };
  },

  i8(): NumberSchema {
    return { kind: "number", format: "i8" };
  },

  i16(): NumberSchema {
    return { kind: "number", format: "i16" };
  },

  i32(): NumberSchema {
    return { kind: "number", format: "i32" };
  },

  boolean(): BooleanSchema {
    return { kind: "boolean" };
  },

  literal<TValue extends SchemaLiteral>(value: TValue): LiteralSchema<TValue> {
    return { kind: "literal", value };
  },

  array<const TItem extends Schema>(item: TItem): ArraySchema & { readonly item: TItem } {
    return { kind: "array", item };
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

  enum<const TValues extends readonly SchemaLiteral[]>(values: TValues): EnumSchema<TValues> {
    return { kind: "enum", values };
  },

  union<const TMembers extends readonly Schema[]>(
    members: TMembers,
  ): UnionSchema & { readonly members: TMembers } {
    return { kind: "union", members };
  },

  vector3(): Vector3Schema {
    return { kind: "vector3" };
  },

  color3(): Color3Schema {
    return { kind: "color3" };
  },

  cframe(): CFrameSchema {
    return { kind: "cframe" };
  },
};
