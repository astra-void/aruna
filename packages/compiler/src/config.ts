import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import * as ts from "typescript";
import type {
  ActionsConfig,
  CompilerConfig,
  Config,
  ConventionConfig,
  DevConfig,
  Diagnostic,
  EntriesMode,
  StrictConfig,
  NormalizedConfig,
} from "@arunajs/core";

// The resolved `dev` section. Not part of NormalizedConfig — that type is the
// compiler contract (it crosses into the native compiler), and `dev` only
// drives the CLI's `aruna dev` process orchestration.
export type NormalizedDevConfig = {
  readonly rojo: boolean;
  readonly rojoPort: number | undefined;
};

export type LoadedConfig = {
  projectRoot: string;
  configPath?: string | undefined;
  config: NormalizedConfig;
  dev: NormalizedDevConfig;
  tsconfigPath: string;
  tsconfigOptions: ts.CompilerOptions;
  diagnostics: Diagnostic[];
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
  defaultRateLimit?: {
    key?: string;
    windowMs?: number;
    max?: number;
  };
};

type MutableConventionConfig = {
  defaults?: boolean;
  client?: string[];
  server?: string[];
  shared?: string[];
};

type MutableStrictConfig = {
  sharedSafety?: boolean;
  rawRemoteUsage?: StrictConfig["rawRemoteUsage"];
  unresolvedImports?: StrictConfig["unresolvedImports"];
};

type MutableDevConfig = {
  rojo?: boolean | { port?: number };
};

type MutableConfig = {
  root?: string;
  entries?: EntriesMode;
  compiler?: MutableCompilerConfig;
  actions?: MutableActionsConfig;
  conventions?: MutableConventionConfig;
  strict?: MutableStrictConfig;
  dev?: MutableDevConfig;
};

const DIAGNOSTIC_META: Record<
  "aruna::100" | "aruna::102" | "aruna::103",
  { name: string; severity: Diagnostic["severity"] }
> = {
  "aruna::100": { name: "invalid-config", severity: "error" },
  "aruna::102": { name: "missing-tsconfig", severity: "warning" },
  "aruna::103": { name: "invalid-tsconfig", severity: "error" },
};

// Recommended Layout v0 defaults; must stay in sync with
// `ConventionSet::for_root` in crates/aruna_compiler/src/module_kind.rs.
// Directory conventions beat file-name conventions when they disagree.
//
// `**/signals.ts` is shared for a structural reason, not a stylistic one: the
// generated signal registry is emitted into the shared partition and imports
// each definition from the file that declared it, so a signal declared in a
// server-classified file cannot resolve from the client.
function defaultConventionsForRoot(
  root: string,
): Required<Pick<NormalizedConfig["conventions"], "client" | "server" | "shared">> {
  return {
    client: ["**/client/**", "**/ui.tsx"],
    server: ["**/server/**", "**/actions.ts", "**/runtime.ts"],
    shared: ["**/shared/**", `${root}/app/**`, "**/schema.ts", "**/model.ts", "**/signals.ts"],
  };
}

// User conventions extend the defaults instead of replacing them: supplying one
// extra glob used to silently drop every default in that kind, which is the
// single most repeated shape in real aruna.config.ts files (restating 8+ globs
// to add one). `conventions.defaults: false` restores replace semantics.
function resolveConventionPatterns(
  defaults: readonly string[],
  overrides: readonly string[] | undefined,
  useDefaults: boolean,
): string[] {
  if (!useDefaults) {
    return [...(overrides ?? [])];
  }
  return [...new Set([...defaults, ...(overrides ?? [])])];
}

const DEFAULT_ROOT = "src";
const DEFAULT_GENERATED_DIR = `${DEFAULT_ROOT}/.aruna`;
const DEFAULT_MANIFEST_OUTPUT = `${DEFAULT_GENERATED_DIR}/manifest.json`;
const DEFAULT_RATE_LIMIT: NonNullable<ActionsConfig["defaultRateLimit"]> = {
  key: "player",
  windowMs: 1000,
  max: 20,
};

function createDiagnostic(
  code: keyof typeof DIAGNOSTIC_META,
  message: string,
  extras: Partial<Diagnostic> = {},
): Diagnostic {
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

function isEntriesMode(value: unknown): value is EntriesMode {
  return value === "user" || value === "generated";
}

function isStrictSeverity(
  value: unknown,
): value is NonNullable<StrictConfig["rawRemoteUsage"]> {
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
    "    preserveGeneratedComments: true,",
    "  },",
    "  actions: {",
    "    defaultRateLimit: {",
    '      key: "player",',
    "      windowMs: 1000,",
    "      max: 20,",
    "    },",
    "  },",
    "  // Only the globs the built-in conventions do not already cover.",
    "  conventions: {",
    '    shared: ["src/domains/**/policy.ts"],',
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
  base: CompilerConfig | undefined,
  override: CompilerConfig | undefined,
): CompilerConfig | undefined {
  if (base === undefined && override === undefined) {
    return undefined;
  }

  return {
    ...base,
    ...override,
  };
}

function mergeActionsConfig(
  base: ActionsConfig | undefined,
  override: ActionsConfig | undefined,
): ActionsConfig | undefined {
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
  base: ConventionConfig | undefined,
  override: ConventionConfig | undefined,
): ConventionConfig | undefined {
  if (base === undefined && override === undefined) {
    return undefined;
  }

  return {
    ...base,
    ...override,
    defaults: override?.defaults ?? base?.defaults,
    client: mergeStringArray(base?.client, override?.client),
    server: mergeStringArray(base?.server, override?.server),
    shared: mergeStringArray(base?.shared, override?.shared),
  };
}

function mergeStrictConfig(
  base: StrictConfig | undefined,
  override: StrictConfig | undefined,
): StrictConfig | undefined {
  if (base === undefined && override === undefined) {
    return undefined;
  }

  return {
    ...base,
    ...override,
  };
}

function mergeDevConfig(
  base: DevConfig | undefined,
  override: DevConfig | undefined,
): DevConfig | undefined {
  if (base === undefined && override === undefined) {
    return undefined;
  }

  return {
    ...base,
    ...override,
  };
}

function mergePublicConfig(base: Config, override: Config): Config {
  return {
    root: override.root ?? base.root,
    entries: override.entries ?? base.entries,
    compiler: mergeCompilerConfig(base.compiler, override.compiler),
    actions: mergeActionsConfig(base.actions, override.actions),
    conventions: mergeConventionConfig(base.conventions, override.conventions),
    strict: mergeStrictConfig(base.strict, override.strict),
    dev: mergeDevConfig(base.dev, override.dev),
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
  config?: Config;
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
  const config: MutableConfig = {};
  const allowedTopLevel = [
    "root",
    "entries",
    "compiler",
    "actions",
    "conventions",
    "strict",
    "dev",
  ] as const;
  validateUnsupportedKeys(candidateRecord, allowedTopLevel, diagnostics, "top-level config");

  if (candidateRecord["root"] !== undefined) {
    if (typeof candidateRecord["root"] !== "string") {
      diagnostics.push("root must be a string");
    } else {
      config.root = candidateRecord["root"];
    }
  }

  if (candidateRecord["entries"] !== undefined) {
    if (!isEntriesMode(candidateRecord["entries"])) {
      diagnostics.push('entries must be "user" or "generated"');
    } else {
      config.entries = candidateRecord["entries"];
    }
  }

  if (candidateRecord["compiler"] !== undefined) {
    const compilerValue = candidateRecord["compiler"];
    if (!isRecord(compilerValue)) {
      diagnostics.push("compiler must be an object");
    } else {
      validateUnsupportedKeys(
        compilerValue,
        ["generatedDir", "manifest", "preserveGeneratedComments"],
        diagnostics,
        "compiler",
      );
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
      validateUnsupportedKeys(
        actionsValue,
        ["transport", "defaultRateLimit"],
        diagnostics,
        "actions",
      );
      const actions: MutableActionsConfig = {};

      if (actionsValue["transport"] !== undefined) {
        diagnostics.push(
          "actions.transport has been removed; Aruna always uses the RemoteEvent transport. Delete the field.",
        );
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
          const defaultRateLimit: { key: "player" | "global"; windowMs: number; max: number } = {
            key: "player",
            windowMs: 1000,
            max: 20,
          };

          if (defaultRateLimitValue["key"] !== undefined) {
            const keyValue = defaultRateLimitValue["key"];
            if (keyValue !== "player" && keyValue !== "global") {
              diagnostics.push('actions.defaultRateLimit.key must be "player" or "global"');
            } else {
              defaultRateLimit.key = keyValue;
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
      validateUnsupportedKeys(
        conventionsValue,
        ["defaults", "client", "server", "shared"],
        diagnostics,
        "conventions",
      );
      const conventions: MutableConventionConfig = {};
      if (conventionsValue["defaults"] !== undefined) {
        if (typeof conventionsValue["defaults"] !== "boolean") {
          diagnostics.push("conventions.defaults must be a boolean");
        } else {
          conventions.defaults = conventionsValue["defaults"];
        }
      }
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
          diagnostics.push('strict.unresolvedImports must be one of "off", "warning", or "error"');
        } else {
          strict.unresolvedImports = strictValue["unresolvedImports"];
        }
      }

      config.strict = strict;
    }
  }

  if (candidateRecord["dev"] !== undefined) {
    const devValue = candidateRecord["dev"];
    if (!isRecord(devValue)) {
      diagnostics.push("dev must be an object");
    } else {
      validateUnsupportedKeys(devValue, ["rojo"], diagnostics, "dev");
      const dev: MutableDevConfig = {};

      if (devValue["rojo"] !== undefined) {
        const rojoValue = devValue["rojo"];
        if (typeof rojoValue === "boolean") {
          dev.rojo = rojoValue;
        } else if (isRecord(rojoValue)) {
          validateUnsupportedKeys(rojoValue, ["port"], diagnostics, "dev.rojo");
          if (rojoValue["port"] !== undefined && !isPositiveInteger(rojoValue["port"])) {
            diagnostics.push("dev.rojo.port must be a positive integer");
          } else {
            dev.rojo = {
              ...(rojoValue["port"] !== undefined ? { port: rojoValue["port"] as number } : {}),
            };
          }
        } else {
          diagnostics.push("dev.rojo must be a boolean or an object with a port");
        }
      }

      config.dev = dev;
    }
  }

  if (diagnostics.length > 0) {
    return { error: diagnostics.join("; ") };
  }

  return { config: config as Config };
}

// `{ port }` implies the child is wanted, so only an explicit `false` disables it.
export function normalizeDevConfig(dev: DevConfig | undefined): NormalizedDevConfig {
  const rojo = dev?.rojo;
  if (rojo === false) {
    return { rojo: false, rojoPort: undefined };
  }
  return {
    rojo: true,
    rojoPort: typeof rojo === "object" && rojo !== null ? rojo.port : undefined,
  };
}

function normalizeResolvedConfig(config: Config): NormalizedConfig {
  const root = config.root ?? DEFAULT_ROOT;
  const defaultConventions = defaultConventionsForRoot(root);
  const generatedDir = config.compiler?.generatedDir ?? `${root}/.aruna`;
  const manifestOutput =
    typeof config.compiler?.manifest === "string"
      ? config.compiler.manifest
      : (config.compiler?.manifest?.output ?? `${generatedDir}/manifest.json`);
  const defaultRateLimit = config.actions?.defaultRateLimit ?? DEFAULT_RATE_LIMIT;
  const useConventionDefaults = config.conventions?.defaults ?? true;

  return {
    root,
    generatedDir,
    manifestOutput,
    entries: config.entries ?? "user",
    compiler: {
      preserveGeneratedComments: config.compiler?.preserveGeneratedComments ?? true,
    },
    actions: {
      defaultRateLimit: {
        key: defaultRateLimit.key,
        windowMs: defaultRateLimit.windowMs,
        max: defaultRateLimit.max,
      },
    },
    conventions: {
      client: resolveConventionPatterns(
        defaultConventions.client,
        config.conventions?.client,
        useConventionDefaults,
      ),
      server: resolveConventionPatterns(
        defaultConventions.server,
        config.conventions?.server,
        useConventionDefaults,
      ),
      shared: resolveConventionPatterns(
        defaultConventions.shared,
        config.conventions?.shared,
        useConventionDefaults,
      ),
    },
    // The project's own globs, kept apart from the merged set so the compiler
    // can let them outrank the defaults instead of competing with them on
    // pattern shape alone.
    conventionOverrides: {
      client: [...(config.conventions?.client ?? [])],
      server: [...(config.conventions?.server ?? [])],
      shared: [...(config.conventions?.shared ?? [])],
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
  config?: Config;
  diagnostic?: Diagnostic;
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

    return { config: normalized.config as Config };
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
  diagnostic?: Diagnostic;
} {
  const invalidTsconfigDiagnostic = (details: string): Diagnostic =>
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
  // A missing generated Aruna fragment (`extends: ./<generatedDir>/tsconfig.aruna.json`)
  // is a self-healing state, not a broken tsconfig: `aruna build` / `aruna doctor
  // --fix` write the fragment. Failing here would deadlock a fresh clone whose
  // generated dir is not committed. Name kept in sync with
  // ARUNA_TSCONFIG_FRAGMENT_FILE in packages/aruna/src/cli/tsconfig-paths.ts.
  // TS 5083 "Cannot read file" / 6053 "File not found" for the extends target.
  //
  // TS 18003 ("No inputs were found") is likewise not a malformed tsconfig: a
  // freshly scaffolded project has no source files yet, and this loader only
  // reads compilerOptions — which files the program includes is none of its
  // business.
  const fatalErrors = parsed.errors.filter((error) => {
    if (error.code === 18003) {
      return false;
    }
    const text = ts.flattenDiagnosticMessageText(error.messageText, " ");
    return !((error.code === 5083 || error.code === 6053) && text.includes("tsconfig.aruna.json"));
  });
  if (fatalErrors.length > 0) {
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
  overrideConfig?: Config,
): LoadedConfig {
  const diagnostics: Diagnostic[] = [];
  const configCandidates = explicitConfigPath
    ? [path.resolve(projectRoot, explicitConfigPath), path.resolve(projectRoot, "aruna.config.ts")]
    : [path.resolve(projectRoot, "aruna.config.ts")];

  let loadedConfig: Config | undefined;
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

  const mergedConfig: Config = overrideConfig
    ? mergePublicConfig(loadedConfig ?? ({} as Config), overrideConfig)
    : (loadedConfig ?? ({} as Config));
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
    dev: normalizeDevConfig(mergedConfig.dev),
    tsconfigPath: resolvedTsconfig,
    tsconfigOptions: tsconfig.options,
    diagnostics,
  };
}
