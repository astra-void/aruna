export type SchemaValue = string | number | boolean | null;

export type Schema<TValue = unknown> = {
  readonly kind: string;
  readonly shape?: Record<string, Schema<unknown>> | undefined;
  readonly properties?: Record<string, Schema<unknown>> | undefined;
  readonly items?: Schema<unknown> | undefined;
  readonly item?: Schema<unknown> | undefined;
  readonly value?: SchemaValue | undefined;
  readonly values?: readonly SchemaValue[] | undefined;
  readonly __type?: TValue | undefined;
};

function createSchema<TValue>(
  kind: string,
  fields: Partial<Schema<unknown>> = {},
): Schema<TValue> {
  return {
    kind,
    ...fields,
  } as Schema<TValue>;
}

export const schema = {
  string(): Schema<string> {
    return createSchema<string>("string");
  },

  number(): Schema<number> {
    return createSchema<number>("number");
  },

  boolean(): Schema<boolean> {
    return createSchema<boolean>("boolean");
  },

  literal<TValue extends SchemaValue>(value: TValue): Schema<TValue> {
    return createSchema<TValue>("literal", { value });
  },

  array<TValue>(items: Schema<TValue>): Schema<TValue[]> {
    return createSchema<TValue[]>("array", { items });
  },

  object<TShape extends Record<string, Schema<unknown>>>(
    shape: TShape,
  ): Schema<{ [Key in keyof TShape]: unknown }> {
    return createSchema<{ [Key in keyof TShape]: unknown }>("object", {
      shape,
      properties: shape,
    });
  },

  optional<TValue>(item: Schema<TValue>): Schema<TValue | undefined> {
    return createSchema<TValue | undefined>("optional", { item });
  },

  enum<const TValues extends readonly SchemaValue[]>(
    values: TValues,
  ): Schema<TValues[number]> {
    return createSchema<TValues[number]>("enum", { values });
  },
};
