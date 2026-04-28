import gradient from "gradient-string";
import pc from "picocolors";

export type ArunaCliPaletteName = "sunrise" | "softAurora" | "minimalCyan";
export type ArunaCliSeverity = "error" | "warning" | "info" | "success" | "muted";
export type ArunaCliColorMode = {
  enabled: boolean;
};

// Palette source: aruna-framework-spec CLI visual style.
export const ARUNA_CLI_PALETTES = {
  sunrise: ["#f6c177", "#eb6f92", "#9ccfd8"],
  softAurora: ["#c4a7e7", "#9ccfd8", "#f6c177"],
  minimalCyan: ["#9ccfd8", "#31748f"],
} as const;

export const ARUNA_CLI_DEFAULT_PALETTE: ArunaCliPaletteName = "softAurora";

function withColor(colorMode: ArunaCliColorMode, apply: (input: string) => string, text: string): string {
  return colorMode.enabled ? apply(text) : text;
}

export function brandGradient(name: ArunaCliPaletteName, enabled: boolean): (input: string) => string {
  if (!enabled) {
    return (input: string) => input;
  }

  return gradient([...ARUNA_CLI_PALETTES[name]]);
}

export function brandText(name: ArunaCliPaletteName, text: string, enabled: boolean): string {
  return brandGradient(name, enabled)(text);
}

export function formatBrandTitle(text: string, colorMode: ArunaCliColorMode): string {
  return brandText(ARUNA_CLI_DEFAULT_PALETTE, text, colorMode.enabled);
}

export function formatSectionTitle(text: string, colorMode: ArunaCliColorMode): string {
  return brandText("minimalCyan", text, colorMode.enabled);
}

export function formatStrong(text: string, colorMode: ArunaCliColorMode): string {
  return withColor(colorMode, pc.bold, text);
}

export function formatMuted(text: string, colorMode: ArunaCliColorMode): string {
  return withColor(colorMode, pc.dim, text);
}

export function formatSuccess(text: string, colorMode: ArunaCliColorMode): string {
  return withColor(colorMode, pc.green, text);
}

export function formatWarning(text: string, colorMode: ArunaCliColorMode): string {
  return withColor(colorMode, pc.yellow, text);
}

export function formatError(text: string, colorMode: ArunaCliColorMode): string {
  return withColor(colorMode, pc.red, text);
}

export function formatInfo(text: string, colorMode: ArunaCliColorMode): string {
  return withColor(colorMode, pc.cyan, text);
}

export function formatSeverityLabel(
  severity: ArunaCliSeverity,
  text: string,
  colorMode: ArunaCliColorMode,
): string {
  switch (severity) {
    case "error":
      return formatError(text, colorMode);
    case "warning":
      return formatWarning(text, colorMode);
    case "info":
      return formatInfo(text, colorMode);
    case "success":
      return formatSuccess(text, colorMode);
    case "muted":
      return formatMuted(text, colorMode);
  }
}
