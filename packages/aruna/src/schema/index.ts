export type SchemaLiteral = string | number | boolean | undefined;

export type StringSchema = {
  readonly kind: "string";
};

export type NumberSchema = {
  readonly kind: "number";
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

export type Schema =
  | StringSchema
  | NumberSchema
  | BooleanSchema
  | LiteralSchema
  | ArraySchema
  | ObjectSchema
  | OptionalSchema
  | EnumSchema
  | UnionSchema;

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
                  : never;

export type SchemaValidationIssue = {
  readonly path: readonly string[];
  readonly message: string;
};

export type SchemaValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly SchemaValidationIssue[] };

export class ArunaSchemaValidationError extends Error {
  override readonly name = "ArunaSchemaValidationError";
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

function validateSchemaAtPath(
  schema: Schema,
  value: unknown,
  path: readonly string[],
): readonly SchemaValidationIssue[] {
  switch (schema.kind) {
    case "string":
      return typeof value === "string" ? [] : [createIssue(path, "expected string")];
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? []
        : [createIssue(path, "expected finite number")];
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

  throw new ArunaSchemaValidationError(
    buildValidationMessage(result.issues, options),
    errorOptions,
  );
}

export const schema = {
  string(): StringSchema {
    return { kind: "string" };
  },

  number(): NumberSchema {
    return { kind: "number" };
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
};
