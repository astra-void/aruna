import { schema, type Infer } from "aruna/schema";

export const startWaveInputSchema = schema.object({
  waveId: schema.string(),
  difficulty: schema.enum(["easy", "normal", "hard"] as const),
});

export const startWaveOutputSchema = schema.object({
  started: schema.boolean(),
});

export type StartWaveInput = Infer<typeof startWaveInputSchema>;
export type StartWaveOutput = Infer<typeof startWaveOutputSchema>;
