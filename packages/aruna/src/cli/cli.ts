#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { CompilerOutput, Diagnostic, Manifest } from "@arunajs/core";
import {
  buildProject,
  checkProject,
  createCompilerSession,
  inspectProject,
  loadProjectConfig,
  type CompilerSessionHandle,
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
import { buildActionContractSnapshot } from "./action-contracts.js";
import { formatActionContractInspection } from "./inspect-contract.js";
import { buildNetworkInspectionReport, formatNetworkInspection } from "./inspect-network.js";
import { runMigrateCommand } from "./migrate.js";
import { PRIMITIVES } from "./primitives.js";
import { runContractDiffCommand, type ContractDiffEntry } from "./contract-diff.js";
import {
  collectContractGateDiagnostics,
  planContractUpdate,
  writeContractSnapshot,
} from "./contract-gate.js";
import { findRbxtscBin, runRbxtsc, rbxtscOk, type RbxtscResult } from "./rbxtsc.js";
import {
  buildCacheRoot,
  compileTestPartition,
  runPartitionedRbxtsc,
  startPartitionedRbxtscWatch,
  type PartitionWatch,
} from "./rojo-layout.js";
import { findLuneRunnerDir, probeLune, runLuneSpecs } from "./test-run.js";
import { GENERATED_RUNTIME_DIR } from "./tsconfig-paths.js";
import {
  formatTsconfigSetup,
  setUpTsconfig,
  tsconfigSetupSummary,
  type TsconfigSetup,
} from "./tsconfig-setup.js";
import {
  NODE_MODULES_PROJECT_FILE,
  arunaNodeModulesProjectContents,
} from "./rojo-node-modules.js";
import {
  collectLayoutDesyncDiagnostics,
  reconcileOwnedArtifacts,
} from "./owned-artifacts.js";
import { createRebuildScheduler, isCompilerInputChange, shouldRebuildOnChange } from "./watch.js";
import {
  createLinePrefixer,
  resolveRojoServePlan,
  rojoProjectFileExists,
} from "./dev.js";
import {
  formatAddDomainReport,
  parseAddExtras,
  runAddDomain,
  validateDomainName,
} from "./add.js";
import { formatError, formatInfo, formatMuted, formatSuccess, formatWarning } from "./theme.js";

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
  // Stores against the committed contract snapshot, when there is one.
  const gate = await collectContractGateDiagnostics(output);
  return withExtraDiagnostics(output, [...desync, ...gate], options.warningsAsErrors);
}

async function runInspect(options: CliOptions): Promise<CompilerOutput> {
  return inspectProject(compilerInput(options));
}

type BuildCliOptions = CliOptions & {
  // Runtime vendoring and the rbxtsc compile are both on by default so a bare
  // `aruna build` is turnkey (stubs + vendored Roblox runtime + Luau). The flags
  // are opt-outs (`--no-emit-runtime` / `--no-emit-luau`). Commander leaves
  // these undefined by default, so callers gate on `!== false`.
  emitRuntime?: boolean;
  emitLuau?: boolean;
  watch?: boolean;
  // Print how long each phase took (also in --json as `timings`).
  timings?: boolean;
  // Commander's --no-cache negation: false compiles in a fresh stage.
  cache?: boolean;
};

// How long each phase of one build pass took, in milliseconds. Measured, not
// estimated; absent phases did not run.
export type BuildTimings = {
  tsconfig?: number;
  compile?: number;
  contractGate?: number;
  vendorRuntime?: number;
  // True when the vendored runtime already matched its source, so nothing
  // was written.
  vendorRuntimeUnchanged?: boolean;
  ledger?: number;
  rbxtsc?: number;
  total?: number;
};

async function timed<T>(timings: BuildTimings, phase: keyof BuildTimings, run: () => Promise<T> | T): Promise<T> {
  const started = performance.now();
  try {
    return await run();
  } finally {
    (timings as Record<string, number>)[phase] = Math.round((performance.now() - started) * 10) / 10;
  }
}

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
  // The test surface is vendored like the rest of the runtime so `aruna/testing`
  // resolves in an editor and under `aruna check`; only `aruna test` compiles it.
  "testing",
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
// Whether `targetDir` already holds exactly `runtimeFiles` with the bytes in
// `sourceDir`: then there is nothing to vendor, and not rewriting it keeps the
// files' mtimes, so a watcher downstream (rbxtsc, Rojo) does not see a change
// that is not one.
async function vendoredRuntimeMatches(
  sourceDir: string,
  targetDir: string,
  runtimeFiles: readonly string[],
): Promise<boolean> {
  const present = await fs.readdir(targetDir).catch(() => undefined);
  if (present === undefined || present.length !== runtimeFiles.length) {
    return false;
  }
  for (const name of runtimeFiles) {
    const [source, target] = await Promise.all([
      fs.readFile(path.join(sourceDir, name)),
      fs.readFile(path.join(targetDir, name)).catch(() => undefined),
    ]);
    if (target === undefined || !source.equals(target)) {
      return false;
    }
  }
  return true;
}

async function emitRobloxRuntime(
  root: string,
  generatedDir: string,
  timings?: BuildTimings,
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

  if (await vendoredRuntimeMatches(sourceDir, targetDir, runtimeFiles)) {
    if (timings !== undefined) {
      timings.vendorRuntimeUnchanged = true;
    }
    return runtimeFiles.map((name) => `${GENERATED_RUNTIME_DIR}/${name}`);
  }

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

// The tsconfig upkeep, run before a compile reads tsconfig.json, the way
// `next build` and `next dev` do: `build`, `dev`, and `test` bring the file in
// line with what roblox-ts and Aruna need and say what they changed. Skipped
// while aruna.config.ts fails to load, since the generatedDir the aliases
// point into is unknown then.
function setUpProjectTsconfig(options: CliOptions): TsconfigSetup | undefined {
  const input = compilerInput(options);
  const loaded = loadProjectConfig(input.root, input.configPath);
  if (loaded.diagnostics.some((diagnostic) => diagnostic.code === "aruna::100")) {
    return undefined;
  }
  return setUpTsconfig({ projectRoot: input.root, generatedDir: loaded.config.generatedDir });
}

function tsconfigWritten(
  setup: TsconfigSetup | undefined,
): setup is Exclude<TsconfigSetup, { status: "unreadable" }> {
  return setup?.status === "create" || setup?.status === "update";
}

function renderTsconfigSetup(setup: TsconfigSetup | undefined, options: CliOptions): void {
  if (!tsconfigWritten(setup) || options.quiet) {
    return;
  }
  const [headline, ...details] = formatTsconfigSetup(setup, "applied");
  if (headline === undefined) {
    return;
  }
  writeText(formatInfo(headline, resolveColorMode(options)));
  for (const line of details) {
    writeText(line);
  }
  writeText("");
}

export type BuildRunResult = {
  readonly output: CompilerOutput;
  // Stale artifacts (generatedDir-relative) pruned during this build.
  readonly pruned: string[];
  // What the tsconfig upkeep did before a one-shot compile. A watch session
  // runs the upkeep itself, before it starts its compiler.
  readonly tsconfig?: TsconfigSetup | undefined;
};

// `session`, when given, is the watch loop's incremental compiler; a one-shot
// build compiles from scratch.
async function runBuild(
  options: BuildCliOptions,
  session?: CompilerSessionHandle,
  timings: BuildTimings = {},
): Promise<BuildRunResult> {
  const input = compilerInput(options);
  const tsconfig =
    session === undefined ? await timed(timings, "tsconfig", () => setUpProjectTsconfig(options)) : undefined;
  const compiled = await timed(timings, "compile", () =>
    session !== undefined ? session.run() : buildProject(input),
  );
  // A store change that would leave saved records unreadable stops the build
  // before anything is vendored or compiled to Luau.
  const output = compiled.ok
    ? withExtraDiagnostics(
        compiled,
        await timed(timings, "contractGate", () => collectContractGateDiagnostics(compiled)),
        options.warningsAsErrors,
      )
    : compiled;
  if (!output.ok) {
    return { output, pruned: [], tsconfig };
  }

  const generatedDir = generatedDirFromOutput(output);
  const generatedDirAbs = path.resolve(input.root, generatedDir);

  let runtimeRel: string[] | undefined;
  if (options.emitRuntime !== false) {
    runtimeRel = await timed(timings, "vendorRuntime", () =>
      emitRobloxRuntime(input.root, generatedDir, timings),
    );
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

  // The generated Rojo node_modules project: the scope list is derived from
  // what is installed, so adding a Roblox-facing dependency never means editing
  // default.project.json. Emitted unconditionally — a project that mounts its
  // node_modules by hand simply never points at this file.
  await fs.mkdir(generatedDirAbs, { recursive: true });
  const nodeModulesProject = path.join(generatedDirAbs, NODE_MODULES_PROJECT_FILE);
  const nodeModulesContents = arunaNodeModulesProjectContents(input.root, generatedDir);
  if ((await fs.readFile(nodeModulesProject, "utf8").catch(() => undefined)) !== nodeModulesContents) {
    await fs.writeFile(nodeModulesProject, nodeModulesContents, "utf8");
  }
  generatedRel.push(NODE_MODULES_PROJECT_FILE);

  const { pruned } = await timed(timings, "ledger", () =>
    reconcileOwnedArtifacts({
      generatedDirAbs,
      current: { generated: generatedRel, runtime: runtimeRel },
    }),
  );

  return { output, pruned, tsconfig };
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

type TestCliOptions = CliOptions & {
  emitRuntime?: boolean;
  filter?: string;
};

// `aruna test`: build, stage the project *with* its specs, compile the lot to
// Luau, and run the specs under Lune.
//
// The compile is deliberately not the one `aruna build` produces. Specs are
// staged into their own partition and the result stays in the temp tree, so a
// test run never touches the `out/` the game build owns and no spec can reach
// the place file.
async function runTestSession(options: TestCliOptions): Promise<boolean> {
  const startedAt = Date.now();
  const colors = resolveColorMode(options);
  const input = compilerInput(options);
  const projectRoot = input.root;

  const { output, tsconfig } = await runBuild(options);
  renderTsconfigSetup(tsconfig, options);
  renderCompilerOutput(output, options, Date.now() - startedAt, "build");
  if (!output.ok) {
    return false;
  }

  const runnerDir = findLuneRunnerDir();
  if (runnerDir === undefined) {
    writeText("");
    writeText(
      formatError(
        "the Lune runner assets are missing from the aruna package — reinstall @arunajs/aruna",
        colors,
      ),
    );
    return false;
  }

  const lune = probeLune();
  if (lune.kind === "missing") {
    writeText("");
    writeText(formatError(lune.reason, colors));
    return false;
  }

  const rbxtscBin = findRbxtscBin(projectRoot);
  if (rbxtscBin === undefined) {
    writeText("");
    writeText(
      formatError(
        "rbxtsc not found in node_modules/.bin — install roblox-ts to compile the specs",
        colors,
      ),
    );
    return false;
  }

  const generatedDir = generatedDirFromOutput(output);
  const compiled = compileTestPartition({
    projectRoot,
    generatedDir,
    manifest: output.manifest,
    rbxtscBin,
    tsconfigPath: loadProjectConfig(projectRoot, input.configPath).tsconfigPath,
  });

  if (compiled.kind === "skipped") {
    writeText("");
    writeText(formatError(`could not compile the specs: ${compiled.reason}`, colors));
    return false;
  }

  try {
    if (compiled.status !== 0) {
      // rbxtsc's own diagnostics are the useful output here, so they go through
      // verbatim rather than being summarized.
      process.stdout.write(compiled.stdout);
      process.stderr.write(compiled.stderr);
      writeText("");
      writeText(formatError(`rbxtsc exited with status ${compiled.status}`, colors));
      return false;
    }

    if (!options.quiet) {
      writeText("");
      writeText(formatMuted("running specs under Lune", colors));
      writeText("");
    }

    const status = await runLuneSpecs({
      luneBin: lune.bin,
      runnerDir,
      outRoot: compiled.outRoot,
      includeRoot: compiled.includeRoot,
      generatedDirName: path.posix.basename(generatedDir.split(path.sep).join("/")),
      nodeModules: path.join(projectRoot, "node_modules"),
      ...(options.filter !== undefined ? { filter: options.filter } : {}),
    });
    return status === 0;
  } finally {
    compiled.dispose();
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
//
// `mode: "codegen-only"` stops after stub generation and hands the manifest
// back instead of compiling. Watch mode uses it because it drives a resident
// `rbxtsc --watch` itself rather than paying a cold compile per change.
async function executeBuildPass(
  options: BuildCliOptions,
  mode: "compile" | "codegen-only" = "compile",
  session?: CompilerSessionHandle,
): Promise<{ ok: boolean; generatedDir: string; manifest?: Manifest | undefined }> {
  const startedAt = Date.now();
  const passStarted = performance.now();
  const timings: BuildTimings = {};
  const { output, pruned, tsconfig } = await runBuild(options, session, timings);
  const projectRoot = compilerInput(options).root;
  let rbxtsc: RbxtscResult | undefined;
  if (output.ok && options.emitLuau !== false && mode === "compile") {
    // Partition the project into client/server/shared so the emitted out/ maps
    // onto the Roblox DataModel (server code stays in ServerScriptService).
    const bin = findRbxtscBin(projectRoot);
    const rbxtscStarted = performance.now();
    rbxtsc =
      bin === undefined
        ? runRbxtsc({ projectRoot })
        : runPartitionedRbxtsc(
            {
              projectRoot,
              generatedDir: generatedDirFromOutput(output),
              manifest: output.manifest,
              rbxtscBin: bin,
              // The staged compile inherits the consumer's compilerOptions, so
              // it needs the tsconfig their config actually points at.
              tsconfigPath: loadProjectConfig(projectRoot, compilerInput(options).configPath)
                .tsconfigPath,
            },
            options.cache === false ? undefined : buildCacheRoot(projectRoot),
          );
    timings.rbxtsc = Math.round((performance.now() - rbxtscStarted) * 10) / 10;
  }
  timings.total = Math.round((performance.now() - passStarted) * 10) / 10;

  if (options.json) {
    writeJson({
      ...output,
      ...(tsconfigWritten(tsconfig) ? { tsconfig: tsconfigSetupSummary(tsconfig) } : {}),
      ...(pruned.length > 0 ? { pruned } : {}),
      ...(rbxtsc ? { rbxtsc } : {}),
      ...(options.timings === true ? { timings } : {}),
    });
  } else {
    renderTsconfigSetup(tsconfig, options);
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
    if (options.timings === true) {
      writeText("");
      writeText(formatMuted(`timings: ${formatBuildTimings(timings)}`, resolveColorMode(options)));
    }
  }

  const luauOk = rbxtsc === undefined || rbxtscOk(rbxtsc);
  return {
    ok: output.ok && luauOk,
    generatedDir: generatedDirFromOutput(output),
    manifest: output.ok ? output.manifest : undefined,
  };
}

function formatBuildTimings(timings: BuildTimings): string {
  const parts: string[] = [];
  for (const phase of ["tsconfig", "compile", "contractGate", "vendorRuntime", "ledger", "rbxtsc", "total"] as const) {
    const value = timings[phase];
    if (value !== undefined) {
      parts.push(
        `${phase} ${value}ms${phase === "vendorRuntime" && timings.vendorRuntimeUnchanged === true ? " (unchanged)" : ""}`,
      );
    }
  }
  return parts.join(", ");
}

// Holds the single `rbxtsc --watch` child that serves a whole watch session.
type ResidentLuauWatch = {
  // Stages the project into the resident compiler. The first call starts the
  // child; later calls only rewrite the staged sources, which the compiler's
  // own watcher picks up as an incremental rebuild. False means the resident
  // compiler is unavailable and the caller must fall back to a one-shot pass.
  readonly stage: (manifest: Manifest, generatedDir: string) => boolean;
  readonly active: () => boolean;
  readonly stop: () => void;
};

// Prepares the resident Luau compiler for a watch session, or returns undefined
// when this session must keep using one-shot compiles (`--no-emit-luau`, or no
// rbxtsc installed).
function startResidentLuauWatch(
  options: BuildCliOptions,
  colors: ReturnType<typeof resolveColorMode>,
): ResidentLuauWatch | undefined {
  if (options.emitLuau === false) {
    return undefined;
  }
  const projectRoot = compilerInput(options).root;
  const rbxtscBin = findRbxtscBin(projectRoot);
  if (rbxtscBin === undefined) {
    return undefined;
  }
  const tsconfigPath = loadProjectConfig(projectRoot, compilerInput(options).configPath)
    .tsconfigPath;

  let watch: PartitionWatch | undefined;
  let unavailable = false;

  return {
    active: () => !unavailable,
    stage(manifest, generatedDir) {
      if (unavailable) {
        return false;
      }
      if (watch !== undefined) {
        watch.restage(manifest);
        return true;
      }
      const started = startPartitionedRbxtscWatch({
        projectRoot,
        generatedDir,
        manifest,
        rbxtscBin,
        tsconfigPath,
        onOutput: (chunk, stream) => {
          (stream === "stdout" ? process.stdout : process.stderr).write(chunk);
        },
        onCompile: ({ errorCount }) => {
          if (options.quiet) {
            return;
          }
          writeText("");
          writeText(
            errorCount === 0
              ? formatSuccess("rbxtsc compiled the project to Luau", colors)
              : formatError(
                  `rbxtsc reported ${errorCount} error${errorCount === 1 ? "" : "s"}`,
                  colors,
                ),
          );
        },
      });
      if (started.kind === "skipped") {
        unavailable = true;
        if (!options.quiet) {
          writeText("");
          writeText(formatMuted(`resident rbxtsc watch unavailable — ${started.reason}`, colors));
        }
        return false;
      }
      watch = started.watch;
      return true;
    },
    stop() {
      watch?.stop();
    },
  };
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

  // Try to keep one rbxtsc alive for the whole session. A cold rbxtsc rebuilds
  // its TypeScript program over the entire @rbxts type surface every run, which
  // costs far more than compiling the project itself — so respawning it per
  // change makes watch mode no faster than repeated one-shot builds.
  const resident = startResidentLuauWatch(options, colors);

  // The tsconfig upkeep runs before each compiler session reads tsconfig.json.
  // What it last wrote is remembered so that write, when the watcher reports
  // it, is not taken for an edit to rebuild on.
  const tsconfigPath = path.join(projectRoot, "tsconfig.json");
  let tsconfigWrite: string | undefined;
  const upkeepTsconfig = (): void => {
    const setup = setUpProjectTsconfig(options);
    if (tsconfigWritten(setup)) {
      tsconfigWrite = setup.contents;
    }
    renderTsconfigSetup(setup, options);
  };
  const isOwnTsconfigWrite = (file: string): boolean => {
    if (tsconfigWrite === undefined || file !== tsconfigPath) {
      return false;
    }
    try {
      return fsSync.readFileSync(file, "utf8") === tsconfigWrite;
    } catch {
      return false;
    }
  };

  // One incremental compiler for the whole session: each pass tells it what
  // changed instead of re-reading and re-parsing the project. A config change
  // (aruna.config.ts, tsconfig.json) is part of its input, so it starts over.
  upkeepTsconfig();
  let session = createCompilerSession(compilerInput(options), "build");
  const pendingChanges = new Set<string>();

  // One pass of the loop. Codegen runs first; the Luau compile is either handed
  // to the resident watcher or, when that is unavailable, done inline.
  const runPass = async (): Promise<{ generatedDir: string }> => {
    const useResident = resident?.active() === true;
    const pass = await executeBuildPass(
      options,
      useResident ? "codegen-only" : "compile",
      session,
    );
    if (useResident && pass.manifest !== undefined) {
      // A resident watcher that fails to start leaves this pass without Luau
      // output, so redo it as a one-shot compile.
      if (!resident.stage(pass.manifest, pass.generatedDir)) {
        await executeBuildPass(options, "compile", session);
      }
    }
    return { generatedDir: pass.generatedDir };
  };

  const first = await runPass();
  // The generatedDir is stable across rebuilds (it comes from config), so the
  // first pass's answer is enough to filter the build's own writes.
  const generatedDir = first.generatedDir;
  const cleanup = afterFirstBuild?.();

  const scheduler = createRebuildScheduler(async () => {
    if (!options.quiet) {
      writeText("");
      writeText(formatMuted("change detected — rebuilding…", colors));
    }
    const changed = [...pendingChanges];
    pendingChanges.clear();
    if (changed.some((file) => isCompilerInputChange(path.relative(projectRoot, file)))) {
      session.dispose();
      upkeepTsconfig();
      session = createCompilerSession(compilerInput(options), "build");
    } else {
      session.update(changed);
    }
    await runPass();
    if (!options.quiet) {
      writeText(formatMuted("watching for changes… (ctrl+c to stop)", colors));
    }
  }, WATCH_DEBOUNCE_MS);

  const watcher = fsSync.watch(projectRoot, { recursive: true }, (_event, fileName) => {
    if (fileName === null || fileName === undefined) {
      return;
    }
    const file = path.join(projectRoot, fileName);
    if (shouldRebuildOnChange(fileName, { generatedDir }) && !isOwnTsconfigWrite(file)) {
      pendingChanges.add(file);
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
      session.dispose();
      resident?.stop();
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

type ContractUpdateCliOptions = CliOptions & {
  readonly check?: boolean;
  readonly acceptUnreadableRecords?: boolean;
};

function describeUnreadableChange(entry: ContractDiffEntry): string {
  return entry.actionId !== undefined ? `${entry.actionId}: ${entry.message}` : entry.message;
}

// `aruna contract update`. The snapshot is the record of what shipped, and a
// store change that leaves saved records unreadable is exactly what the gate
// exists to stop, so recording one is refused: intending the change does not
// make the old records readable. Only --accept-unreadable-records overrides it.
async function runContractUpdate(options: ContractUpdateCliOptions): Promise<number> {
  const colors = resolveColorMode(options);
  const output = await inspectProject(compilerInput(options));
  if (!output.ok) {
    // A snapshot is the record of what shipped; one taken from a project
    // that does not compile would record something that never could.
    renderCompilerOutput(output, options, 0, "inspect");
    return 1;
  }
  const plan = await planContractUpdate(output);
  const unreadable = plan.unreadable.map(describeUnreadableChange);

  if (options.check === true) {
    if (options.json) {
      writeJson({
        ok: !plan.outOfDate,
        snapshot: plan.snapshotPath,
        outOfDate: plan.outOfDate,
        committed: plan.committed,
        unreadableRecordChanges: unreadable,
      });
    } else if (!plan.outOfDate) {
      if (!options.quiet) {
        writeText(formatSuccess(`${plan.snapshotPath} is up to date`, colors));
      }
    } else {
      const reason =
        plan.committed === "missing"
          ? "does not exist"
          : plan.committed === "invalid"
            ? `could not be read: ${plan.invalidMessage ?? ""}`
            : "is out of date";
      const lines = [formatError(`${plan.snapshotPath} ${reason}`, colors)];
      if (unreadable.length > 0) {
        lines.push(
          "  `aruna contract update` will refuse it: these store changes leave saved records unreadable:",
          ...unreadable.map((line) => `    - ${line}`),
        );
      } else {
        lines.push("  Run `aruna contract update` and commit the snapshot.");
      }
      process.stderr.write(`${lines.join("\n")}\n`);
    }
    return plan.outOfDate ? 1 : 0;
  }

  const accept = options.acceptUnreadableRecords === true;
  const refusal =
    plan.committed === "invalid"
      ? [
          `could not compare against ${plan.snapshotPath}: ${plan.invalidMessage ?? ""}`,
          "Restore it from version control so the stores can be checked against it.",
        ]
      : unreadable.length > 0
        ? [
            `refusing to update ${plan.snapshotPath}: ${unreadable.length === 1 ? "a store change leaves" : `${unreadable.length} store changes leave`} records the last build saved unreadable`,
            ...unreadable.map((line) => `  - ${line}`),
            "Give the new field a .default(...), or bump the store's version and add a migrate() that converts the old records.",
          ]
        : undefined;

  if (refusal !== undefined && !accept) {
    if (options.json) {
      writeJson({
        ok: false,
        snapshot: plan.snapshotPath,
        committed: plan.committed,
        unreadableRecordChanges: unreadable,
      });
    } else {
      const [headline, ...rest] = refusal;
      process.stderr.write(
        `${[formatError(headline ?? "", colors), ...rest, "Writing it anyway takes --accept-unreadable-records."].join("\n")}\n`,
      );
    }
    return 1;
  }

  if (refusal !== undefined) {
    // Loud on purpose, and on stderr so it survives --json and --quiet: past
    // this point the gate no longer protects the records named here.
    const what =
      plan.committed === "invalid"
        ? [`${plan.snapshotPath} could not be read, so no store was checked.`]
        : [
            "These changes leave records the last build saved UNREADABLE by this one:",
            ...unreadable.map((line) => `  - ${line}`),
            "Players whose records were saved before this change will fail to load.",
          ];
    process.stderr.write(
      `${[formatWarning("WARNING: --accept-unreadable-records: recording an incompatible store change", colors), ...what].join("\n")}\n`,
    );
  }

  const written = await writeContractSnapshot(output, plan.snapshot);
  if (options.json) {
    writeJson({
      ok: true,
      snapshot: written,
      ...(refusal !== undefined ? { acceptedUnreadableRecordChanges: unreadable } : {}),
    });
  } else if (!options.quiet) {
    writeText(formatSuccess(`wrote ${written}`, colors));
  }
  return 0;
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

  // One subcommand per registered primitive that has an inspection
  // (src/cli/primitives.ts), in registration order.
  for (const primitive of PRIMITIVES) {
    const inspection = primitive.inspect;
    if (inspection === undefined) {
      continue;
    }
    inspect
      .command(inspection.command)
      .description(inspection.description)
      .action(async () => {
        const options = program.optsWithGlobals<CliOptions>();
        const output = await runInspect(options);
        if (options.json) {
          writeJson(inspection.report(output));
          process.exitCode = output.ok ? 0 : 1;
          return;
        }

        const colors = resolveColorMode(options);
        writeText(inspection.format(output, colors));
        if (!options.quiet && output.diagnostics.length > 0) {
          const diagnostics = formatDiagnostics(output, colors);
          if (diagnostics.length > 0) {
            writeText(diagnostics);
          }
        }
        process.exitCode = output.ok ? 0 : 1;
      });
  }

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
    .command("network")
    .description("show the declared traffic policy: rate limits, budgets, payload bounds (static, not measured)")
    .action(async () => {
      const options = program.optsWithGlobals<CliOptions>();
      const output = await runInspect(options);
      if (options.json) {
        writeJson(buildNetworkInspectionReport(output));
        process.exitCode = output.ok ? 0 : 1;
        return;
      }
      writeText(formatNetworkInspection(output, resolveColorMode(options)));
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
    )
    .option("--timings", "print how long each build phase took (in --json as `timings`)")
    .option(
      "--no-cache",
      "compile in a fresh stage instead of the incremental one Aruna keeps in the OS temp dir",
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

  const test = program
    .command("test")
    .description("compile the project with its specs and run them under Lune")
    .option("--no-emit-runtime", "skip vendoring the Roblox-targeted runtime into the generated dir")
    .option("--filter <pattern>", "only run specs whose path contains this substring");

  test.action(async () => {
    const options = test.optsWithGlobals<TestCliOptions>();
    if (options.json) {
      process.stderr.write("aruna test does not support --json output.\n");
      process.exitCode = 1;
      return;
    }
    process.exitCode = (await runTestSession(options)) ? 0 : 1;
  });

  const add = program.command("add").description("scaffold project files from the conventions");
  const addDomain = add
    .command("domain <name>")
    .description(
      "scaffold <root>/domains/<name>/{schema,model,actions}.ts (extend with --with ui,runtime)",
    )
    .option("--with <parts>", `comma-separated extras: ui, runtime`);

  addDomain.action(async (name: string) => {
    const options = addDomain.optsWithGlobals<CliOptions & { with?: string }>();
    const colors = resolveColorMode(options);

    const nameError = validateDomainName(name);
    if (nameError !== undefined) {
      process.stderr.write(`${formatError(nameError, colors)}\n`);
      process.exitCode = 1;
      return;
    }

    const parsedExtras = parseAddExtras(options.with);
    if (parsedExtras.error !== undefined) {
      process.stderr.write(`${formatError(parsedExtras.error, colors)}\n`);
      process.exitCode = 1;
      return;
    }

    const input = compilerInput(options);
    // The domain lands under the configured source root so the scaffolded files
    // sit where the classifier conventions expect them.
    const root = loadProjectConfig(input.root, input.configPath).config.root;
    const result = runAddDomain({
      projectRoot: input.root,
      root,
      name,
      extras: parsedExtras.extras ?? [],
    });

    if (options.json) {
      writeJson({ name, ...result });
      return;
    }
    writeText(formatAddDomainReport(name, result));
  });

  program
    .command("init")
    .description(
      "scaffold aruna.config.ts and default.project.json, and create or reconfigure tsconfig.json",
    )
    .option(
      "--force",
      "overwrite the scaffolded files instead of keeping existing ones (replaces a Rojo project file that does not mount out/)",
    )
    .action(async (initOptions: { force?: boolean }) => {
      const options = program.optsWithGlobals<CliOptions>();
      const result = runInit({
        projectRoot: compilerInput(options).root,
        force: initOptions.force,
      });
      if (options.json) {
        writeJson(result);
      } else {
        writeText(formatInitReport(result));
      }
    });

  const doctor = program
    .command("doctor")
    .description("inspect the project setup: tsconfig.json, its Aruna aliases, the Rojo project")
    .option("--fix", "reconfigure tsconfig.json the way `aruna build` does on its own");

  doctor.action(async () => {
    const options = doctor.optsWithGlobals<DoctorCliOptions>();
    await runDoctorCli(options);
  });

  const contract = program
    .command("contract")
    .description("compare and record contract snapshots");
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

  const contractUpdate = contract
    .command("update")
    .description(
      "write the current contract to the committed snapshot (contract.snapshot) that check and build compare stores against",
    )
    .option("--check", "write nothing; exit 1 when the committed snapshot is out of date (for CI)")
    .option(
      "--accept-unreadable-records",
      "write even when a store change leaves records the committed snapshot's build saved unreadable",
    )
    .action(async () => {
      const options = contractUpdate.optsWithGlobals<CliOptions>() as CliOptions & {
        readonly check?: boolean;
        readonly acceptUnreadableRecords?: boolean;
      };
      process.exitCode = await runContractUpdate(options);
    });

  const migrate = program
    .command("migrate [name]")
    .description("run a codemod for one of Aruna's breaking changes (see docs/codemods.md)")
    .option("--list", "list the available codemods")
    .option("--dry-run", "print the changes as a unified diff; write nothing")
    .action(async (name: string | undefined) => {
      const options = migrate.optsWithGlobals<CliOptions>() as CliOptions & {
        readonly list?: boolean;
        readonly dryRun?: boolean;
      };
      const input = compilerInput(options);
      const result = runMigrateCommand({
        name,
        list: options.list,
        dryRun: options.dryRun,
        json: options.json,
        root: input.root,
        configPath: input.configPath,
        colors: resolveColorMode(options),
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
