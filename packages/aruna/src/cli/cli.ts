#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { CompilerOutput } from "@arunajs/core";
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
import { formatInitReport, runInit } from "./init.js";
import { buildActionInspectionReport, formatActionInspection } from "./inspect-actions.js";
import { buildSignalInspectionReport, formatSignalInspection } from "./inspect-signals.js";
import { buildActionContractSnapshot } from "./action-contracts.js";
import { formatActionContractInspection } from "./inspect-contract.js";
import { runContractDiffCommand } from "./contract-diff.js";
import { findRbxtscBin, runRbxtsc, rbxtscOk, type RbxtscResult } from "./rbxtsc.js";
import { runPartitionedRbxtsc } from "./rojo-layout.js";
import { formatError, formatMuted, formatSuccess } from "./theme.js";

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
  emitRuntime?: boolean;
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

// Where a relative `--project`/`--config` is anchored. Prefer INIT_CWD (the dir
// the user actually ran pnpm/npm from) so `pnpm --filter aruna aruna <cmd>
// --project .` resolves against the consumer rather than the aruna package whose
// script cwd the nested invocation adopts.
function invocationCwd(): string {
  return process.env["INIT_CWD"] ?? process.cwd();
}

function compilerInput(options: CliOptions) {
  const baseCwd = invocationCwd();
  return {
    // With no explicit --project the bin runs inside the target project (a
    // package script's cwd is the package dir), so use cwd() directly — not
    // INIT_CWD, which points at wherever pnpm was launched. This makes a bare
    // `aruna build` (e.g. a harness `"build": "aruna build"`) target itself.
    root: options.project ? path.resolve(baseCwd, options.project) : process.cwd(),
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
  output: CompilerOutput,
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

async function runCheck(options: CliOptions): Promise<CompilerOutput> {
  return checkProject(compilerInput(options));
}

async function runInspect(options: CliOptions): Promise<CompilerOutput> {
  return inspectProject(compilerInput(options));
}

type BuildCliOptions = CliOptions & {
  // Runtime vendoring and the rbxtsc compile are both on by default so a bare
  // `aruna build` is turnkey (stubs + vendored Roblox runtime + Luau). The flags
  // are opt-outs (`--no-emit-runtime` / `--no-emit-luau`); the legacy
  // `--emit-runtime` is still accepted as a redundant explicit-on. Commander
  // leaves these undefined by default, so callers gate on `!== false`.
  emitRuntime?: boolean;
  emitLuau?: boolean;
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

// The base generatedDir, recovered from the build output. Generated TS files now
// live in `<base>/server/` and `<base>/shared/` subtrees (split-tree layout), but
// the manifest JSON is written flat at the base — so its dirname is the base.
// Falls back to stripping the one subtree segment off a generated TS file, then
// to the default.
function generatedDirFromOutput(output: CompilerOutput): string {
  const files = output.generatedFiles ?? [];
  const manifest = files.find((file) => file.path.endsWith(".json"));
  if (manifest) {
    return path.posix.dirname(manifest.path);
  }
  const firstTs = files[0]?.path;
  if (firstTs) {
    // <base>/shared/actions.client.generated.ts -> <base>
    return path.posix.dirname(path.posix.dirname(firstTs));
  }
  return "src/.aruna";
}

// Public entry modules of the native runtime. Vendoring a source tree that is
// missing any of these (or any module they transitively import) yields a runtime
// that fails to compile under rbxtsc — the exact failure mode that bit
// draw-a-tower when a concurrent `git stash` briefly emptied the signal modules
// out of the live source tree. These anchor the integrity check below.
const ROBLOX_RUNTIME_ANCHOR_MODULES = [
  "server",
  "client",
  "roblox",
  "schema",
  "signal",
  "signal-runtime",
] as const;

// Pulls every relative module specifier (`./x`, with or without a `.ts`
// extension) out of a runtime source file, regardless of whether it appears in
// an `import`, `import type`, side-effect `import`, or `export ... from`.
export function relativeImportsOf(source: string): string[] {
  const names: string[] = [];
  const pattern = /["']\.\/([\w.-]+?)(?:\.ts)?["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1];
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

// Verifies the vendoring source is a *complete* runtime before anything is
// copied: all anchor entry modules must be present, and every relative import
// reachable from them must resolve to a file in the source set. A partial or
// torn source (empty dir, missing signal modules, an interrupted checkout) is
// rejected loudly rather than silently vendored into the consumer. Returns the
// validated set of runtime file names to copy.
export async function validateRobloxRuntimeSource(sourceDir: string): Promise<string[]> {
  const entries = await fs.readdir(sourceDir);
  const runtimeFiles = entries.filter((name) => name.endsWith(".ts"));
  const present = new Set(runtimeFiles.map((name) => name.slice(0, -".ts".length)));

  const missingAnchors = ROBLOX_RUNTIME_ANCHOR_MODULES.filter((name) => !present.has(name));
  if (missingAnchors.length > 0) {
    throw new Error(
      `Aruna runtime source at ${sourceDir} is incomplete: missing required ` +
        `module(s) ${missingAnchors.map((name) => `${name}.ts`).join(", ")}. ` +
        `Refusing to vendor a partial runtime. If the aruna package was mid-build ` +
        `or mid-checkout, rebuild it (\`pnpm build\`) and retry.`,
    );
  }

  // Walk the relative-import graph from the anchors and flag any specifier that
  // points at a module not present in the source set.
  const dangling = new Map<string, Set<string>>();
  const visited = new Set<string>();
  const queue: string[] = [...ROBLOX_RUNTIME_ANCHOR_MODULES];
  while (queue.length > 0) {
    const moduleName = queue.shift() as string;
    if (visited.has(moduleName) || !present.has(moduleName)) {
      continue;
    }
    visited.add(moduleName);
    const source = await fs.readFile(path.join(sourceDir, `${moduleName}.ts`), "utf8");
    for (const referenced of relativeImportsOf(source)) {
      if (present.has(referenced)) {
        queue.push(referenced);
      } else {
        const referrers = dangling.get(referenced) ?? new Set<string>();
        referrers.add(moduleName);
        dangling.set(referenced, referrers);
      }
    }
  }

  if (dangling.size > 0) {
    const detail = [...dangling.entries()]
      .map(([name, referrers]) => `${name}.ts (imported by ${[...referrers].sort().join(", ")})`)
      .sort()
      .join("; ");
    throw new Error(
      `Aruna runtime source at ${sourceDir} is incomplete: dangling import(s) ${detail}. ` +
        `Refusing to vendor a partial runtime. Rebuild the aruna package and retry.`,
    );
  }

  return runtimeFiles;
}

// Vendors the Roblox-targeted runtime into the project's generated dir so a
// consumer compiles it as project source (avoids roblox-ts's "modules directly
// under node_modules" rule). Distinct from the Node reference runtime.
//
// The copy is integrity-checked (see validateRobloxRuntimeSource) and atomic:
// files are staged into a sibling temp dir, then the existing runtime is
// replaced in a single rename, so a failure mid-copy can never leave the
// consumer with a half-written runtime.
async function emitRobloxRuntime(root: string, generatedDir: string): Promise<void> {
  const sourceDir = await findRobloxRuntimeSourceDir();
  if (sourceDir === undefined) {
    return;
  }

  const runtimeFiles = await validateRobloxRuntimeSource(sourceDir);

  // Vendor into the shared subtree (replication-safe) to match the split-tree
  // generated layout and the `aruna/<name>` tsconfig path aliases.
  const baseDir = path.join(root, generatedDir, "shared");
  const targetDir = path.join(baseDir, "runtime");
  const stagingDir = path.join(baseDir, ".runtime.tmp");

  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.mkdir(stagingDir, { recursive: true });
  try {
    for (const name of runtimeFiles) {
      await fs.copyFile(path.join(sourceDir, name), path.join(stagingDir, name));
    }
    // Swap last: the live runtime dir is removed only once staging is fully
    // populated, then replaced in a single atomic rename.
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.rename(stagingDir, targetDir);
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}

async function runBuild(options: BuildCliOptions): Promise<CompilerOutput> {
  const input = compilerInput(options);
  const output = await buildProject(input);
  if (options.emitRuntime !== false && output.ok) {
    await emitRobloxRuntime(input.root, generatedDirFromOutput(output));
  }
  return output;
}

// Renders the rbxtsc Luau-compile step that runs after a successful build.
// rbxtsc's own stdout/stderr are forwarded verbatim so its diagnostics survive,
// then a brand-styled status line summarizes the outcome.
function renderRbxtscResult(result: RbxtscResult, options: BuildCliOptions): void {
  const colors = resolveColorMode(options);
  if (result.kind === "skipped") {
    if (!options.quiet) {
      writeText("");
      writeText(formatMuted(`rbxtsc skipped — ${result.reason}`, colors));
    }
    return;
  }

  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
  }
  if (!options.quiet) {
    writeText("");
    writeText(
      result.status === 0
        ? formatSuccess("rbxtsc compiled the project to Luau", colors)
        : formatError(`rbxtsc exited with status ${result.status}`, colors),
    );
  }
}

async function runDoctorCli(options: DoctorCliOptions): Promise<void> {
  try {
    const compilerOptions = compilerInput(options);
    const report = runDoctor({
      projectRoot: compilerOptions.root,
      configPath: compilerOptions.configPath,
      fix: options.fix,
      emitRuntime: options.emitRuntime,
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
    .command("signals")
    .description("show discovered server-to-client signals")
    .action(async () => {
      const options = program.optsWithGlobals<CliOptions>();
      const output = await runInspect(options);
      if (options.json) {
        writeJson(buildSignalInspectionReport(output));
        process.exitCode = output.ok ? 0 : 1;
        return;
      }

      const colors = resolveColorMode(options);
      writeText(formatSignalInspection(output, colors));
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
    .description(
      "generate action stubs and the manifest, vendor the Roblox runtime, then compile to Luau with rbxtsc",
    )
    // Accepted for backward compatibility; vendoring is now the default, so this
    // is a redundant explicit-on. Disable vendoring with --no-emit-runtime.
    .option("--emit-runtime", "vendor the Roblox-targeted runtime (default; kept for compatibility)")
    .option(
      "--no-emit-runtime",
      "skip vendoring the Roblox-targeted runtime into the generated dir",
    )
    .option(
      "--no-emit-luau",
      "skip the rbxtsc Luau compile step (only generate stubs and vendor the runtime)",
    );

  build.action(async () => {
    const options = build.optsWithGlobals<BuildCliOptions>();
    const startedAt = Date.now();
    const output = await runBuild(options);
    const projectRoot = compilerInput(options).root;
    let rbxtsc: RbxtscResult | undefined;
    if (output.ok && options.emitLuau !== false) {
      // Partition the project into client/server/shared so the emitted out/ maps
      // onto the Roblox DataModel (server code stays in ServerScriptService).
      const bin = findRbxtscBin(projectRoot);
      rbxtsc =
        bin === undefined
          ? runRbxtsc({ projectRoot })
          : runPartitionedRbxtsc({
              projectRoot,
              generatedDir: generatedDirFromOutput(output),
              manifest: output.manifest,
              rbxtscBin: bin,
            });
    }

    if (options.json) {
      writeJson(rbxtsc ? { ...output, rbxtsc } : output);
    } else {
      renderCompilerOutput(output, options, Date.now() - startedAt, "build");
      if (rbxtsc) {
        renderRbxtscResult(rbxtsc, options);
      }
    }

    const luauOk = rbxtsc === undefined || rbxtscOk(rbxtsc);
    process.exitCode = output.ok && luauOk ? 0 : 1;
  });

  program
    .command("init")
    .description("scaffold aruna.config.ts, tsconfig.json, and default.project.json")
    .action(async () => {
      const options = program.optsWithGlobals<CliOptions>();
      const result = runInit({ projectRoot: compilerInput(options).root });
      if (options.json) {
        writeJson(result);
      } else {
        writeText(formatInitReport(result));
      }
    });

  const doctor = program
    .command("doctor")
    .description("inspect and optionally fix generated action aliases in tsconfig.json")
    .option("--fix", "write the required tsconfig path aliases")
    .option(
      "--emit-runtime",
      "also alias the Roblox aruna/* subpaths to the vendored runtime (pairs with build --emit-runtime)",
    );

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
