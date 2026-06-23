import type { CompilerOutput } from "@arunajs/core";
import { formatBrandTitle, formatStrong } from "./theme.js";
import type { SignalContractRecord } from "./action-contracts.js";
import { buildActionContractSnapshot } from "./action-contracts.js";
import type { CliColorMode } from "./format.js";

export type SignalInspectionReport = {
  signals: SignalContractRecord[];
  diagnostics: CompilerOutput["diagnostics"];
  summary: CompilerOutput["summary"];
};

export function buildSignalInspectionReport(output: CompilerOutput): SignalInspectionReport {
  const snapshot = buildActionContractSnapshot(output);

  return {
    signals: [...(snapshot.signals ?? [])],
    diagnostics: output.diagnostics,
    summary: output.summary,
  };
}

function renderSignalBlock(signal: SignalContractRecord, colors: CliColorMode): string[] {
  return [
    `  ${formatStrong(signal.id, colors)}`,
    `    source: ${signal.source}`,
    `    direction: ${signal.direction}`,
    `    payload: ${signal.payload.summary}`,
    `    serialization: ${signal.serialization.policy}`,
  ];
}

export function formatSignalInspection(output: CompilerOutput, colors: CliColorMode): string {
  const report = buildSignalInspectionReport(output);
  const lines: string[] = [
    formatBrandTitle("aruna inspect signals", colors),
    "",
    `  ${report.signals.length} ${report.signals.length === 1 ? "signal" : "signals"} discovered`,
    "",
  ];

  for (const signal of report.signals) {
    lines.push(...renderSignalBlock(signal, colors));
    lines.push("");
  }

  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  lines.push("");
  lines.push("Use --json for machine-readable output.");

  return lines.join("\n");
}
