import pc from "picocolors";
import gradient from "gradient-string";
import type { ArunaCompilerOutput, ArunaDiagnostic } from "@arunajs/core";

export type CliColorMode = {
  enabled: boolean;
};

function commandTitle(command: string, colors: CliColorMode): string {
  if (!colors.enabled) {
    return `aruna ${command}`;
  }

  return gradient(["#f59e0b", "#22c55e", "#38bdf8"])(`aruna ${command}`);
}

export function formatSummary(output: ArunaCompilerOutput, command: string, colors: CliColorMode): string {
  const c = pc.createColors(colors.enabled);
  const lines: string[] = [commandTitle(command, colors), ""];
  const modulesLabel = output.summary.modules === 1 ? "module analyzed" : "modules analyzed";
  const importsLabel = output.summary.imports === 1 ? "import resolved" : "imports resolved";
  const errorsLabel = output.summary.errors === 1 ? "error found" : "errors found";
  const warningsLabel = output.summary.warnings === 1 ? "warning found" : "warnings found";

  if (output.summary.errors === 0 && output.summary.warnings === 0) {
    lines.push(`  ${c.green("✓")} ${output.summary.modules} ${modulesLabel}`);
    lines.push(`  ${c.green("✓")} ${output.summary.imports} ${importsLabel}`);
    lines.push(`  ${c.green("✓")} no boundary errors found`);
  } else {
    lines.push(`  ${output.summary.modules} ${modulesLabel}`);
    lines.push(`  ${output.summary.imports} ${importsLabel}`);
    lines.push(`  ${output.summary.errors} ${errorsLabel}`);
    if (output.summary.warnings > 0) {
      lines.push(`  ${output.summary.warnings} ${warningsLabel}`);
    }
  }

  return lines.join("\n");
}

function severityLabel(diagnostic: ArunaDiagnostic): string {
  return diagnostic.severity;
}

export function formatDiagnostics(output: ArunaCompilerOutput, colors: CliColorMode): string {
  if (output.diagnostics.length === 0) {
    return "";
  }

  const c = pc.createColors(colors.enabled);
  const lines: string[] = [""];
  for (const diagnostic of output.diagnostics) {
    const heading = `${severityLabel(diagnostic)} ${diagnostic.code} ${diagnostic.name}`;
    lines.push(colors.enabled ? c.bold(heading) : heading);
    lines.push("");
    if (diagnostic.file) {
      lines.push(`  ${diagnostic.file}`);
    }
    lines.push(`  ${diagnostic.message}`);
    if (diagnostic.details) {
      lines.push("");
      lines.push("  details");
      for (const detailLine of diagnostic.details.split("\n")) {
        lines.push(`  ${detailLine}`);
      }
    }
    if (diagnostic.suggestion) {
      lines.push("");
      lines.push("  suggested fix");
      lines.push(`  ${diagnostic.suggestion}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function formatModuleInspection(output: ArunaCompilerOutput, colors: CliColorMode): string {
  const c = pc.createColors(colors.enabled);
  const groups: Record<ArunaCompilerOutput["manifest"]["modules"][number]["kind"], string[]> = {
    client: [],
    server: [],
    shared: [],
    unknown: [],
  };

  for (const module of output.manifest.modules) {
    groups[module.kind].push(module.path);
  }

  const lines: string[] = ["module classification", ""];
  for (const kind of ["client", "server", "shared", "unknown"] as const) {
    lines.push(colors.enabled ? c.bold(kind) : kind);
    for (const file of groups[kind]) {
      lines.push(`  ${file}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function formatGraphInspection(output: ArunaCompilerOutput, colors: CliColorMode): string {
  const c = pc.createColors(colors.enabled);
  const moduleByPath = new Map(output.manifest.modules.map((module) => [module.path, module] as const));
  const diagnosticForEdge = (from: string, to: string | undefined): ArunaDiagnostic | undefined => {
    return output.diagnostics.find((diagnostic) => {
      if (diagnostic.file !== from) {
        return false;
      }
      if (to && diagnostic.details?.includes(`imported: ${to}`)) {
        return true;
      }
      if (!to && diagnostic.code === "aruna::105") {
        return true;
      }
      return false;
    });
  };

  const lines: string[] = ["import graph", ""];
  for (const module of output.manifest.modules) {
    lines.push(colors.enabled ? c.bold(`${module.path} [${module.kind}]`) : `${module.path} [${module.kind}]`);
    const edges = output.manifest.imports.filter((edge) => edge.from === module.path);
    if (edges.length === 0) {
      lines.push("");
      continue;
    }

    for (const edge of edges) {
      const imported = edge.to ? moduleByPath.get(edge.to) : undefined;
      const diagnostic = diagnosticForEdge(edge.from, edge.to);
      const status = diagnostic ? `error ${diagnostic.code}` : edge.resolved ? "ok" : "unresolved";
      const targetLabel = edge.to ? `${edge.to} [${imported?.kind ?? "unknown"}]` : edge.specifier;
      lines.push(`  -> ${targetLabel} ${status}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
