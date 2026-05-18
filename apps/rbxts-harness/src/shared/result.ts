import { schema, type InferSchema } from "aruna";

export const actionResultSchema = schema.object({
  ok: schema.boolean(),
  reason: schema.optional(schema.string()),
});

export type ActionResult = InferSchema<typeof actionResultSchema>;

export function createActionResult(ok: boolean, reason?: string): ActionResult {
  if (reason === undefined) {
    return { ok };
  }

  return { ok, reason };
}
