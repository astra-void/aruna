import gradient from "gradient-string";

export type ArunaCliPaletteName = "sunrise" | "softAurora" | "minimalCyan";

// Palette source: aruna-framework-spec CLI visual style.
export const ARUNA_CLI_PALETTES = {
  sunrise: ["#f6c177", "#eb6f92", "#9ccfd8"],
  softAurora: ["#c4a7e7", "#9ccfd8", "#f6c177"],
  minimalCyan: ["#9ccfd8", "#31748f"],
} as const;

export const ARUNA_CLI_DEFAULT_PALETTE: ArunaCliPaletteName = "softAurora";

export function brandGradient(name: ArunaCliPaletteName, enabled: boolean): (input: string) => string {
  if (!enabled) {
    return (input: string) => input;
  }

  return gradient([...ARUNA_CLI_PALETTES[name]]);
}

export function brandText(name: ArunaCliPaletteName, text: string, enabled: boolean): string {
  return brandGradient(name, enabled)(text);
}
