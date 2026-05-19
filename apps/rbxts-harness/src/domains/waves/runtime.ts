import type { StartWaveInput } from "./schema";

export function describeWave(input: StartWaveInput): string {
  return `${input.waveId}:${input.difficulty}`;
}
