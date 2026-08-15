import path from "node:path";

export const ARUNA_ACTION_PATHS = {
  client: "$aruna/actions/client",
  server: "$aruna/actions/server",
} as const;

// Split-tree generated layout (relative to the configured generatedDir). The
// server action registry imports server implementations, so it lands in a
// `server/` subtree that maps to a server-only Rojo mount; the client stubs, the
// signal registry, and the vendored runtime are replication-safe and land in a
// `shared/` subtree. Mirrors the Rust resolver/codegen constants — keep in sync.
const GENERATED_CLIENT_ACTIONS_FILE = "shared/actions.client.generated.ts";
const GENERATED_SERVER_ACTIONS_FILE = "server/actions.server.generated.ts";
const GENERATED_SIGNALS_FILE = "shared/signals.generated.ts";
// The vendored runtime is replication-safe, so it lands under the shared subtree.
export const GENERATED_RUNTIME_DIR = "shared/runtime";

// The generated signal registry virtual module. Installed alongside the action
// aliases so `import { signals } from "$aruna/signals"` resolves under tsc and
// rbxtsc; the compiler resolves the same specifier virtually. Points at the
// generated file, which only exists once a project declares signals — an unused
// mapping to a missing file is harmless (tsc path mappings resolve lazily).
export const ARUNA_SIGNALS_ALIAS = "$aruna/signals";

export function resolveArunaSignalPaths(
  tsconfigPath: string,
  generatedDir: string,
): Record<string, string[]> {
  const tsconfigDir = path.dirname(tsconfigPath);
  const target = path
    .relative(tsconfigDir, path.resolve(tsconfigDir, generatedDir, GENERATED_SIGNALS_FILE))
    .split(path.sep)
    .join("/");
  return { [ARUNA_SIGNALS_ALIAS]: [target] };
}

export type ArunaActionPathKey = keyof typeof ARUNA_ACTION_PATHS;

export type ArunaActionPathMap = Record<ArunaActionPathKey, string[]>;

export type TsconfigEditResult = {
  changed: boolean;
  contents: string;
};

export type TsconfigEditOptions = {
  baseUrl?: string | undefined;
  requireBaseUrl?: boolean | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePathList(values: unknown): string[] | undefined {
  if (!Array.isArray(values) || !values.every((entry) => typeof entry === "string")) {
    return undefined;
  }

  return values.map((entry) => entry.split(path.sep).join("/"));
}

export function resolveArunaActionPaths(
  tsconfigPath: string,
  generatedDir: string,
): ArunaActionPathMap {
  const tsconfigDir = path.dirname(tsconfigPath);
  const clientPath = path
    .relative(
      tsconfigDir,
      path.resolve(path.dirname(tsconfigPath), generatedDir, GENERATED_CLIENT_ACTIONS_FILE),
    )
    .split(path.sep)
    .join("/");
  const serverPath = path
    .relative(
      tsconfigDir,
      path.resolve(path.dirname(tsconfigPath), generatedDir, GENERATED_SERVER_ACTIONS_FILE),
    )
    .split(path.sep)
    .join("/");

  return {
    client: [clientPath],
    server: [serverPath],
  };
}

export function inspectArunaActionPaths(
  tsconfig: unknown,
  expected: ArunaActionPathMap,
): {
  compilerOptions: Record<string, unknown> | undefined;
  paths: Record<string, unknown> | undefined;
  current: Partial<ArunaActionPathMap>;
  status: Record<ArunaActionPathKey, "missing" | "correct" | "incorrect">;
  hasBaseUrl: boolean;
} {
  if (!isRecord(tsconfig)) {
    return {
      compilerOptions: undefined,
      paths: undefined,
      current: {},
      status: {
        client: "missing",
        server: "missing",
      },
      hasBaseUrl: false,
    };
  }

  const compilerOptions = isRecord(tsconfig["compilerOptions"])
    ? tsconfig["compilerOptions"]
    : undefined;
  const paths =
    compilerOptions && isRecord(compilerOptions["paths"]) ? compilerOptions["paths"] : undefined;
  const current: Partial<ArunaActionPathMap> = {};
  const status: Record<ArunaActionPathKey, "missing" | "correct" | "incorrect"> = {
    client: "missing",
    server: "missing",
  };

  for (const key of Object.keys(ARUNA_ACTION_PATHS) as ArunaActionPathKey[]) {
    const normalized = normalizePathList(paths?.[ARUNA_ACTION_PATHS[key]]);
    if (!normalized) {
      continue;
    }

    current[key] = normalized;
    status[key] =
      normalized.length === expected[key].length &&
      normalized.every((entry, index) => entry === expected[key][index])
        ? "correct"
        : "incorrect";
  }

  return {
    compilerOptions,
    paths,
    current,
    status,
    hasBaseUrl: compilerOptions?.["baseUrl"] !== undefined,
  };
}

// Roblox-facing runtime modules vendored into `<generatedDir>/shared/runtime/`
// by `aruna build --emit-runtime`. The bare `aruna/<name>` subpaths are aliased to
// those project-source files so roblox-ts compiles them instead of rejecting a
// `node_modules` package import.
export const ARUNA_RUNTIME_MODULES = ["client", "server", "roblox", "schema"] as const;

export function resolveArunaRuntimePaths(
  tsconfigPath: string,
  generatedDir: string,
): Record<string, string[]> {
  const tsconfigDir = path.dirname(tsconfigPath);
  const result: Record<string, string[]> = {};
  for (const moduleName of ARUNA_RUNTIME_MODULES) {
    const target = path
      .relative(
        tsconfigDir,
        path.resolve(tsconfigDir, generatedDir, GENERATED_RUNTIME_DIR, `${moduleName}.ts`),
      )
      .split(path.sep)
      .join("/");
    result[`aruna/${moduleName}`] = [target];
  }
  return result;
}

// Matches the bare `aruna/<name>` runtime subpath aliases. Deliberately
// excludes the `$aruna/...` action/signal virtual-module aliases (those start
// with `$`), so pruning never touches them.
const ARUNA_RUNTIME_ALIAS_PATTERN = /^aruna\//;

// ---------------------------------------------------------------------------
// Generated tsconfig fragment
//
// `aruna build` emits `<generatedDir>/tsconfig.aruna.json` holding every
// aruna-owned path alias. A project references it once via `extends` and then
// codegen-layout changes can never desync its tsconfig again — the fragment is
// regenerated with the layout. Projects that keep their own inline
// `compilerOptions.paths` shadow the fragment wholesale (TS `extends`
// semantics), which doctor/check surface as aruna::112.
// ---------------------------------------------------------------------------

export const ARUNA_TSCONFIG_FRAGMENT_FILE = "tsconfig.aruna.json";

// The complete aruna-owned alias map (actions + signals + vendored runtime),
// with targets relative to `tsconfigPath`'s directory. This is the single
// source of truth shared by the fragment, doctor's inline realignment, and
// init scaffolding.
export function resolveAllArunaAliasPaths(
  tsconfigPath: string,
  generatedDir: string,
): Record<string, string[]> {
  const actionPaths = resolveArunaActionPaths(tsconfigPath, generatedDir);
  return {
    [ARUNA_ACTION_PATHS.client]: actionPaths.client,
    [ARUNA_ACTION_PATHS.server]: actionPaths.server,
    ...resolveArunaSignalPaths(tsconfigPath, generatedDir),
    ...resolveArunaRuntimePaths(tsconfigPath, generatedDir),
  };
}

// True for alias keys owned by Aruna: the `$aruna/...` virtual modules and the
// bare `aruna/<name>` runtime subpaths.
export function isArunaOwnedAlias(alias: string): boolean {
  return alias.startsWith("$aruna/") || ARUNA_RUNTIME_ALIAS_PATTERN.test(alias);
}

// The roblox-ts compile contract every Aruna project needs and nobody chooses:
// the module/target/lib triple rbxtsc requires, the @rbxts type roots, and the
// src -> out layout. It used to be ~40 hand-copied lines in each consumer's
// tsconfig, where it could drift silently from what the staged build actually
// compiles with. Values are the project's to override — TypeScript's `extends`
// gives the child the last word on every key here.
//
// `rootDir`/`outDir`/`typeRoots`/`include`/`exclude` are written relative to
// the fragment's own directory, which is how TypeScript resolves paths in an
// extended config.
function arunaTsconfigBase(upToRoot: string): {
  compilerOptions: Record<string, unknown>;
  include: string[];
  exclude: string[];
} {
  return {
    compilerOptions: {
      target: "ESNext",
      module: "CommonJS",
      moduleResolution: "Node",
      moduleDetection: "force",
      strict: true,
      noLib: true,
      // @rbxts/types ships ambient declarations that only typecheck under the
      // exact compiler-types they were generated against; skipLibCheck keeps a
      // point release of the types package from breaking consumer typechecks.
      skipLibCheck: true,
      rootDir: `${upToRoot}/src`,
      outDir: `${upToRoot}/out`,
      jsx: "preserve",
      declaration: false,
      downlevelIteration: true,
      allowSyntheticDefaultImports: true,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
      noUncheckedIndexedAccess: true,
      verbatimModuleSyntax: false,
      typeRoots: [`${upToRoot}/node_modules`, `${upToRoot}/node_modules/@rbxts`],
      types: ["@rbxts/types", "@rbxts/compiler-types"],
    },
    // The generated dir is named explicitly: TypeScript's wildcard globs skip
    // dot-prefixed directories, so `src/**/*` alone would leave the generated
    // entry scripts (entries: "generated") out of the program — `aruna check`
    // and the IDE would never typecheck them. Mirrors the staged include that
    // `aruna build` compiles against (stagedIncludeGlobs in rojo-layout.ts).
    include: [`${upToRoot}/src/**/*.ts`, `${upToRoot}/src/**/*.tsx`, "**/*.ts", "**/*.tsx"],
    exclude: [`${upToRoot}/aruna.config.ts`, `${upToRoot}/out`, `${upToRoot}/node_modules`],
  };
}

// Contents of the generated fragment: the roblox-ts compile contract plus every
// aruna-owned path alias. `baseUrl` re-anchors the fragment at the project
// root, so its `paths` targets are byte-identical to the ones doctor would
// install inline in the root tsconfig.
export function arunaTsconfigFragmentContents(projectRoot: string, generatedDir: string): string {
  const rootTsconfigPath = path.join(projectRoot, "tsconfig.json");
  const fragmentDir = path.resolve(projectRoot, generatedDir);
  const baseUrl = (path.relative(fragmentDir, projectRoot) || ".").split(path.sep).join("/");
  const base = arunaTsconfigBase(baseUrl);
  const fragment = {
    compilerOptions: {
      ...base.compilerOptions,
      baseUrl,
      paths: resolveAllArunaAliasPaths(rootTsconfigPath, generatedDir),
    },
    include: base.include,
    exclude: base.exclude,
  };
  const json = JSON.stringify(fragment, null, 2);
  // tsconfig files are JSONC, so a human-facing header comment is safe for the
  // TypeScript config loader (and for rbxtsc, which uses it).
  return `${json.replace(
    /^\{/,
    "{\n  // Generated by Aruna. Do not edit - `aruna build` rewrites this file.",
  )}\n`;
}

// The `extends` value a root tsconfig uses to reference the fragment.
export function arunaTsconfigExtendsRef(tsconfigPath: string, generatedDir: string): string {
  const tsconfigDir = path.dirname(tsconfigPath);
  const target = path
    .relative(tsconfigDir, path.resolve(tsconfigDir, generatedDir, ARUNA_TSCONFIG_FRAGMENT_FILE))
    .split(path.sep)
    .join("/");
  return target.startsWith(".") ? target : `./${target}`;
}

function normalizeExtendsEntry(entry: string): string {
  const posix = entry.split(path.sep).join("/");
  return posix.startsWith("./") ? posix.slice(2) : posix;
}

// The tsconfig's `extends` entries as a list ("extends" may be a string or,
// since TS 5.0, an array).
export function tsconfigExtendsList(tsconfig: unknown): string[] {
  if (!isRecord(tsconfig)) {
    return [];
  }
  const value = tsconfig["extends"];
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

export function extendsIncludesFragment(tsconfig: unknown, fragmentRef: string): boolean {
  const expected = normalizeExtendsEntry(fragmentRef);
  return tsconfigExtendsList(tsconfig).some((entry) => normalizeExtendsEntry(entry) === expected);
}

// Appends the fragment reference to `extends`, converting a string form to the
// TS 5.0 array form when needed. The fragment goes last so its aliases win
// over any base config's. Mutates `tsconfig`; returns whether it changed.
export function addFragmentToExtends(
  tsconfig: Record<string, unknown>,
  fragmentRef: string,
): boolean {
  if (extendsIncludesFragment(tsconfig, fragmentRef)) {
    return false;
  }
  const current = tsconfig["extends"];
  if (current === undefined) {
    tsconfig["extends"] = fragmentRef;
  } else if (typeof current === "string") {
    tsconfig["extends"] = [current, fragmentRef];
  } else if (Array.isArray(current)) {
    tsconfig["extends"] = [...current, fragmentRef];
  } else {
    throw new Error("tsconfig extends must be a string or an array of strings.");
  }
  return true;
}

export type RuntimePathUpdateOptions = {
  // When true, any existing `aruna/<name>` alias that is NOT one of the keys in
  // `aliasPaths` is removed. Enables `aruna doctor --fix --emit-runtime` to drop
  // stale runtime aliases left behind when the set of public entry points shrinks
  // (e.g. the 8 -> 4 consolidation). Only set this when the caller is managing the
  // runtime aliases — the signal-alias call leaves it off so it never prunes.
  pruneStaleRuntimeAliases?: boolean | undefined;
};

// Merges an arbitrary alias -> target-paths map into compilerOptions.paths,
// mutating `tsconfig` in place. Used for the runtime aliases alongside the
// action aliases so both land in a single tsconfig write.
export function updateArunaRuntimePaths(
  tsconfig: unknown,
  aliasPaths: Record<string, string[]>,
  options: RuntimePathUpdateOptions = {},
): TsconfigEditResult {
  if (!isRecord(tsconfig)) {
    throw new Error("tsconfig must contain a top-level JSON object.");
  }
  if (tsconfig["compilerOptions"] !== undefined && !isRecord(tsconfig["compilerOptions"])) {
    throw new Error("compilerOptions must be a JSON object.");
  }
  const compilerOptions = isRecord(tsconfig["compilerOptions"])
    ? tsconfig["compilerOptions"]
    : (tsconfig["compilerOptions"] = {});
  if (compilerOptions["paths"] !== undefined && !isRecord(compilerOptions["paths"])) {
    throw new Error("compilerOptions.paths must be a JSON object.");
  }
  const paths = isRecord(compilerOptions["paths"])
    ? compilerOptions["paths"]
    : (compilerOptions["paths"] = {});

  let changed = false;
  for (const [alias, desired] of Object.entries(aliasPaths)) {
    const current = normalizePathList(paths[alias]);
    const matches =
      current !== undefined &&
      current.length === desired.length &&
      current.every((entry, index) => entry === desired[index]);
    if (!matches) {
      paths[alias] = [...desired];
      changed = true;
    }
  }

  if (options.pruneStaleRuntimeAliases === true) {
    const expected = new Set(Object.keys(aliasPaths));
    for (const alias of Object.keys(paths)) {
      if (ARUNA_RUNTIME_ALIAS_PATTERN.test(alias) && !expected.has(alias)) {
        delete paths[alias];
        changed = true;
      }
    }
  }

  return {
    changed,
    contents: `${JSON.stringify(tsconfig, null, 2)}\n`,
  };
}

export function updateArunaActionPaths(
  tsconfig: unknown,
  expected: ArunaActionPathMap,
  options: TsconfigEditOptions = {},
): TsconfigEditResult {
  if (!isRecord(tsconfig)) {
    throw new Error("tsconfig must contain a top-level JSON object.");
  }

  if (tsconfig["compilerOptions"] !== undefined && !isRecord(tsconfig["compilerOptions"])) {
    throw new Error("compilerOptions must be a JSON object.");
  }
  const compilerOptions = isRecord(tsconfig["compilerOptions"])
    ? tsconfig["compilerOptions"]
    : (tsconfig["compilerOptions"] = {});

  if (options.requireBaseUrl === true) {
    if (
      compilerOptions["baseUrl"] !== undefined &&
      typeof compilerOptions["baseUrl"] !== "string"
    ) {
      throw new Error("compilerOptions.baseUrl must be a string.");
    }
    if (compilerOptions["baseUrl"] === undefined) {
      compilerOptions["baseUrl"] = options.baseUrl ?? ".";
    }
  }

  if (compilerOptions["paths"] !== undefined && !isRecord(compilerOptions["paths"])) {
    throw new Error("compilerOptions.paths must be a JSON object.");
  }
  const paths = isRecord(compilerOptions["paths"])
    ? compilerOptions["paths"]
    : (compilerOptions["paths"] = {});

  let changed = false;
  for (const key of Object.keys(expected) as ArunaActionPathKey[]) {
    const alias = ARUNA_ACTION_PATHS[key];
    const current = normalizePathList(paths[alias]);
    const desired = expected[key];
    const matches =
      current !== undefined &&
      current.length === desired.length &&
      current.every((entry, index) => entry === desired[index]);

    if (!matches) {
      paths[alias] = [...desired];
      changed = true;
    }
  }

  return {
    changed,
    contents: `${JSON.stringify(tsconfig, null, 2)}\n`,
  };
}
