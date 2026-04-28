#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import type { ArunaCompilerOutput } from "@arunajs/core";
import { checkProject, inspectProject } from "@arunajs/compiler";
import { formatDiagnostics, formatGraphInspection, formatModuleInspection, formatSummary, type CliColorMode } from "./format.js";

type CliOptions = {
  project?: string;
  config?: string;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  noColor?: boolean;
  warningsAsErrors?: boolean;
};

function colorMode(options: CliOptions): CliColorMode {
  const disabled =
    options.noColor ||
    process.env["NO_COLOR"] !== undefined ||
    process.env["CI"] === "true" ||
    !process.stdout.isTTY ||
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

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeText(output: string): void {
  process.stdout.write(`${output}\n`);
}

function renderCompilerOutput(command: string, output: ArunaCompilerOutput, options: CliOptions): void {
  const colors = colorMode(options);
  if (options.json) {
    writeJson(output);
    return;
  }

  writeText(formatSummary(output, command, colors));
  if (!options.quiet) {
    const diagnostics = formatDiagnostics(output, colors);
    if (diagnostics.length > 0) {
      writeText(diagnostics);
    }
  }
  if (options.verbose && output.manifestPath) {
    writeText("");
    writeText(`  manifest written to ${output.manifestPath}`);
  }
}

async function main(): Promise<number> {
  const program = new Command();
  program
    .name("aruna")
    .description("Aruna compiler and boundary checker")
    .option("--project <path>", "project root")
    .option("--config <path>", "config file path")
    .option("--json", "emit JSON")
    .option("--quiet", "reduce human-readable output")
    .option("--verbose", "show additional output")
    .option("--no-color", "disable color output")
    .option("--warnings-as-errors", "treat warnings as errors");

  program.action(async () => {
    const options = program.optsWithGlobals<CliOptions>();
    const output = await checkProject(compilerInput(options));
    renderCompilerOutput("check", output, options);
    process.exitCode = output.ok ? 0 : 1;
  });

  const inspect = program.command("inspect").description("inspect the project");
  inspect.action(async () => {
    const options = program.optsWithGlobals<CliOptions>();
    const output = await inspectProject(compilerInput(options));
    if (options.json) {
      writeJson(output);
      process.exitCode = output.ok ? 0 : 1;
      return;
    }
    renderCompilerOutput("inspect", output, options);
    process.exitCode = output.ok ? 0 : 1;
  });

  inspect
    .command("modules")
    .description("print module classification")
    .action(async () => {
      const options = program.optsWithGlobals<CliOptions>();
      const output = await inspectProject(compilerInput(options));
      if (options.json) {
        writeJson({
          modules: output.manifest.modules,
          diagnostics: output.diagnostics,
          summary: output.summary,
        });
        process.exitCode = output.ok ? 0 : 1;
        return;
      }
      writeText(formatModuleInspection(output, colorMode(options)));
      process.exitCode = output.ok ? 0 : 1;
    });

  inspect
    .command("graph")
    .description("print import graph")
    .action(async () => {
      const options = program.optsWithGlobals<CliOptions>();
      const output = await inspectProject(compilerInput(options));
      if (options.json) {
        writeJson({
          imports: output.manifest.imports,
          diagnostics: output.diagnostics,
          summary: output.summary,
        });
        process.exitCode = output.ok ? 0 : 1;
        return;
      }
      writeText(formatGraphInspection(output, colorMode(options)));
      process.exitCode = output.ok ? 0 : 1;
    });

  program
    .command("check")
    .description("check the project")
    .action(async () => {
      const options = program.optsWithGlobals<CliOptions>();
      const output = await checkProject(compilerInput(options));
      renderCompilerOutput("check", output, options);
      process.exitCode = output.ok ? 0 : 1;
  });

  await program.parseAsync(process.argv);
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${pc.red(message)}\n`);
  process.exitCode = 3;
});
