import path from "node:path";
import type { CompilerOptions } from "typescript";
import type {
  CompilerInput,
  CompilerOutput,
  Diagnostic,
  NormalizedConfig,
} from "@arunajs/core";
import { loadProjectConfig } from "./config.js";
import { loadNativeCompiler } from "./native.js";

type NativeTsconfigOptions = {
  baseUrl?: string | undefined;
  paths?: Record<string, string[]> | undefined;
};

type NativeCompilerInput = {
  projectRoot: string;
  config: NormalizedConfig;
  configDiagnostics: Diagnostic[];
  tsconfigOptions: NativeTsconfigOptions;
  writeManifest: boolean;
  writeGenerated: boolean;
  warningsAsErrors: boolean;
};


function resolveProjectRoot(input: CompilerInput): string {
  return path.resolve(input.root ?? process.cwd());
}

function normalizeTsconfigOptions(options: CompilerOptions): NativeTsconfigOptions {
  const paths = options.paths
    ? Object.fromEntries(Object.entries(options.paths).map(([key, value]) => [key, [...value]]))
    : undefined;

  return {
    baseUrl: typeof options.baseUrl === "string" ? options.baseUrl : undefined,
    paths,
  };
}

function buildNativeInput(
  input: CompilerInput,
  writeManifest: boolean,
  writeGenerated: boolean,
): NativeCompilerInput {
  const projectRoot = resolveProjectRoot(input);
  const loadedConfig = loadProjectConfig(projectRoot, input.configPath, input.config);
  return {
    projectRoot,
    config: loadedConfig.config,
    configDiagnostics: loadedConfig.diagnostics,
    tsconfigOptions: normalizeTsconfigOptions(loadedConfig.tsconfigOptions),
    writeManifest,
    writeGenerated,
    warningsAsErrors: input.warningsAsErrors ?? false,
  };
}

// What a run does: `check` writes the manifest, `build` also writes the
// generated files, `inspect` writes nothing.
export type CompilerRunMode = "check" | "build" | "inspect";

// A compiler kept alive across runs: the project's files and every per-file
// fact are cached in the native session, and `update` names what changed, so a
// run after a one-file edit costs a fraction of a cold one. Runs execute off the
// main thread. Config is read once, when the session is created — start a new
// session when aruna.config.ts or tsconfig.json changes.
export type CompilerSessionHandle = {
  // Paths edited, created, deleted, or (directories) moved since the last run;
  // absolute or relative to the project root.
  readonly update: (changedPaths: readonly string[]) => void;
  readonly run: () => Promise<CompilerOutput>;
  readonly dispose: () => void;
};

export function createCompilerSession(
  input: CompilerInput,
  mode: CompilerRunMode,
): CompilerSessionHandle {
  const native = loadNativeCompiler();
  const nativeInput = buildNativeInput(input, mode !== "inspect", mode === "build");
  const session = new native.CompilerSession(nativeInput);
  return {
    update: (changedPaths) => session.update([...changedPaths]),
    run: async () =>
      JSON.parse(await (mode === "inspect" ? session.inspect() : session.check())) as CompilerOutput,
    dispose: () => session.dispose(),
  };
}

// `aruna migrate`'s codemods (crates/aruna_migrate, docs/codemods.md).
export type CodemodInfo = { readonly name: string; readonly description: string };

export type CodemodReport = {
  readonly codemod: string;
  readonly dryRun: boolean;
  readonly filesScanned: number;
  // Project-relative paths, each with a unified diff of the change.
  readonly changed: readonly { readonly file: string; readonly diff: string }[];
  // Sites the codemod found but could not rewrite safely: check them by hand.
  readonly unhandled: readonly {
    readonly file: string;
    readonly line: number;
    readonly column: number;
    readonly message: string;
  }[];
};

export function listCodemods(): CodemodInfo[] {
  return loadNativeCompiler().listCodemods() as CodemodInfo[];
}

// Runs codemod `name` over the TypeScript sources under `root` (skipping build
// output and `excludeDirs`). Writes the changes unless `dryRun`.
export function runCodemod(options: {
  readonly name: string;
  readonly root: string;
  readonly excludeDirs?: readonly string[];
  readonly dryRun: boolean;
}): CodemodReport {
  return loadNativeCompiler().runCodemod({
    name: options.name,
    projectRoot: options.root,
    excludeDirs: [...(options.excludeDirs ?? [])],
    dryRun: options.dryRun,
  }) as CodemodReport;
}

// The one-shot entry points: a session used once, so the work still runs off
// the main thread.
async function runOnce(input: CompilerInput, mode: CompilerRunMode): Promise<CompilerOutput> {
  const session = createCompilerSession(input, mode);
  try {
    return await session.run();
  } finally {
    session.dispose();
  }
}

export async function checkProject(input: CompilerInput): Promise<CompilerOutput> {
  return runOnce(input, "check");
}

export async function buildProject(input: CompilerInput): Promise<CompilerOutput> {
  return runOnce(input, "build");
}

export async function inspectProject(input: CompilerInput): Promise<CompilerOutput> {
  return runOnce(input, "inspect");
}

export { loadNativeCompiler, type NativeCompilerSession } from "./native.js";
export {
  loadProjectConfig,
  normalizeDevConfig,
  type LoadedConfig,
  type NormalizedDevConfig,
} from "./config.js";
