import { schema, type Infer } from "aruna/schema";

export const actionResultSchema = schema.object({
  ok: schema.boolean(),
  reason: schema.optional(schema.string()),
});

export type ActionResult = Infer<typeof actionResultSchema>;

export function createActionResult(ok: boolean, reason?: string): ActionResult {
  if (reason === undefined) {
    return { ok };
  }

  return { ok, reason };
}
