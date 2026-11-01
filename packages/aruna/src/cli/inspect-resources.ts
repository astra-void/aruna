import type { CompilerOutput } from "@arunajs/core";
import { formatBrandTitle, formatStrong } from "./theme.js";
import type { ResourceContractRecord } from "./action-contracts.js";
import { buildActionContractSnapshot } from "./action-contracts.js";
import type { CliColorMode } from "./format.js";

export type ResourceInspectionReport = {
  resources: ResourceContractRecord[];
  diagnostics: CompilerOutput["diagnostics"];
  summary: CompilerOutput["summary"];
};

export function buildResourceInspectionReport(output: CompilerOutput): ResourceInspectionReport {
  const snapshot = buildActionContractSnapshot(output);

  return {
    resources: [...(snapshot.resources ?? [])],
    diagnostics: output.diagnostics,
    summary: output.summary,
  };
}

// Static policy only: what the contract says. How many players subscribe, and
// how often a resource is sent, is runtime data (`createNetworkMetrics`).
function renderResourceBlock(resource: ResourceContractRecord, colors: CliColorMode): string[] {
  return [
    `  ${formatStrong(resource.id, colors)}`,
    `    source: ${resource.source}`,
    `    scope: ${
      resource.scope === "player"
        ? "player (each subscriber sees only their own value)"
        : "global (one value, sent to every subscriber)"
    }`,
    `    value: ${resource.value.summary}`,
    `    subscriptions: ${resource.authorized === true ? "authorized by authorize(ctx)" : "open to every player"}`,
    "    transport: whole snapshots on the reliable channel, ordered by revision",
    `    serialization: ${resource.serialization.policy}`,
  ];
}

export function formatResourceInspection(output: CompilerOutput, colors: CliColorMode): string {
  const report = buildResourceInspectionReport(output);
  const lines: string[] = [
    formatBrandTitle("aruna inspect resources", colors),
    "",
    `  ${report.resources.length} ${report.resources.length === 1 ? "resource" : "resources"} discovered`,
    "",
  ];

  for (const resource of report.resources) {
    lines.push(...renderResourceBlock(resource, colors));
    lines.push("");
  }

  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  lines.push("");
  lines.push("Use --json for machine-readable output.");

  return lines.join("\n");
}
