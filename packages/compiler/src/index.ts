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

type NativeCompiler = {
  checkProject: (input: NativeCompilerInput) => unknown;
  inspectProject: (input: NativeCompilerInput) => unknown;
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

async function runNative<T extends keyof NativeCompiler>(
  method: T,
  input: CompilerInput,
  writeManifest: boolean,
  writeGenerated: boolean,
): Promise<CompilerOutput> {
  const native = loadNativeCompiler();
  return native[method](
    buildNativeInput(input, writeManifest, writeGenerated),
  ) as CompilerOutput;
}

export async function checkProject(input: CompilerInput): Promise<CompilerOutput> {
  return runNative("checkProject", input, true, false);
}

export async function buildProject(input: CompilerInput): Promise<CompilerOutput> {
  return runNative("checkProject", input, true, true);
}

export async function inspectProject(input: CompilerInput): Promise<CompilerOutput> {
  return runNative("inspectProject", input, false, false);
}

export { loadNativeCompiler } from "./native.js";
export { loadProjectConfig, type LoadedConfig } from "./config.js";
