import type { StartWaveInput } from "../schema/start-wave";

export function describeWave(input: StartWaveInput): string {
  return `${input.waveId}:${input.difficulty}`;
}

export function summarizeWavePreview(): string {
  return describeWave({
    waveId: "opening",
    difficulty: "easy",
  });
}
