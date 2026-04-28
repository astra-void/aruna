#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import pc from "picocolors";
import type { ArunaCompilerOutput } from "@arunajs/core";
import { checkProject, inspectProject } from "@arunajs/compiler";
import {
  formatDiagnostics,
  formatDurationLine,
  formatGraphInspection,
  formatModuleInspection,
  formatSummary,
  type CliColorMode,
} from "./format.js";

type CliOptions = {
  project?: string;
  config?: string;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  noColor?: boolean;
  color?: boolean;
  warningsAsErrors?: boolean;
};

function isCI(env: NodeJS.ProcessEnv): boolean {
  return env["CI"] !== undefined;
}

export function resolveColorMode(
  options: Pick<CliOptions, "json" | "noColor" | "color">,
  env: NodeJS.ProcessEnv = process.env,
  isTTY = Boolean(process.stdout.isTTY),
): CliColorMode {
  const disabled =
    options.noColor === true ||
    options.color === false ||
    env["NO_COLOR"] !== undefined ||
    isCI(env) ||
    !isTTY ||
    Boolean(options.json);
  return { enabled: !disabled };
}

function workspaceCwd(): string {
  return process.env["INIT_CWD"] ?? process.cwd();
}

function compilerInput(options: CliOptions) {
  const baseCwd = workspaceCwd();
  return {
    root: options.project ? path.resolve(baseCwd, options.project) : path.resolve(baseCwd),
    configPath: options.config ? path.resolve(baseCwd, options.config) : undefined,
    warningsAsErrors: options.warningsAsErrors,
    json: options.json,
    quiet: options.quiet,
    verbose: options.verbose,
  };
}

export function serializeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${serializeJson(value)}\n`);
}

function writeText(output: string): void {
  process.stdout.write(`${output}\n`);
}

function renderCheckOutput(output: ArunaCompilerOutput, options: CliOptions, durationMs: number): void {
  const colors = resolveColorMode(options);
  if (options.json) {
    writeJson(output);
    return;
  }

  const hasDiagnostics = output.diagnostics.length > 0;
  writeText(formatSummary(output, "check", { colors, durationMs, includeDuration: !hasDiagnostics }));
  if (!options.quiet && hasDiagnostics) {
    const diagnostics = formatDiagnostics(output, colors);
    if (diagnostics.length > 0) {
      writeText(diagnostics);
    }
  }
  if (hasDiagnostics) {
    const duration = formatDurationLine(durationMs);
    if (duration) {
      writeText("");
      writeText(duration);
    }
  }
}

function renderInspectOutput(output: ArunaCompilerOutput, options: CliOptions, durationMs: number): void {
  const colors = resolveColorMode(options);
  if (options.json) {
    writeJson(output);
    return;
  }

  const hasDiagnostics = output.diagnostics.length > 0;
  writeText(formatSummary(output, "inspect", { colors, durationMs, includeDuration: !hasDiagnostics }));
  if (!options.quiet && hasDiagnostics) {
    const diagnostics = formatDiagnostics(output, colors);
    if (diagnostics.length > 0) {
      writeText(diagnostics);
    }
  }
  if (hasDiagnostics) {
    const duration = formatDurationLine(durationMs);
    if (duration) {
      writeText("");
      writeText(duration);
    }
  }
}

async function runCheck(options: CliOptions): Promise<ArunaCompilerOutput> {
  return checkProject(compilerInput(options));
}

async function runInspect(options: CliOptions): Promise<ArunaCompilerOutput> {
  return inspectProject(compilerInput(options));
}

export async function main(): Promise<number> {
  const program = new Command();
  program
    .name("aruna")
    .description("Aruna compiler and boundary checker. Running `aruna` without a subcommand aliases to `aruna check`.")
    .option("--project <path>", "project root")
    .option("--config <path>", "config file path")
    .option("--json", "emit JSON")
    .option("--quiet", "reduce human-readable output")
    .option("--verbose", "show additional output")
    .option("--no-color", "disable color output")
    .option("--warnings-as-errors", "treat warnings as errors");

  program.action(async () => {
    const options = program.optsWithGlobals<CliOptions>();
    const startedAt = Date.now();
    const output = await runCheck(options);
    renderCheckOutput(output, options, Date.now() - startedAt);
    process.exitCode = output.ok ? 0 : 1;
  });

  const inspect = program.command("inspect").description("inspect the project");
  inspect.action(async () => {
    const options = program.optsWithGlobals<CliOptions>();
    const startedAt = Date.now();
    const output = await runInspect(options);
    renderInspectOutput(output, options, Date.now() - startedAt);
    process.exitCode = output.ok ? 0 : 1;
  });

  inspect
    .command("modules")
    .description("print module classification")
    .action(async () => {
      const options = program.optsWithGlobals<CliOptions>();
      const output = await runInspect(options);
      if (options.json) {
        writeJson({
          modules: output.manifest.modules,
          diagnostics: output.diagnostics,
          summary: output.summary,
        });
        process.exitCode = output.ok ? 0 : 1;
        return;
      }
      writeText(formatModuleInspection(output, resolveColorMode(options), Boolean(options.verbose)));
      process.exitCode = output.ok ? 0 : 1;
    });

  inspect
    .command("graph")
    .description("print import graph")
    .action(async () => {
      const options = program.optsWithGlobals<CliOptions>();
      const output = await runInspect(options);
      if (options.json) {
        writeJson({
          imports: output.manifest.imports,
          diagnostics: output.diagnostics,
          summary: output.summary,
        });
        process.exitCode = output.ok ? 0 : 1;
        return;
      }
      writeText(formatGraphInspection(output, resolveColorMode(options)));
      process.exitCode = output.ok ? 0 : 1;
    });

  program
    .command("check")
    .description("check the project")
    .action(async () => {
      const options = program.optsWithGlobals<CliOptions>();
      const startedAt = Date.now();
      const output = await runCheck(options);
      renderCheckOutput(output, options, Date.now() - startedAt);
      process.exitCode = output.ok ? 0 : 1;
    });

  await program.parseAsync(process.argv);
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

const isDirectExecution = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${pc.red(message)}\n`);
    process.exitCode = 3;
  });
}
