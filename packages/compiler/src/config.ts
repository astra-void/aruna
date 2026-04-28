import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import * as ts from "typescript";
import type { ArunaConfig, ArunaDiagnostic } from "@arunajs/core";
import { DEFAULT_ARUNA_CONFIG } from "@arunajs/core";

export type LoadedArunaConfig = {
  projectRoot: string;
  configPath?: string | undefined;
  config: ArunaConfig;
  tsconfigPath: string;
  tsconfigOptions: ts.CompilerOptions;
  diagnostics: ArunaDiagnostic[];
};

type RawConfigObject = Record<string, unknown>;

const requireForConfig = createRequire(import.meta.url);

const DIAGNOSTIC_META: Record<"aruna::100" | "aruna::102", { name: string; severity: ArunaDiagnostic["severity"] }> = {
  "aruna::100": { name: "invalid-config", severity: "error" },
  "aruna::102": { name: "missing-tsconfig", severity: "warning" },
};

function createDiagnostic(
  code: keyof typeof DIAGNOSTIC_META,
  message: string,
  extras: Partial<ArunaDiagnostic> = {},
): ArunaDiagnostic {
  const meta = DIAGNOSTIC_META[code];
  return {
    code,
    name: meta.name,
    severity: meta.severity,
    message,
    ...extras,
  };
}

function formatProjectRelativePath(projectRoot: string, absolutePath: string): string {
  const relativePath = path.relative(projectRoot, absolutePath);
  const candidatePath = relativePath.length > 0 ? relativePath : path.basename(absolutePath);
  return candidatePath.split(path.sep).join("/");
}

function isRecord(value: unknown): value is RawConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function mergeArray<T>(base: readonly T[] | undefined, override: readonly T[] | undefined): T[] | undefined {
  if (override !== undefined) {
    return [...override];
  }

  if (base !== undefined) {
    return [...base];
  }

  return undefined;
}

function mergeConfig(base: ArunaConfig, override: ArunaConfig): ArunaConfig {
  return {
    ...base,
    ...override,
    source: {
      ...base.source,
      ...override.source,
      include: mergeArray(base.source?.include, override.source?.include),
      exclude: mergeArray(base.source?.exclude, override.source?.exclude),
    },
    conventions: {
      ...base.conventions,
      ...override.conventions,
      client: mergeArray(base.conventions?.client, override.conventions?.client),
      server: mergeArray(base.conventions?.server, override.conventions?.server),
      shared: mergeArray(base.conventions?.shared, override.conventions?.shared),
    },
    diagnostics: {
      ...base.diagnostics,
      ...override.diagnostics,
      ignore: mergeArray(base.diagnostics?.ignore, override.diagnostics?.ignore),
    },
    security: {
      ...base.security,
      ...override.security,
    },
    manifest: {
      ...base.manifest,
      ...override.manifest,
    },
  };
}

function normalizeConfigObject(value: unknown): {
  config?: ArunaConfig;
  error?: string;
} {
  if (!isRecord(value)) {
    return { error: "configuration module did not export an object" };
  }

  const candidate = value["default"] ?? value;
  if (!isRecord(candidate)) {
    return { error: "configuration module did not export an object" };
  }

  const candidateRecord = candidate as RawConfigObject;
  const diagnostics: string[] = [];
  const config: ArunaConfig = {};

  if (candidateRecord["root"] !== undefined) {
    if (typeof candidateRecord["root"] !== "string") {
      diagnostics.push("root must be a string");
    } else {
      config.root = candidateRecord["root"];
    }
  }

  if (candidateRecord["tsconfig"] !== undefined) {
    if (typeof candidateRecord["tsconfig"] !== "string") {
      diagnostics.push("tsconfig must be a string");
    } else {
      config.tsconfig = candidateRecord["tsconfig"];
    }
  }

  if (candidateRecord["source"] !== undefined) {
    const sourceValue = candidateRecord["source"];
    if (!isRecord(sourceValue)) {
      diagnostics.push("source must be an object");
    } else {
      const source: NonNullable<ArunaConfig["source"]> = {};
      if (sourceValue["include"] !== undefined) {
        if (!isStringArray(sourceValue["include"])) {
          diagnostics.push("source.include must be a string array");
        } else {
          source.include = sourceValue["include"];
        }
      }
      if (sourceValue["exclude"] !== undefined) {
        if (!isStringArray(sourceValue["exclude"])) {
          diagnostics.push("source.exclude must be a string array");
        } else {
          source.exclude = sourceValue["exclude"];
        }
      }
      config.source = source;
    }
  }

  if (candidateRecord["conventions"] !== undefined) {
    const conventionsValue = candidateRecord["conventions"];
    if (!isRecord(conventionsValue)) {
      diagnostics.push("conventions must be an object");
    } else {
      const conventions: NonNullable<ArunaConfig["conventions"]> = {};
      for (const key of ["client", "server", "shared"] as const) {
        const conventionValue = conventionsValue[key];
        if (conventionValue !== undefined) {
          if (!isStringArray(conventionValue)) {
            diagnostics.push(`conventions.${key} must be a string array`);
          } else {
            conventions[key] = conventionValue;
          }
        }
      }
      config.conventions = conventions;
    }
  }

  if (candidateRecord["diagnostics"] !== undefined) {
    const diagnosticsValue = candidateRecord["diagnostics"];
    if (!isRecord(diagnosticsValue)) {
      diagnostics.push("diagnostics must be an object");
    } else {
      const diagnosticsConfig: NonNullable<ArunaConfig["diagnostics"]> = {};
      if (diagnosticsValue["warningsAsErrors"] !== undefined) {
        if (typeof diagnosticsValue["warningsAsErrors"] !== "boolean") {
          diagnostics.push("diagnostics.warningsAsErrors must be a boolean");
        } else {
          diagnosticsConfig.warningsAsErrors = diagnosticsValue["warningsAsErrors"];
        }
      }
      if (diagnosticsValue["ignore"] !== undefined) {
        if (!isStringArray(diagnosticsValue["ignore"])) {
          diagnostics.push("diagnostics.ignore must be a string array");
        } else {
          diagnosticsConfig.ignore = diagnosticsValue["ignore"];
        }
      }
      config.diagnostics = diagnosticsConfig;
    }
  }

  if (candidateRecord["security"] !== undefined) {
    const securityValue = candidateRecord["security"];
    if (!isRecord(securityValue)) {
      diagnostics.push("security must be an object");
    } else {
      const security: NonNullable<ArunaConfig["security"]> = {};
      if (securityValue["mode"] !== undefined) {
        const allowed = new Set(["recommended", "strict", "audit", "off"]);
        if (typeof securityValue["mode"] !== "string" || !allowed.has(securityValue["mode"])) {
          diagnostics.push("security.mode must be one of recommended, strict, audit, off");
        } else {
          security.mode = securityValue["mode"] as NonNullable<ArunaConfig["security"]>["mode"];
        }
      }
      config.security = security;
    }
  }

  if (candidateRecord["manifest"] !== undefined) {
    const manifestValue = candidateRecord["manifest"];
    if (!isRecord(manifestValue)) {
      diagnostics.push("manifest must be an object");
    } else {
      const manifest: NonNullable<ArunaConfig["manifest"]> = {};
      if (manifestValue["enabled"] !== undefined) {
        if (typeof manifestValue["enabled"] !== "boolean") {
          diagnostics.push("manifest.enabled must be a boolean");
        } else {
          manifest.enabled = manifestValue["enabled"];
        }
      }
      if (manifestValue["output"] !== undefined) {
        if (typeof manifestValue["output"] !== "string") {
          diagnostics.push("manifest.output must be a string");
        } else {
          manifest.output = manifestValue["output"];
        }
      }
      config.manifest = manifest;
    }
  }

  if (diagnostics.length > 0) {
    return { error: diagnostics.join("; ") };
  }

  return { config };
}

function evaluateCommonJs(sourceText: string, filename: string): unknown {
  const transformed = ts.transpileModule(sourceText, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  });

  const module = { exports: {} as unknown };
  const sandbox = {
    exports: module.exports,
    module,
    require: requireForConfig,
    __filename: filename,
    __dirname: path.dirname(filename),
  };
  const script = new vm.Script(transformed.outputText, { filename });
  const context = vm.createContext(sandbox);
  script.runInContext(context);
  return module.exports;
}

function loadUserConfigFile(projectRoot: string, configFile: string): {
  config?: ArunaConfig;
  diagnostic?: ArunaDiagnostic;
} {
  try {
    const sourceText = fs.readFileSync(configFile, "utf8");
    const evaluated = evaluateCommonJs(sourceText, configFile);
    const normalized = normalizeConfigObject(evaluated);
    if (normalized.error) {
      return {
        diagnostic: createDiagnostic(
          "aruna::100",
          `Invalid Aruna configuration in ${path.basename(configFile)}.`,
          {
            file: formatProjectRelativePath(projectRoot, configFile),
            details: normalized.error,
            suggestion: "Export a plain object from aruna.config.ts or wrap it with defineConfig().",
          },
        ),
      };
    }
    return { config: normalized.config as ArunaConfig };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      diagnostic: createDiagnostic(
        "aruna::100",
        `Failed to load ${path.basename(configFile)}.`,
        {
          file: formatProjectRelativePath(projectRoot, configFile),
          details: message,
          suggestion: "Fix the configuration file syntax or export shape.",
        },
      ),
    };
  }
}

function loadTsConfig(projectRoot: string, tsconfigPath: string): {
  options: ts.CompilerOptions;
  diagnostic?: ArunaDiagnostic;
} {
  if (!fs.existsSync(tsconfigPath)) {
    return {
      options: {},
      diagnostic: createDiagnostic(
        "aruna::102",
        `Missing TypeScript config at ${path.basename(tsconfigPath)}.`,
        {
          file: formatProjectRelativePath(projectRoot, tsconfigPath),
          details: "Aruna looked for the TypeScript config at the resolved path but could not find it.",
          suggestion: "Create tsconfig.json or point aruna.config.ts to an existing tsconfig file.",
        },
      ),
    };
  }

  const result = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (result.error) {
    const message = ts.flattenDiagnosticMessageText(result.error.messageText, "\n");
    return {
      options: {},
      diagnostic: createDiagnostic(
        "aruna::100",
        `Invalid TypeScript config at ${path.basename(tsconfigPath)}.`,
        {
          file: formatProjectRelativePath(projectRoot, tsconfigPath),
          details: message,
          suggestion: "Fix the tsconfig syntax or remove unsupported compiler options.",
        },
      ),
    };
  }

  const parsed = ts.parseJsonConfigFileContent(result.config, ts.sys, path.dirname(tsconfigPath));
  const details = parsed.errors.length > 0
    ? parsed.errors.map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, "\n")).join("\n")
    : undefined;

  if (details) {
    return {
      options: parsed.options,
      diagnostic: createDiagnostic(
        "aruna::100",
        `Invalid TypeScript config at ${path.basename(tsconfigPath)}.`,
        {
          file: formatProjectRelativePath(projectRoot, tsconfigPath),
          details,
          suggestion: "Fix the tsconfig syntax or remove unsupported compiler options.",
        },
      ),
    };
  }

  return { options: parsed.options };
}

export function loadProjectConfig(
  projectRoot: string,
  explicitConfigPath?: string,
  overrideConfig?: ArunaConfig,
): LoadedArunaConfig {
  const diagnostics: ArunaDiagnostic[] = [];
  const configCandidates = explicitConfigPath
    ? [path.resolve(projectRoot, explicitConfigPath), path.resolve(projectRoot, "aruna.config.ts")]
    : [path.resolve(projectRoot, "aruna.config.ts")];

  let loadedConfig: ArunaConfig | undefined;
  let discoveredConfigPath: string | undefined;

  for (const candidate of configCandidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    const loaded = loadUserConfigFile(projectRoot, candidate);
    if (loaded.diagnostic) {
      diagnostics.push(loaded.diagnostic);
      discoveredConfigPath = candidate;
      break;
    }

    loadedConfig = loaded.config;
    discoveredConfigPath = candidate;
    break;
  }

  const merged = mergeConfig(
    DEFAULT_ARUNA_CONFIG,
    loadedConfig ?? {},
  );

  const finalConfig = overrideConfig ? mergeConfig(merged, overrideConfig) : merged;
  const resolvedTsconfig = path.resolve(projectRoot, finalConfig.tsconfig ?? DEFAULT_ARUNA_CONFIG.tsconfig ?? "tsconfig.json");
  const tsconfig = loadTsConfig(projectRoot, resolvedTsconfig);
  if (tsconfig.diagnostic) {
    diagnostics.push(tsconfig.diagnostic);
  }

  return {
    projectRoot,
    configPath: discoveredConfigPath,
    config: finalConfig,
    tsconfigPath: resolvedTsconfig,
    tsconfigOptions: tsconfig.options,
    diagnostics,
  };
}
