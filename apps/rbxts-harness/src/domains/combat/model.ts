export type CombatPhase = "idle" | "active" | "complete";

export type CombatState = {
  readonly phase: CombatPhase;
  readonly waveIndex: number;
};
