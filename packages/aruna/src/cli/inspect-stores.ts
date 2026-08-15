import type { CompilerOutput, StoreRecord } from "@arunajs/core";
import { formatBrandTitle, formatStrong } from "./theme.js";
import { formatActionSchemaSummary } from "./format-action-schema.js";
import type { CliColorMode } from "./format.js";

export type StoreInspectionRecord = {
  id: string;
  kind: StoreRecord["kind"];
  source: string;
  exportName: string;
  version: number;
  scope: string | undefined;
  hasMigrate: boolean;
  schema: string;
};

export type StoreInspectionReport = {
  stores: StoreInspectionRecord[];
  diagnostics: CompilerOutput["diagnostics"];
  summary: CompilerOutput["summary"];
};

export function buildStoreInspectionReport(output: CompilerOutput): StoreInspectionReport {
  const stores = output.manifest.stores ?? [];

  return {
    stores: stores.map((store) => ({
      id: store.id,
      kind: store.kind,
      source: store.file,
      exportName: store.exportName,
      version: store.version,
      scope: store.scope,
      hasMigrate: store.hasMigrate === true,
      schema: formatActionSchemaSummary(store.schema).summary,
    })),
    diagnostics: output.diagnostics,
    summary: output.summary,
  };
}

function renderStoreBlock(store: StoreInspectionRecord, colors: CliColorMode): string[] {
  const lines = [
    `  ${formatStrong(store.id, colors)}`,
    `    kind: ${store.kind === "playerStore" ? "player store (session locked)" : "store"}`,
    `    source: ${store.source}`,
    `    version: ${store.version}${store.hasMigrate ? " (migrate declared)" : ""}`,
  ];

  if (store.scope !== undefined) {
    lines.push(`    scope: ${store.scope}`);
  }
  lines.push(`    schema: ${store.schema}`);

  return lines;
}

export function formatStoreInspection(output: CompilerOutput, colors: CliColorMode): string {
  const report = buildStoreInspectionReport(output);
  const lines: string[] = [
    formatBrandTitle("aruna inspect stores", colors),
    "",
    `  ${report.stores.length} ${report.stores.length === 1 ? "store" : "stores"} discovered`,
    "",
  ];

  for (const store of report.stores) {
    lines.push(...renderStoreBlock(store, colors));
    lines.push("");
  }

  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  lines.push("");
  lines.push("Use --json for machine-readable output.");

  return lines.join("\n");
}
