import path from "node:path";

export const ARUNA_ACTION_PATHS = {
  client: "$aruna/actions/client",
  server: "$aruna/actions/server",
} as const;

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
    .relative(tsconfigDir, path.resolve(tsconfigDir, generatedDir, "signals.generated.ts"))
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
      path.resolve(path.dirname(tsconfigPath), generatedDir, "actions.client.generated.ts"),
    )
    .split(path.sep)
    .join("/");
  const serverPath = path
    .relative(
      tsconfigDir,
      path.resolve(path.dirname(tsconfigPath), generatedDir, "actions.server.generated.ts"),
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

// Roblox-facing runtime modules vendored into `<generatedDir>/runtime/` by
// `aruna build --emit-runtime`. The bare `aruna/<name>` subpaths are aliased to
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
      .relative(tsconfigDir, path.resolve(tsconfigDir, generatedDir, "runtime", `${moduleName}.ts`))
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
