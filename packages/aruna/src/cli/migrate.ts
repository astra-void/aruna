// `aruna migrate`: runs a codemod for one of Aruna's breaking changes over the
// project (docs/codemods.md). The engine is native (crates/aruna_migrate); this
// renders its report.
//
//   aruna migrate --list
//   aruna migrate <name> [--dry-run] [--json]
import { listCodemods, loadProjectConfig, runCodemod, type CodemodReport } from "@arunajs/compiler";
import type { CliColorMode } from "./format.js";
import { formatBrandTitle, formatMuted, formatStrong, formatWarning } from "./theme.js";

export type MigrateCommandOptions = {
  readonly name?: string | undefined;
  readonly list?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
  readonly json?: boolean | undefined;
  readonly root: string;
  readonly configPath?: string | undefined;
  readonly colors: CliColorMode;
};

export type MigrateCommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
};

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function renderList(colors: CliColorMode): string {
  const codemods = listCodemods();
  const lines = [formatBrandTitle("aruna migrate", colors), ""];
  for (const codemod of codemods) {
    lines.push(`  ${formatStrong(codemod.name, colors)}`);
    lines.push(`    ${codemod.description}`);
  }
  lines.push("", formatMuted("Run one with `aruna migrate <name> --dry-run` first.", colors));
  return `${lines.join("\n")}\n`;
}

function renderReport(report: CodemodReport, colors: CliColorMode): string {
  const lines: string[] = [];
  if (report.dryRun) {
    // The diffs themselves are the dry run's output.
    for (const change of report.changed) {
      lines.push(change.diff.replace(/\n$/, ""));
    }
    if (report.changed.length > 0) {
      lines.push("");
    }
  }
  lines.push(formatBrandTitle(`aruna migrate ${report.codemod}`, colors), "");
  const changed = plural(report.changed.length, "file", "files");
  lines.push(
    report.dryRun
      ? `  ${changed} would change (dry run: nothing written), of ${report.filesScanned} scanned`
      : `  ${changed} changed, of ${report.filesScanned} scanned`,
  );
  if (!report.dryRun) {
    for (const change of report.changed) {
      lines.push(`    ${change.file}`);
    }
  }
  if (report.unhandled.length > 0) {
    lines.push("");
    lines.push(
      formatWarning(
        `  ${plural(report.unhandled.length, "site", "sites")} to check by hand:`,
        colors,
      ),
    );
    for (const site of report.unhandled) {
      lines.push(`    ${site.file}:${site.line}:${site.column}  ${site.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function runMigrateCommand(options: MigrateCommandOptions): MigrateCommandResult {
  try {
    if (options.list === true) {
      return {
        stdout: options.json
          ? `${JSON.stringify(listCodemods(), null, 2)}\n`
          : renderList(options.colors),
        stderr: "",
        status: 0,
      };
    }
    if (options.name === undefined) {
      return {
        stdout: "",
        stderr: "aruna migrate: name a codemod, or pass --list to see them.\n",
        status: 1,
      };
    }
    // The generated dir is the compiler's output, never project source.
    const generatedDir = loadProjectConfig(options.root, options.configPath).config.generatedDir;
    const report = runCodemod({
      name: options.name,
      root: options.root,
      excludeDirs: generatedDir.length > 0 ? [generatedDir] : [],
      dryRun: options.dryRun === true,
    });
    return {
      stdout: options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : renderReport(report, options.colors),
      stderr: "",
      status: 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: "", stderr: `aruna migrate: ${message}\n`, status: 1 };
  }
}
