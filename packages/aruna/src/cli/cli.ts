#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { ArunaCompilerOutput } from "@arunajs/core";
import { buildProject, checkProject, inspectProject } from "@arunajs/compiler";
import {
  formatDiagnostics,
  formatDurationLine,
  formatBuildSummary,
  formatGraphInspection,
  formatModuleInspection,
  formatSummary,
  type CliColorMode,
} from "./format.js";
import { doctorExitCode, formatDoctorReport, runDoctor } from "./doctor.js";
import { buildActionInspectionReport, formatActionInspection } from "./inspect-actions.js";
import { buildActionContractSnapshot } from "./action-contracts.js";
import { formatActionContractInspection } from "./inspect-contract.js";
import { runContractDiffCommand } from "./contract-diff.js";
import { formatError, formatMuted } from "./theme.js";

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

type DoctorCliOptions = CliOptions & {
  fix?: boolean;
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

function renderCompilerOutput(
  output: ArunaCompilerOutput,
  options: CliOptions,
  durationMs: number,
  command: "check" | "inspect" | "build",
): void {
  const colors = resolveColorMode(options);
  if (options.json) {
    writeJson(output);
    return;
  }

  const hasDiagnostics = output.diagnostics.length > 0;
  if (
    command === "build" &&
    output.ok &&
    output.generatedFiles &&
    output.generatedFiles.length > 0
  ) {
    writeText(formatBuildSummary(output, colors));
  } else {
    writeText(
      formatSummary(output, command, { colors, durationMs, includeDuration: !hasDiagnostics }),
    );
  }
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
      writeText(formatMuted(duration, colors));
    }
  }
}

async function runCheck(options: CliOptions): Promise<ArunaCompilerOutput> {
  return checkProject(compilerInput(options));
}

async function runInspect(options: CliOptions): Promise<ArunaCompilerOutput> {
  return inspectProject(compilerInput(options));
}

type BuildCliOptions = CliOptions & {
  emitRuntime?: boolean;
};

// Resolves the roblox-ts-native runtime source shipped in the aruna package
// ("roblox/" at the package root, shipped via package "files"). The compiled
// CLI may live at dist/cli/cli.js or dist/cli.js, so candidate depths are tried.
async function findRobloxRuntimeSourceDir(): Promise<string | undefined> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../roblox"),
    path.resolve(here, "../roblox"),
    path.resolve(here, "roblox"),
  ];
  for (const candidate of candidates) {
    const entries = await fs.readdir(candidate).catch(() => undefined);
    if (entries && entries.some((name) => name.endsWith(".ts"))) {
      return candidate;
    }
  }
  return undefined;
}

function generatedDirFromOutput(output: ArunaCompilerOutput): string {
  const first = output.generatedFiles?.[0]?.path;
  return first ? path.posix.dirname(first) : "src/.aruna";
}

// Vendors the Roblox-targeted runtime into the project's generated dir so a
// consumer compiles it as project source (avoids roblox-ts's "modules directly
// under node_modules" rule). Distinct from the Node reference runtime.
async function emitRobloxRuntime(root: string, generatedDir: string): Promise<void> {
  const sourceDir = await findRobloxRuntimeSourceDir();
  if (sourceDir === undefined) {
    return;
  }
  const entries = await fs.readdir(sourceDir);
  const runtimeFiles = entries.filter((name) => name.endsWith(".ts"));
  if (runtimeFiles.length === 0) {
    return;
  }

  const targetDir = path.join(root, generatedDir, "runtime");
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });
  for (const name of runtimeFiles) {
    await fs.copyFile(path.join(sourceDir, name), path.join(targetDir, name));
  }
}

async function runBuild(options: BuildCliOptions): Promise<ArunaCompilerOutput> {
  const input = compilerInput(options);
  const output = await buildProject(input);
  if (options.emitRuntime && output.ok) {
    await emitRobloxRuntime(input.root, generatedDirFromOutput(output));
  }
  return output;
}

async function runDoctorCli(options: DoctorCliOptions): Promise<void> {
  try {
    const compilerOptions = compilerInput(options);
    const report = runDoctor({
      projectRoot: compilerOptions.root,
      configPath: compilerOptions.configPath,
      fix: options.fix,
    });

    if (options.json) {
      writeJson(report);
      process.exitCode = doctorExitCode(report);
      return;
    }

    writeText(formatDoctorReport(report));
    process.exitCode = doctorExitCode(report);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${formatError(message, resolveColorMode(options))}\n`);
    process.exitCode = 1;
  }
}

export async function main(): Promise<number> {
  const program = new Command();
  program
    .name("aruna")
    .description(
      "Aruna compiler and boundary checker. Running `aruna` without a subcommand aliases to `aruna check`.",
    )
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
    renderCompilerOutput(output, options, Date.now() - startedAt, "check");
    process.exitCode = output.ok ? 0 : 1;
  });

  const inspect = program.command("inspect").description("inspect the project");
  inspect.action(async () => {
    const options = program.optsWithGlobals<CliOptions>();
    const startedAt = Date.now();
    const output = await runInspect(options);
    renderCompilerOutput(output, options, Date.now() - startedAt, "inspect");
    process.exitCode = output.ok ? 0 : 1;
  });

  inspect
    .command("actions")
    .description("show discovered actions and contract metadata")
    .action(async () => {
      const options = program.optsWithGlobals<CliOptions>();
      const output = await runInspect(options);
      if (options.json) {
        const report = buildActionInspectionReport(output);
        writeJson(report);
        process.exitCode = output.ok ? 0 : 1;
        return;
      }

      const colors = resolveColorMode(options);
      writeText(formatActionInspection(output, colors));
      if (!options.quiet && output.diagnostics.length > 0) {
        const diagnostics = formatDiagnostics(output, colors);
        if (diagnostics.length > 0) {
          writeText(diagnostics);
        }
      }
      process.exitCode = output.ok ? 0 : 1;
    });

  inspect
    .command("contract")
    .alias("contracts")
    .description("print a deterministic action contract snapshot")
    .action(async () => {
      const options = program.optsWithGlobals<CliOptions>();
      const output = await runInspect(options);
      if (options.json) {
        writeJson(buildActionContractSnapshot(output));
        process.exitCode = output.ok ? 0 : 1;
        return;
      }

      const colors = resolveColorMode(options);
      writeText(formatActionContractInspection(output, colors));
      if (!options.quiet && output.diagnostics.length > 0) {
        const diagnostics = formatDiagnostics(output, colors);
        if (diagnostics.length > 0) {
          writeText(diagnostics);
        }
      }
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
      writeText(
        formatModuleInspection(output, resolveColorMode(options), Boolean(options.verbose)),
      );
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
      renderCompilerOutput(output, options, Date.now() - startedAt, "check");
      process.exitCode = output.ok ? 0 : 1;
    });

  const build = program
    .command("build")
    .description("build generated action files and the manifest")
    .option(
      "--emit-runtime",
      "vendor the Roblox-targeted runtime into the generated dir as project source",
    );

  build.action(async () => {
    const options = build.optsWithGlobals<BuildCliOptions>();
    const startedAt = Date.now();
    const output = await runBuild(options);
    renderCompilerOutput(output, options, Date.now() - startedAt, "build");
    process.exitCode = output.ok ? 0 : 1;
  });

  const doctor = program
    .command("doctor")
    .description("inspect and optionally fix generated action aliases in tsconfig.json")
    .option("--fix", "write the required tsconfig path aliases");

  doctor.action(async () => {
    const options = doctor.optsWithGlobals<DoctorCliOptions>();
    await runDoctorCli(options);
  });

  const contract = program.command("contract").description("compare action contract snapshots");
  const contractDiff = contract
    .command("diff")
    .description("compare action contract snapshots")
    .option("--baseline <path>", "baseline snapshot path")
    .option("--from <path>", "source snapshot path")
    .option("--to <path>", "target snapshot path")
    .action(async () => {
      const options = contractDiff.optsWithGlobals<CliOptions>() as CliOptions & {
        readonly baseline?: string;
        readonly from?: string;
        readonly to?: string;
      };

      const result = await runContractDiffCommand({
        ...options,
        resolveColorMode: (input) =>
          resolveColorMode(input, process.env, Boolean(process.stdout.isTTY)),
        inspectProject: async () => inspectProject(compilerInput(options)),
      });

      if (result.stdout) {
        process.stdout.write(result.stdout);
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
      process.exitCode = result.status;
    });

  await program.parseAsync(process.argv);
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}
