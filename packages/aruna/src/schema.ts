export type Schema<TValue = unknown> = {
  readonly kind: string;
  readonly shape?: Record<string, Schema<unknown>> | undefined;
  readonly __type?: TValue | undefined;
};

function createSchema<TValue>(
  kind: string,
  shape?: Record<string, Schema<unknown>>,
): Schema<TValue> {
  if (shape === undefined) {
    return { kind };
  }

  return { kind, shape };
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

  object<TShape extends Record<string, Schema<unknown>>>(
    shape: TShape,
  ): Schema<{ [Key in keyof TShape]: unknown }> {
    return createSchema<{ [Key in keyof TShape]: unknown }>("object", shape);
  },
};
