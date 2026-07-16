#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { CompilerOutput, Diagnostic } from "@arunajs/core";
import {
  buildProject,
  checkProject,
  inspectProject,
  loadProjectConfig,
} from "@arunajs/compiler";
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
import {
  ARUNA_TSCONFIG_FRAGMENT_FILE,
  arunaTsconfigFragmentContents,
  GENERATED_RUNTIME_DIR,
} from "./tsconfig-paths.js";
import {
  collectLayoutDesyncDiagnostics,
  reconcileOwnedArtifacts,
} from "./owned-artifacts.js";
import { createRebuildScheduler, shouldRebuildOnChange } from "./watch.js";
import {
  createLinePrefixer,
  resolveRojoServePlan,
  rojoProjectFileExists,
} from "./dev.js";
import { formatError, formatMuted, formatSuccess, formatWarning } from "./theme.js";

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

// Recomputes `ok` and the warning count after appending CLI-side diagnostics, so
// that `--warnings-as-errors` still fails on a desync the compiler never saw.
function withExtraDiagnostics(
  output: CompilerOutput,
  extra: readonly Diagnostic[],
  warningsAsErrors: boolean | undefined,
): CompilerOutput {
  if (extra.length === 0) {
    return output;
  }
  const diagnostics = [...output.diagnostics, ...extra];
  const warnings = extra.filter((diagnostic) => diagnostic.severity === "warning").length;
  const infos = extra.filter((diagnostic) => diagnostic.severity === "info").length;
  const errors = extra.filter((diagnostic) => diagnostic.severity === "error").length;
  const ok = output.ok && errors === 0 && !(warningsAsErrors === true && warnings > 0);
  return {
    ...output,
    ok,
    diagnostics,
    summary: {
      ...output.summary,
      errors: output.summary.errors + errors,
      warnings: output.summary.warnings + warnings,
      infos: output.summary.infos + infos,
    },
  };
}

async function runCheck(options: CliOptions): Promise<CompilerOutput> {
  const input = compilerInput(options);
  const output = await checkProject(input);
  // Surface layout desync (stale artifacts / aliases pointing at an old emit
  // path) that the compiler can't see — its silent pass is the whole bug.
  const desync = await collectLayoutDesyncDiagnostics({
    projectRoot: input.root,
    configPath: input.configPath,
  });
  return withExtraDiagnostics(output, desync, options.warningsAsErrors);
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
  watch?: boolean;
};

// Long enough to coalesce an editor's save burst (format-on-save, multi-file
// save-all) into one rebuild, short enough to feel immediate.
const WATCH_DEBOUNCE_MS = 200;

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
// Returns the vendored runtime file paths relative to generatedDir (posix), or
// undefined when no runtime source is available — so the build can record them in
// the owned-file ledger and prune a previously-vendored runtime that moved.
async function emitRobloxRuntime(
  root: string,
  generatedDir: string,
): Promise<string[] | undefined> {
  const sourceDir = await findRobloxRuntimeSourceDir();
  if (sourceDir === undefined) {
    return undefined;
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

  return runtimeFiles.map((name) => `${GENERATED_RUNTIME_DIR}/${name}`);
}

export type BuildRunResult = {
  readonly output: CompilerOutput;
  // Stale artifacts (generatedDir-relative) pruned during this build.
  readonly pruned: string[];
};

async function runBuild(options: BuildCliOptions): Promise<BuildRunResult> {
  const input = compilerInput(options);
  const output = await buildProject(input);
  if (!output.ok) {
    return { output, pruned: [] };
  }

  const generatedDir = generatedDirFromOutput(output);
  const generatedDirAbs = path.resolve(input.root, generatedDir);

  let runtimeRel: string[] | undefined;
  if (options.emitRuntime !== false) {
    runtimeRel = await emitRobloxRuntime(input.root, generatedDir);
  }

  // Files the compiler wrote, made relative to the generatedDir. Anything that
  // resolves outside it (e.g. a manifest configured elsewhere) is not owned here
  // and is excluded from the ledger.
  const generatedRel: string[] = [];
  for (const file of output.generatedFiles ?? []) {
    const relative = path.posix.relative(generatedDir, file.path);
    if (!relative.startsWith("..") && !path.posix.isAbsolute(relative)) {
      generatedRel.push(relative);
    }
  }

  // The generated tsconfig fragment: alias wiring is codegen-owned, so a
  // layout change can never desync a project whose tsconfig `extends` it.
  await fs.mkdir(generatedDirAbs, { recursive: true });
  await fs.writeFile(
    path.join(generatedDirAbs, ARUNA_TSCONFIG_FRAGMENT_FILE),
    arunaTsconfigFragmentContents(input.root, generatedDir),
    "utf8",
  );
  generatedRel.push(ARUNA_TSCONFIG_FRAGMENT_FILE);

  const { pruned } = await reconcileOwnedArtifacts({
    generatedDirAbs,
    current: { generated: generatedRel, runtime: runtimeRel },
  });

  return { output, pruned };
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

type DevCliOptions = CliOptions & {
  emitRuntime?: boolean;
  emitLuau?: boolean;
  // Commander's --no-rojo negation: undefined means "not overridden on the CLI".
  rojo?: boolean;
  rojoPort?: string;
};

// One full build pass: stub generation + runtime vendoring + rbxtsc, with the
// same rendering as a one-shot `aruna build`. Returns what watch mode needs.
async function executeBuildPass(
  options: BuildCliOptions,
): Promise<{ ok: boolean; generatedDir: string }> {
  const startedAt = Date.now();
  const { output, pruned } = await runBuild(options);
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
    writeJson({ ...output, ...(pruned.length > 0 ? { pruned } : {}), ...(rbxtsc ? { rbxtsc } : {}) });
  } else {
    renderCompilerOutput(output, options, Date.now() - startedAt, "build");
    if (pruned.length > 0 && !options.quiet) {
      const colors = resolveColorMode(options);
      writeText("");
      writeText(
        formatMuted(
          `pruned ${pruned.length} stale generated artifact${pruned.length === 1 ? "" : "s"}: ${pruned.join(", ")}`,
          colors,
        ),
      );
    }
    if (rbxtsc) {
      renderRbxtscResult(rbxtsc, options);
    }
  }

  const luauOk = rbxtsc === undefined || rbxtscOk(rbxtsc);
  return { ok: output.ok && luauOk, generatedDir: generatedDirFromOutput(output) };
}

// The watch loop shared by `aruna build --watch` and `aruna dev`: one full
// build pass, then a filtered fs watcher drives debounced rebuilds until
// SIGINT/SIGTERM. `afterFirstBuild` runs once the first pass has rendered (so
// e.g. a rojo child starts against an existing out/ tree) and may return a
// cleanup invoked on shutdown.
async function runWatchSession(
  options: BuildCliOptions,
  afterFirstBuild?: () => (() => void) | undefined,
): Promise<void> {
  const projectRoot = compilerInput(options).root;
  const colors = resolveColorMode(options);
  const first = await executeBuildPass(options);
  // The generatedDir is stable across rebuilds (it comes from config), so the
  // first pass's answer is enough to filter the build's own writes.
  const generatedDir = first.generatedDir;
  const cleanup = afterFirstBuild?.();

  const scheduler = createRebuildScheduler(async () => {
    if (!options.quiet) {
      writeText("");
      writeText(formatMuted("change detected — rebuilding…", colors));
    }
    await executeBuildPass(options);
    if (!options.quiet) {
      writeText(formatMuted("watching for changes… (ctrl+c to stop)", colors));
    }
  }, WATCH_DEBOUNCE_MS);

  const watcher = fsSync.watch(projectRoot, { recursive: true }, (_event, fileName) => {
    if (fileName === null || fileName === undefined) {
      return;
    }
    if (shouldRebuildOnChange(fileName, { generatedDir })) {
      scheduler.notify();
    }
  });

  if (!options.quiet) {
    writeText("");
    writeText(formatMuted("watching for changes… (ctrl+c to stop)", colors));
  }

  // Keep the process alive until the user interrupts; the watcher handle owns
  // the event-loop reference.
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      watcher.close();
      cleanup?.();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

// Spawns the `rojo serve` child for `aruna dev` and forwards its output with a
// line prefix so it stays distinguishable from build output. Rojo failing to
// launch or exiting is reported but never tears down the watch loop — the
// build side of the dev loop stays useful without it. Returns the shutdown
// cleanup for the session.
function spawnRojoServe(
  projectRoot: string,
  args: readonly string[],
  options: Pick<CliOptions, "quiet">,
  colors: ReturnType<typeof resolveColorMode>,
): () => void {
  const child = spawn("rojo", [...args], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const prefix = formatMuted("rojo │ ", colors);
  const stdoutLines = createLinePrefixer(prefix, (line) => writeText(line));
  const stderrLines = createLinePrefixer(prefix, (line) => process.stderr.write(`${line}\n`));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdoutLines.push(chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => stderrLines.push(chunk));

  let stopping = false;
  child.on("error", (error: NodeJS.ErrnoException) => {
    const detail =
      error.code === "ENOENT"
        ? "rojo not found on PATH — install it (e.g. `rokit add rojo-rbx/rojo`) or pass --no-rojo"
        : error.message;
    process.stderr.write(`${formatWarning(`failed to launch rojo serve: ${detail}`, colors)}\n`);
  });
  child.on("exit", (code, signal) => {
    stdoutLines.flush();
    stderrLines.flush();
    if (!stopping && !options.quiet) {
      const reason = signal !== null ? `signal ${signal}` : `status ${code ?? "unknown"}`;
      writeText(formatWarning(`rojo serve exited (${reason}) — watch build keeps running`, colors));
    }
  });

  if (!options.quiet) {
    writeText("");
    writeText(formatMuted(`rojo ${args.join(" ")} started`, colors));
  }

  return () => {
    stopping = true;
    child.kill("SIGTERM");
  };
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
    )
    .option(
      "--watch",
      "stay running and rebuild on source changes (generated/emitted trees are ignored)",
    );

  build.action(async () => {
    const options = build.optsWithGlobals<BuildCliOptions>();

    if (options.watch !== true) {
      const { ok } = await executeBuildPass(options);
      process.exitCode = ok ? 0 : 1;
      return;
    }

    if (options.json) {
      process.stderr.write("aruna build --watch does not support --json output.\n");
      process.exitCode = 1;
      return;
    }

    await runWatchSession(options);
  });

  const dev = program
    .command("dev")
    .description(
      "one-command dev loop: watch build (codegen + rbxtsc per change) plus a rojo serve child",
    )
    .option(
      "--no-emit-runtime",
      "skip vendoring the Roblox-targeted runtime into the generated dir",
    )
    .option("--no-emit-luau", "skip the rbxtsc Luau compile step on each rebuild")
    .option("--no-rojo", "do not spawn rojo serve")
    .option("--rojo-port <port>", "port for the rojo serve child");

  dev.action(async () => {
    const options = dev.optsWithGlobals<DevCliOptions>();

    if (options.json) {
      process.stderr.write("aruna dev does not support --json output.\n");
      process.exitCode = 1;
      return;
    }

    const input = compilerInput(options);
    const colors = resolveColorMode(options);

    let cliPort: number | undefined;
    if (options.rojoPort !== undefined) {
      const parsed = Number(options.rojoPort);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        process.stderr.write(
          `${formatError(`--rojo-port must be a positive integer, got "${options.rojoPort}"`, colors)}\n`,
        );
        process.exitCode = 1;
        return;
      }
      cliPort = parsed;
    }

    // The `dev` config section is a CLI concern the compiler output does not
    // carry, so it is read through the config loader directly.
    const devConfig = loadProjectConfig(input.root, input.configPath).dev;

    await runWatchSession(options, () => {
      const plan = resolveRojoServePlan({
        rojoEnabled: options.rojo !== false && devConfig.rojo,
        port: cliPort ?? devConfig.rojoPort,
        projectFileExists: rojoProjectFileExists(input.root),
      });

      if (plan.mode === "skip") {
        if (!options.quiet) {
          writeText("");
          writeText(formatMuted(`rojo serve skipped — ${plan.reason}`, colors));
        }
        return undefined;
      }

      return spawnRojoServe(input.root, plan.args, options, colors);
    });
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
