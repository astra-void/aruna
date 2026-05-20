import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import * as ts from "typescript";
import type {
  ArunaActionsConfig,
  ArunaCompilerConfig,
  ArunaConfig,
  ArunaConventionConfig,
  ArunaDiagnostic,
  ArunaStrictConfig,
  NormalizedArunaConfig,
} from "@arunajs/core";

export type LoadedArunaConfig = {
  projectRoot: string;
  configPath?: string | undefined;
  config: NormalizedArunaConfig;
  tsconfigPath: string;
  tsconfigOptions: ts.CompilerOptions;
  diagnostics: ArunaDiagnostic[];
};

type RawConfigObject = Record<string, unknown>;
type MutableCompilerManifestConfig = {
  output?: string;
};

type MutableCompilerConfig = {
  generatedDir?: string;
  manifest?: string | MutableCompilerManifestConfig;
  preserveGeneratedComments?: boolean;
};

type MutableActionsConfig = {
  transport?: ArunaActionsConfig["transport"];
  defaultRateLimit?: {
    key?: string;
    windowMs?: number;
    max?: number;
  };
};

type MutableConventionConfig = {
  client?: string[];
  server?: string[];
  shared?: string[];
};

type MutableStrictConfig = {
  sharedSafety?: boolean;
  rawRemoteUsage?: ArunaStrictConfig["rawRemoteUsage"];
  unresolvedImports?: ArunaStrictConfig["unresolvedImports"];
};

type MutableArunaConfig = {
  root?: string;
  compiler?: MutableCompilerConfig;
  actions?: MutableActionsConfig;
  conventions?: MutableConventionConfig;
  strict?: MutableStrictConfig;
};

const DIAGNOSTIC_META: Record<
  "aruna::100" | "aruna::102" | "aruna::103",
  { name: string; severity: ArunaDiagnostic["severity"] }
> = {
  "aruna::100": { name: "invalid-config", severity: "error" },
  "aruna::102": { name: "missing-tsconfig", severity: "warning" },
  "aruna::103": { name: "invalid-tsconfig", severity: "error" },
};

const DEFAULT_CONVENTIONS: Required<Pick<NormalizedArunaConfig["conventions"], "client" | "server" | "shared">> = {
  client: ["**/client/**"],
  server: ["**/server/**"],
  shared: ["**/shared/**"],
};

const DEFAULT_ROOT = "src";
const DEFAULT_GENERATED_DIR = `${DEFAULT_ROOT}/.aruna`;
const DEFAULT_MANIFEST_OUTPUT = `${DEFAULT_GENERATED_DIR}/manifest.json`;
const DEFAULT_RATE_LIMIT: NonNullable<ArunaActionsConfig["defaultRateLimit"]> = {
  key: "player",
  windowMs: 1000,
  max: 20,
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

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isTransport(value: unknown): value is NonNullable<ArunaActionsConfig["transport"]> {
  return value === "remote-event" || value === "remote-function" || value === "memory";
}

function isStrictSeverity(
  value: unknown,
): value is NonNullable<ArunaStrictConfig["rawRemoteUsage"]> {
  return value === "off" || value === "warning" || value === "error";
}

function flatConfigSuggestion(): string {
  return [
    'import { defineConfig } from "aruna";',
    "",
    "export default defineConfig({",
    '  root: "src",',
    "  compiler: {",
    '    generatedDir: "src/.aruna",',
    '    manifest: "src/.aruna/manifest.json",',
    '    preserveGeneratedComments: true,',
    "  },",
    "  actions: {",
    '    transport: "remote-event",',
    "    defaultRateLimit: {",
    '      key: "player",',
    "      windowMs: 1000,",
    "      max: 20,",
    "    },",
    "  },",
    "  conventions: {",
    '    client: ["src/client.tsx", "src/domains/**/ui.tsx"],',
    '    server: ["src/server.ts", "src/domains/**/actions.ts"],',
    '    shared: ["src/shared/**", "src/domains/**/schema.ts", "src/domains/**/model.ts"],',
    "  },",
    "  strict: {",
    "    sharedSafety: true,",
    '    rawRemoteUsage: "warning",',
    '    unresolvedImports: "warning",',
    "  },",
    "});",
  ].join("\n");
}

function mergeStringArray(
  base: readonly string[] | undefined,
  override: readonly string[] | undefined,
): string[] | undefined {
  if (override !== undefined) {
    return [...override];
  }

  if (base !== undefined) {
    return [...base];
  }

  return undefined;
}

function mergeCompilerConfig(
  base: ArunaCompilerConfig | undefined,
  override: ArunaCompilerConfig | undefined,
): ArunaCompilerConfig | undefined {
  if (base === undefined && override === undefined) {
    return undefined;
  }

  return {
    ...base,
    ...override,
  };
}

function mergeActionsConfig(
  base: ArunaActionsConfig | undefined,
  override: ArunaActionsConfig | undefined,
): ArunaActionsConfig | undefined {
  if (base === undefined && override === undefined) {
    return undefined;
  }

  return {
    ...base,
    ...override,
    defaultRateLimit: override?.defaultRateLimit ?? base?.defaultRateLimit,
  };
}

function mergeConventionConfig(
  base: ArunaConventionConfig | undefined,
  override: ArunaConventionConfig | undefined,
): ArunaConventionConfig | undefined {
  if (base === undefined && override === undefined) {
    return undefined;
  }

  return {
    ...base,
    ...override,
    client: mergeStringArray(base?.client, override?.client),
    server: mergeStringArray(base?.server, override?.server),
    shared: mergeStringArray(base?.shared, override?.shared),
  };
}

function mergeStrictConfig(
  base: ArunaStrictConfig | undefined,
  override: ArunaStrictConfig | undefined,
): ArunaStrictConfig | undefined {
  if (base === undefined && override === undefined) {
    return undefined;
  }

  return {
    ...base,
    ...override,
  };
}

function mergePublicConfig(base: ArunaConfig, override: ArunaConfig): ArunaConfig {
  return {
    root: override.root ?? base.root,
    compiler: mergeCompilerConfig(base.compiler, override.compiler),
    actions: mergeActionsConfig(base.actions, override.actions),
    conventions: mergeConventionConfig(base.conventions, override.conventions),
    strict: mergeStrictConfig(base.strict, override.strict),
  };
}

function validateUnsupportedKeys(
  object: RawConfigObject,
  allowedKeys: readonly string[],
  diagnostics: string[],
  prefix: string,
): void {
  for (const key of Object.keys(object)) {
    if (!allowedKeys.includes(key)) {
      diagnostics.push(
        prefix === "top-level config"
          ? `Unsupported top-level config field: ${key}`
          : `Unsupported ${prefix}.${key} field.`,
      );
    }
  }
}

function normalizeConfigObject(value: unknown): {
  config?: ArunaConfig;
  error?: string;
  flatShape?: boolean;
} {
  if (!isRecord(value)) {
    return { error: "configuration module did not export an object" };
  }

  const candidate = value["default"] ?? value;
  if (!isRecord(candidate)) {
    return { error: "configuration module did not export an object" };
  }

  const candidateRecord = candidate as RawConfigObject;
  if (
    candidateRecord["generatedDir"] !== undefined ||
    candidateRecord["manifest"] !== undefined ||
    candidateRecord["source"] !== undefined ||
    candidateRecord["diagnostics"] !== undefined ||
    candidateRecord["security"] !== undefined ||
    candidateRecord["tsconfig"] !== undefined
  ) {
    return {
      flatShape: true,
      error:
        "Flat Aruna config fields are no longer supported. Use defineConfig({ compiler: { generatedDir, manifest }, conventions }).",
    };
  }

  const diagnostics: string[] = [];
  const config: MutableArunaConfig = {};
  const allowedTopLevel = ["root", "compiler", "actions", "conventions", "strict"] as const;
  validateUnsupportedKeys(candidateRecord, allowedTopLevel, diagnostics, "top-level config");

  if (candidateRecord["root"] !== undefined) {
    if (typeof candidateRecord["root"] !== "string") {
      diagnostics.push("root must be a string");
    } else {
      config.root = candidateRecord["root"];
    }
  }

  if (candidateRecord["compiler"] !== undefined) {
    const compilerValue = candidateRecord["compiler"];
    if (!isRecord(compilerValue)) {
      diagnostics.push("compiler must be an object");
    } else {
      validateUnsupportedKeys(compilerValue, ["generatedDir", "manifest", "preserveGeneratedComments"], diagnostics, "compiler");
      const compiler: MutableCompilerConfig = {};

      if (compilerValue["generatedDir"] !== undefined) {
        if (typeof compilerValue["generatedDir"] !== "string") {
          diagnostics.push("compiler.generatedDir must be a string");
        } else {
          compiler.generatedDir = compilerValue["generatedDir"];
        }
      }

      if (compilerValue["manifest"] !== undefined) {
        const manifestValue = compilerValue["manifest"];
        if (typeof manifestValue === "string") {
          compiler.manifest = manifestValue;
        } else if (isRecord(manifestValue)) {
          validateUnsupportedKeys(manifestValue, ["output"], diagnostics, "compiler.manifest");
          const manifest: MutableCompilerManifestConfig = {};
          if (manifestValue["output"] !== undefined) {
            if (typeof manifestValue["output"] !== "string") {
              diagnostics.push("compiler.manifest.output must be a string");
            } else {
              manifest.output = manifestValue["output"];
            }
          }
          compiler.manifest = manifest;
        } else {
          diagnostics.push("compiler.manifest must be a string or an object");
        }
      }

      if (compilerValue["preserveGeneratedComments"] !== undefined) {
        if (typeof compilerValue["preserveGeneratedComments"] !== "boolean") {
          diagnostics.push("compiler.preserveGeneratedComments must be a boolean");
        } else {
          compiler.preserveGeneratedComments = compilerValue["preserveGeneratedComments"];
        }
      }

      config.compiler = compiler;
    }
  }

  if (candidateRecord["actions"] !== undefined) {
    const actionsValue = candidateRecord["actions"];
    if (!isRecord(actionsValue)) {
      diagnostics.push("actions must be an object");
    } else {
      validateUnsupportedKeys(actionsValue, ["transport", "defaultRateLimit"], diagnostics, "actions");
      const actions: MutableActionsConfig = {};

      if (actionsValue["transport"] !== undefined) {
        if (!isTransport(actionsValue["transport"])) {
          diagnostics.push(
            'actions.transport must be one of "remote-event", "remote-function", or "memory"',
          );
        } else {
          actions.transport = actionsValue["transport"];
        }
      }

      if (actionsValue["defaultRateLimit"] !== undefined) {
        const defaultRateLimitValue = actionsValue["defaultRateLimit"];
        if (!isRecord(defaultRateLimitValue)) {
          diagnostics.push("actions.defaultRateLimit must be an object");
        } else {
          validateUnsupportedKeys(
            defaultRateLimitValue,
            ["key", "windowMs", "max"],
            diagnostics,
            "actions.defaultRateLimit",
          );
          const defaultRateLimit = {
            key: "player",
            windowMs: 1000,
            max: 20,
          };

          if (defaultRateLimitValue["key"] !== undefined) {
            if (defaultRateLimitValue["key"] !== "player") {
              diagnostics.push('actions.defaultRateLimit.key must be "player"');
            } else {
              defaultRateLimit.key = "player";
            }
          }

          if (defaultRateLimitValue["windowMs"] !== undefined) {
            if (!isPositiveInteger(defaultRateLimitValue["windowMs"])) {
              diagnostics.push("actions.defaultRateLimit.windowMs must be a positive integer");
            } else {
              defaultRateLimit.windowMs = defaultRateLimitValue["windowMs"];
            }
          }

          if (defaultRateLimitValue["max"] !== undefined) {
            if (!isPositiveInteger(defaultRateLimitValue["max"])) {
              diagnostics.push("actions.defaultRateLimit.max must be a positive integer");
            } else {
              defaultRateLimit.max = defaultRateLimitValue["max"];
            }
          }

          actions.defaultRateLimit = defaultRateLimit;
        }
      }

      config.actions = actions;
    }
  }

  if (candidateRecord["conventions"] !== undefined) {
    const conventionsValue = candidateRecord["conventions"];
    if (!isRecord(conventionsValue)) {
      diagnostics.push("conventions must be an object");
    } else {
      validateUnsupportedKeys(conventionsValue, ["client", "server", "shared"], diagnostics, "conventions");
      const conventions: MutableConventionConfig = {};
      for (const key of ["client", "server", "shared"] as const) {
        const conventionValue = conventionsValue[key];
        if (conventionValue !== undefined) {
          if (!isStringArray(conventionValue)) {
            diagnostics.push(`conventions.${key} must be an array of strings`);
          } else {
            conventions[key] = [...conventionValue];
          }
        }
      }
      config.conventions = conventions;
    }
  }

  if (candidateRecord["strict"] !== undefined) {
    const strictValue = candidateRecord["strict"];
    if (!isRecord(strictValue)) {
      diagnostics.push("strict must be an object");
    } else {
      validateUnsupportedKeys(
        strictValue,
        ["sharedSafety", "rawRemoteUsage", "unresolvedImports"],
        diagnostics,
        "strict",
      );
      const strict: MutableStrictConfig = {};

      if (strictValue["sharedSafety"] !== undefined) {
        if (typeof strictValue["sharedSafety"] !== "boolean") {
          diagnostics.push("strict.sharedSafety must be a boolean");
        } else {
          strict.sharedSafety = strictValue["sharedSafety"];
        }
      }

      if (strictValue["rawRemoteUsage"] !== undefined) {
        if (!isStrictSeverity(strictValue["rawRemoteUsage"])) {
          diagnostics.push('strict.rawRemoteUsage must be one of "off", "warning", or "error"');
        } else {
          strict.rawRemoteUsage = strictValue["rawRemoteUsage"];
        }
      }

      if (strictValue["unresolvedImports"] !== undefined) {
        if (!isStrictSeverity(strictValue["unresolvedImports"])) {
          diagnostics.push(
            'strict.unresolvedImports must be one of "off", "warning", or "error"',
          );
        } else {
          strict.unresolvedImports = strictValue["unresolvedImports"];
        }
      }

      config.strict = strict;
    }
  }

  if (diagnostics.length > 0) {
    return { error: diagnostics.join("; ") };
  }

  return { config: config as ArunaConfig };
}

function normalizeResolvedConfig(config: ArunaConfig): NormalizedArunaConfig {
  const root = config.root ?? DEFAULT_ROOT;
  const generatedDir = config.compiler?.generatedDir ?? `${root}/.aruna`;
  const manifestOutput =
    typeof config.compiler?.manifest === "string"
      ? config.compiler.manifest
      : config.compiler?.manifest?.output ?? `${generatedDir}/manifest.json`;
  const defaultRateLimit = config.actions?.defaultRateLimit ?? DEFAULT_RATE_LIMIT;

  return {
    root,
    generatedDir,
    manifestOutput,
    compiler: {
      preserveGeneratedComments: config.compiler?.preserveGeneratedComments ?? true,
    },
    actions: {
      transport: config.actions?.transport ?? "remote-event",
      defaultRateLimit: {
        key: defaultRateLimit.key,
        windowMs: defaultRateLimit.windowMs,
        max: defaultRateLimit.max,
      },
    },
    conventions: {
      client: mergeStringArray(DEFAULT_CONVENTIONS.client, config.conventions?.client) ?? [...DEFAULT_CONVENTIONS.client],
      server: mergeStringArray(DEFAULT_CONVENTIONS.server, config.conventions?.server) ?? [...DEFAULT_CONVENTIONS.server],
      shared: mergeStringArray(DEFAULT_CONVENTIONS.shared, config.conventions?.shared) ?? [...DEFAULT_CONVENTIONS.shared],
    },
    strict: {
      sharedSafety: config.strict?.sharedSafety ?? true,
      rawRemoteUsage: config.strict?.rawRemoteUsage ?? "warning",
      unresolvedImports: config.strict?.unresolvedImports ?? "warning",
    },
  };
}

function evaluateCommonJs(sourceText: string, filename: string): unknown {
  const requireForConfig = createRequire(filename);
  const defineConfig = (config: unknown): unknown => config;
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
    require(specifier: string) {
      if (specifier === "aruna" || specifier === "aruna/config") {
        return {
          __esModule: true,
          defineConfig,
          default: {
            defineConfig,
          },
        };
      }

      return requireForConfig(specifier);
    },
    __filename: filename,
    __dirname: path.dirname(filename),
  };
  const script = new vm.Script(transformed.outputText, { filename });
  const context = vm.createContext(sandbox);
  script.runInContext(context);
  return module.exports;
}

function loadUserConfigFile(
  projectRoot: string,
  configFile: string,
): {
  config?: ArunaConfig;
  diagnostic?: ArunaDiagnostic;
} {
  try {
    const sourceText = fs.readFileSync(configFile, "utf8");
    const evaluated = evaluateCommonJs(sourceText, configFile);
    const normalized = normalizeConfigObject(evaluated);
    if (normalized.error) {
      const message = normalized.flatShape
        ? normalized.error
        : `Invalid Aruna configuration in ${path.basename(configFile)}.`;
      return {
        diagnostic: createDiagnostic("aruna::100", message, {
          file: formatProjectRelativePath(projectRoot, configFile),
          details: normalized.flatShape ? undefined : normalized.error,
          suggestion: normalized.flatShape ? flatConfigSuggestion() : undefined,
        }),
      };
    }

    return { config: normalized.config as ArunaConfig };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      diagnostic: createDiagnostic("aruna::100", `Failed to load ${path.basename(configFile)}.`, {
        file: formatProjectRelativePath(projectRoot, configFile),
        details: message,
        suggestion: "Fix the configuration file syntax or export shape.",
      }),
    };
  }
}

function loadTsConfig(
  projectRoot: string,
  tsconfigPath: string,
): {
  options: ts.CompilerOptions;
  diagnostic?: ArunaDiagnostic;
} {
  const invalidTsconfigDiagnostic = (details: string): ArunaDiagnostic =>
    createDiagnostic(
      "aruna::103",
      `Malformed TypeScript config at ${path.basename(tsconfigPath)}.`,
      {
        file: formatProjectRelativePath(projectRoot, tsconfigPath),
        details,
        suggestion: "Fix the tsconfig JSON syntax or use a supported top-level object shape.",
      },
    );

  if (!fs.existsSync(tsconfigPath)) {
    return {
      options: {},
      diagnostic: createDiagnostic(
        "aruna::102",
        `Missing TypeScript config at ${path.basename(tsconfigPath)}.`,
        {
          file: formatProjectRelativePath(projectRoot, tsconfigPath),
          details:
            "Aruna looked for the TypeScript config at the resolved path but could not find it.",
          suggestion: "Create tsconfig.json or point aruna.config.ts to an existing tsconfig file.",
        },
      ),
    };
  }

  const result = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (result.error) {
    return {
      options: {},
      diagnostic: invalidTsconfigDiagnostic("tsconfig.json could not be parsed as valid JSON."),
    };
  }

  if (typeof result.config !== "object" || result.config === null || Array.isArray(result.config)) {
    return {
      options: {},
      diagnostic: invalidTsconfigDiagnostic(
        "tsconfig.json must contain a JSON object at the top level.",
      ),
    };
  }

  const parsed = ts.parseJsonConfigFileContent(result.config, ts.sys, path.dirname(tsconfigPath));
  if (parsed.errors.length > 0) {
    return {
      options: {},
      diagnostic: invalidTsconfigDiagnostic(
        "tsconfig.json uses an unsupported object shape or compiler option.",
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

  const mergedConfig: ArunaConfig = overrideConfig
    ? mergePublicConfig(loadedConfig ?? ({} as ArunaConfig), overrideConfig)
    : (loadedConfig ?? ({} as ArunaConfig));
  const finalConfig = normalizeResolvedConfig(mergedConfig);
  const resolvedTsconfig = path.resolve(projectRoot, "tsconfig.json");
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
