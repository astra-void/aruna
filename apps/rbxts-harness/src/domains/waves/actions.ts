import { describeWave } from "./runtime";

export function summarizeWavePreview(): string {
  return describeWave({
    waveId: "opening",
    difficulty: "easy",
  });
}
