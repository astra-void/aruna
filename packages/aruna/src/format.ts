import pc from "picocolors";
import type { ArunaCompilerOutput, ArunaDiagnostic, ArunaDiagnosticSeverity } from "@arunajs/core";
import { ARUNA_CLI_DEFAULT_PALETTE, brandText } from "./theme.js";

export type CliColorMode = {
  enabled: boolean;
};

type HumanFormatOptions = {
  colors: CliColorMode;
  durationMs?: number;
  includeDuration?: boolean;
};

function commandTitle(command: string, colors: CliColorMode): string {
  return brandText(ARUNA_CLI_DEFAULT_PALETTE, `aruna ${command}`, colors.enabled);
}

function sectionTitle(title: string, colors: CliColorMode): string {
  return brandText("minimalCyan", title, colors.enabled);
}

function statusLabel(severity: ArunaDiagnosticSeverity, colors: CliColorMode): string {
  if (!colors.enabled) {
    return severity;
  }

  switch (severity) {
    case "error":
      return pc.red(severity);
    case "warning":
      return pc.yellow(severity);
    case "info":
      return pc.cyan(severity);
  }
}

function summaryLine(count: number, noun: string, suffix: string, colors: CliColorMode): string {
  const prefix = colors.enabled ? pc.green("✓") : "✓";
  return `  ${prefix} ${count} ${count === 1 ? noun : `${noun}s`} ${suffix}`;
}

export function formatDurationLine(durationMs?: number): string {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
    return "";
  }

  return `  done in ${Math.max(0, Math.round(durationMs))}ms`;
}

function formatGroupTitle(label: string, colors: CliColorMode): string {
  return colors.enabled ? pc.bold(label) : label;
}

export function formatSummary(output: ArunaCompilerOutput, command: string, options: HumanFormatOptions): string {
  const lines: string[] = [commandTitle(command, options.colors), ""];

  if (output.summary.errors === 0 && output.summary.warnings === 0) {
    lines.push(summaryLine(output.summary.modules, "module", "analyzed", options.colors));
    lines.push(summaryLine(output.summary.resolvedImports, "import", "resolved", options.colors));
    lines.push(`  ${options.colors.enabled ? pc.green("✓") : "✓"} no boundary errors found`);
  } else {
    lines.push(`  ${output.summary.modules} ${output.summary.modules === 1 ? "module" : "modules"} analyzed`);
    lines.push(`  ${output.summary.resolvedImports} ${output.summary.resolvedImports === 1 ? "import" : "imports"} resolved`);
    lines.push(`  ${output.summary.errors} ${output.summary.errors === 1 ? "error" : "errors"} found`);
    if (output.summary.warnings > 0) {
      lines.push(`  ${output.summary.warnings} ${output.summary.warnings === 1 ? "warning" : "warnings"} found`);
    }
  }

  const durationLine = options.includeDuration === false ? "" : formatDurationLine(options.durationMs);
  if (durationLine) {
    lines.push("");
    lines.push(durationLine);
  }

  return lines.join("\n");
}

function renderDiagnosticBlock(diagnostic: ArunaDiagnostic, colors: CliColorMode): string[] {
  const lines: string[] = [`${statusLabel(diagnostic.severity, colors)} ${diagnostic.code} ${diagnostic.name}`, ""];

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

  if (diagnostic.docsUrl) {
    lines.push("");
    lines.push("  docs");
    lines.push(`  ${diagnostic.docsUrl}`);
  }

  return lines;
}

export function formatDiagnostics(output: ArunaCompilerOutput, colors: CliColorMode): string {
  if (output.diagnostics.length === 0) {
    return "";
  }

  const lines: string[] = [""];
  output.diagnostics.forEach((diagnostic, index) => {
    lines.push(...renderDiagnosticBlock(diagnostic, colors));
    if (index < output.diagnostics.length - 1) {
      lines.push("");
    }
  });

  return lines.join("\n");
}

export function formatModuleInspection(
  output: ArunaCompilerOutput,
  colors: CliColorMode,
  verbose = false,
): string {
  const groups: Record<ArunaCompilerOutput["manifest"]["modules"][number]["kind"], string[]> = {
    client: [],
    server: [],
    shared: [],
    unknown: [],
  };

  for (const module of output.manifest.modules) {
    groups[module.kind].push(module.path);
  }

  const lines: string[] = [commandTitle("inspect modules", colors), "", sectionTitle("module classification", colors), ""];
  for (const kind of ["client", "server", "shared", "unknown"] as const) {
    const files = groups[kind];
    if (files.length === 0 && !verbose) {
      continue;
    }

    lines.push(formatGroupTitle(kind, colors));
    if (files.length === 0) {
      lines.push("  (none)");
    } else {
      for (const file of files) {
        lines.push(`  ${file}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function diagnosticForGraphEdge(output: ArunaCompilerOutput, from: string, to?: string): ArunaDiagnostic | undefined {
  return output.diagnostics.find((diagnostic) => {
    if (diagnostic.file !== from) {
      return false;
    }

    if (!to) {
      return diagnostic.code === "aruna::105";
    }

    return diagnostic.details?.includes(`imported: ${to}`) ?? false;
  });
}

function graphStatusLabel(diagnostic: ArunaDiagnostic | undefined, resolved: boolean, colors: CliColorMode): string {
  if (!diagnostic) {
    return resolved ? (colors.enabled ? pc.green("ok") : "ok") : colors.enabled ? pc.yellow("warning") : "warning";
  }

  const label = diagnostic.severity === "error" ? "error" : diagnostic.severity === "warning" ? "warning" : "ok";
  if (!colors.enabled) {
    return label;
  }

  switch (label) {
    case "error":
      return pc.red(label);
    case "warning":
      return pc.yellow(label);
    default:
      return pc.green(label);
  }
}

export function formatGraphInspection(output: ArunaCompilerOutput, colors: CliColorMode): string {
  const moduleByPath = new Map(output.manifest.modules.map((module) => [module.path, module] as const));
  const lines: string[] = [commandTitle("inspect graph", colors), "", sectionTitle("import graph", colors), ""];

  for (const module of output.manifest.modules) {
    lines.push(formatGroupTitle(`${module.path} [${module.kind}]`, colors));
    const edges = output.manifest.imports.filter((edge) => edge.from === module.path);
    if (edges.length === 0) {
      lines.push("");
      continue;
    }

    for (const edge of edges) {
      const imported = edge.to ? moduleByPath.get(edge.to) : undefined;
      const diagnostic = diagnosticForGraphEdge(output, edge.from, edge.to);
      const status = graphStatusLabel(diagnostic, edge.resolved, colors);
      const statusCode = diagnostic ? ` ${diagnostic.code}` : "";
      const targetLabel = edge.to ? `${edge.to} [${imported?.kind ?? "unknown"}]` : edge.specifier;
      lines.push(`  -> ${targetLabel} ${status}${statusCode}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
