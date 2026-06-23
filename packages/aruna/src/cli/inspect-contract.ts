import type { CompilerOutput } from "@arunajs/core";
import { buildActionContractSnapshot } from "./action-contracts.js";
import { formatBrandTitle } from "./theme.js";
import type { CliColorMode } from "./format.js";

function commandTitle(command: string, colors: CliColorMode): string {
  return formatBrandTitle(`aruna ${command}`, colors);
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function countRateLimitedActions(output: CompilerOutput): number {
  return output.manifest.actions.filter((action) => action.rateLimit !== undefined).length;
}

export function formatActionContractInspection(
  output: CompilerOutput,
  colors: CliColorMode,
): string {
  const snapshot = buildActionContractSnapshot(output);
  const lines: string[] = [commandTitle("inspect contract", colors), ""];

  if (!output.ok || output.diagnostics.length > 0) {
    lines.push(
      `  ${output.summary.errors} ${output.summary.errors === 1 ? "error" : "errors"} found`,
    );
    if (output.summary.warnings > 0) {
      lines.push(
        `  ${output.summary.warnings} ${output.summary.warnings === 1 ? "warning" : "warnings"} found`,
      );
    }
    lines.push("");
    return lines.join("\n").trimEnd();
  }

  lines.push(`  ${pluralize(snapshot.actions.length, "action contract", "action contracts")}`);
  lines.push(`  serialization policy: plain-data-v1`);
  lines.push(`  rate-limited actions: ${countRateLimitedActions(output)}`);
  lines.push("");
  lines.push(`  Use --json to emit a deterministic contract snapshot.`);
  return lines.join("\n").trimEnd();
}

export { buildActionContractSnapshot };
