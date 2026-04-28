import path from "node:path";
import type { CompilerOptions } from "typescript";
import type {
  ArunaCompilerInput,
  ArunaCompilerOutput,
  ArunaConfig,
  ArunaDiagnostic,
} from "@arunajs/core";
import { loadProjectConfig } from "./config.js";
import { loadNativeCompiler } from "./native.js";

type NativeTsconfigOptions = {
  baseUrl?: string | undefined;
  paths?: Record<string, string[]> | undefined;
};

type NativeCompilerInput = {
  projectRoot: string;
  config: ArunaConfig;
  configDiagnostics: ArunaDiagnostic[];
  tsconfigOptions: NativeTsconfigOptions;
  writeManifest: boolean;
};

type NativeCompiler = {
  checkProject: (input: NativeCompilerInput) => unknown;
  inspectProject: (input: NativeCompilerInput) => unknown;
};

function resolveProjectRoot(input: ArunaCompilerInput): string {
  return path.resolve(input.root ?? input.config?.root ?? process.cwd());
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

function normalizeConfig(config: ArunaConfig, warningsAsErrors?: boolean): ArunaConfig {
  if (!warningsAsErrors) {
    return config;
  }

  return {
    ...config,
    diagnostics: {
      ...config.diagnostics,
      warningsAsErrors: true,
    },
  };
}

function buildNativeInput(input: ArunaCompilerInput, writeManifest: boolean): NativeCompilerInput {
  const projectRoot = resolveProjectRoot(input);
  const loadedConfig = loadProjectConfig(projectRoot, input.configPath, input.config);
  return {
    projectRoot,
    config: normalizeConfig(loadedConfig.config, input.warningsAsErrors),
    configDiagnostics: loadedConfig.diagnostics,
    tsconfigOptions: normalizeTsconfigOptions(loadedConfig.tsconfigOptions),
    writeManifest,
  };
}

async function runNative<T extends keyof NativeCompiler>(
  method: T,
  input: ArunaCompilerInput,
  writeManifest: boolean,
): Promise<ArunaCompilerOutput> {
  const native = loadNativeCompiler();
  return native[method](buildNativeInput(input, writeManifest)) as ArunaCompilerOutput;
}

export async function checkProject(input: ArunaCompilerInput): Promise<ArunaCompilerOutput> {
  return runNative("checkProject", input, true);
}

export async function inspectProject(input: ArunaCompilerInput): Promise<ArunaCompilerOutput> {
  return runNative("inspectProject", input, false);
}

export { loadNativeCompiler } from "./native.js";
