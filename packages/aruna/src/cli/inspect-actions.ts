import type { ArunaCompilerOutput } from "@arunajs/core";
import { formatBrandTitle, formatStrong, formatSuccess, formatWarning } from "./theme.js";
import type { ActionContractRecord } from "./action-contracts.js";
import { buildActionContractSnapshot } from "./action-contracts.js";
import type { CliColorMode } from "./format.js";

type ActionInspectionEntry = ActionContractRecord;

export type ActionInspectionReport = {
  actions: ActionInspectionEntry[];
  diagnostics: ArunaCompilerOutput["diagnostics"];
  summary: ArunaCompilerOutput["summary"];
};

function commandTitle(command: string, colors: CliColorMode): string {
  return formatBrandTitle(`aruna ${command}`, colors);
}

function strong(text: string, colors: CliColorMode): string {
  return formatStrong(text, colors);
}

function success(text: string, colors: CliColorMode): string {
  return formatSuccess(text, colors);
}

function warning(text: string, colors: CliColorMode): string {
  return formatWarning(text, colors);
}

export function buildActionInspectionReport(output: ArunaCompilerOutput): ActionInspectionReport {
  const snapshot = buildActionContractSnapshot(output);
  const actions = snapshot.actions as ActionInspectionEntry[];

  return {
    actions,
    diagnostics: output.diagnostics,
    summary: output.summary,
  };
}

function renderActionWarnings(warnings: readonly string[], colors: CliColorMode): string[] {
  if (warnings.length === 0) {
    return [];
  }

  return [
    `    warnings: ${warnings.map((warningText) => warning(warningText, colors)).join(", ")}`,
  ];
}

function renderRateLimit(
  rateLimit: ActionInspectionEntry["rateLimit"],
  colors: CliColorMode,
): string {
  if (!rateLimit) {
    return `    rate limit: ${success("none", colors)}`;
  }

  return `    rate limit: ${rateLimit.key}, max ${rateLimit.max} / ${rateLimit.windowMs}ms`;
}

function renderActionBlock(action: ActionInspectionEntry, colors: CliColorMode): string[] {
  const lines = [
    `  ${strong(action.id, colors)}`,
    `    source: ${action.source}`,
    `    input: ${action.input.summary}`,
    `    output: ${action.output.summary}`,
    `    serialization: ${action.serialization.policy}`,
    renderRateLimit(action.rateLimit, colors),
    `    authority: server-owned, client callable`,
  ];

  lines.push(...renderActionWarnings(action.warnings, colors));
  return lines;
}

export function formatActionInspection(output: ArunaCompilerOutput, colors: CliColorMode): string {
  const report = buildActionInspectionReport(output);
  const lines: string[] = [
    commandTitle("inspect actions", colors),
    "",
    `  ${report.actions.length} ${report.actions.length === 1 ? "action" : "actions"} discovered`,
    "",
  ];

  for (const action of report.actions) {
    lines.push(...renderActionBlock(action, colors));
    lines.push("");
  }

  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  lines.push("");
  lines.push("Use --json for machine-readable output.");

  return lines.join("\n");
}
