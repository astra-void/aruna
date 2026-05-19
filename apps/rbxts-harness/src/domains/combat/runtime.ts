import type { CombatState } from "./model";

export function createCombatState(): CombatState {
  return {
    phase: "idle",
    waveIndex: 0,
  };
}
