import type { Schema } from "./schema.js";

export type ActionDefinition = {
  id: string;
  input?: Schema<unknown> | undefined;
  output?: Schema<unknown> | undefined;
  run: (ctx: unknown, input: unknown) => unknown | Promise<unknown>;
};

export function defineAction<const TDefinition extends ActionDefinition>(
  definition: TDefinition,
): TDefinition {
  return definition;
}
