import { assertSchema, type InferSchema, type Schema } from "../schema/index.js";

export type ActionRunContext<TPlayer = unknown> = {
  player?: TPlayer;
};

type ActionSchemaInput<TSchema extends Schema | undefined> = [TSchema] extends [Schema]
  ? InferSchema<TSchema>
  : unknown;

type ActionSchemaOutput<TSchema extends Schema | undefined> = [TSchema] extends [Schema]
  ? InferSchema<TSchema>
  : unknown;

export type ActionDefinition<
  TInputSchema extends Schema | undefined = undefined,
  TOutputSchema extends Schema | undefined = undefined,
  TPlayer = unknown,
> = {
  readonly id: string;
  readonly input?: TInputSchema;
  readonly output?: TOutputSchema;
  run(
    ctx: ActionRunContext<TPlayer>,
    input: ActionSchemaInput<TInputSchema>,
  ): ActionSchemaOutput<TOutputSchema> | Promise<ActionSchemaOutput<TOutputSchema>>;
};

export type InferInput<
  TAction extends ActionDefinition<Schema | undefined, Schema | undefined, unknown>,
> = TAction extends ActionDefinition<infer TInputSchema, infer _TOutputSchema, infer _TPlayer>
  ? ActionSchemaInput<TInputSchema>
  : never;

export type InferOutput<
  TAction extends ActionDefinition<Schema | undefined, Schema | undefined, unknown>,
> = TAction extends ActionDefinition<infer _TInputSchema, infer TOutputSchema, infer _TPlayer>
  ? ActionSchemaOutput<TOutputSchema>
  : never;

export type ActionRegistry<TPlayer = unknown> = Record<
  string,
  ActionDefinition<Schema | undefined, Schema | undefined, TPlayer>
>;

export async function dispatchAction<TPlayer = unknown>(
  registry: ActionRegistry<TPlayer>,
  actionId: string,
  ctx: ActionRunContext<TPlayer>,
  input: unknown,
): Promise<unknown> {
  const action = registry[actionId];

  if (action === undefined) {
    throw new Error(`Aruna action not found: ${actionId}`);
  }

  if (action.input !== undefined) {
    assertSchema(action.input, input, { actionId, role: "input" });
  }

  const output = await Promise.resolve(action.run(ctx, input));

  if (action.output !== undefined) {
    assertSchema(action.output, output, { actionId, role: "output" });
  }

  return output;
}
