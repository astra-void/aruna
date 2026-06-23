import { schema, type InferSchema } from "aruna/schema";

export const startWaveInputSchema = schema.object({
  waveId: schema.string(),
  difficulty: schema.enum(["easy", "normal", "hard"] as const),
});

export const startWaveOutputSchema = schema.object({
  started: schema.boolean(),
});

export type StartWaveInput = InferSchema<typeof startWaveInputSchema>;
export type StartWaveOutput = InferSchema<typeof startWaveOutputSchema>;
