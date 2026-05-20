import path from "node:path";

export const ARUNA_ACTION_PATHS = {
  client: "$aruna/actions/client",
  server: "$aruna/actions/server",
} as const;

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
