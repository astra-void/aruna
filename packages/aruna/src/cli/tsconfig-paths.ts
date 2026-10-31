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

// The generated signal registry virtual module. Mapped alongside the action
// aliases so `import { signals } from "$aruna/signals"` resolves under tsc and
// rbxtsc; the compiler resolves the same specifier virtually. Points at the
// generated file, which only exists once a project declares signals — an unused
// mapping to a missing file is harmless (tsc path mappings resolve lazily).
export const ARUNA_SIGNALS_ALIAS = "$aruna/signals";

// Roblox-facing runtime modules vendored into `<generatedDir>/shared/runtime/`
// by `aruna build --emit-runtime`. The bare `aruna/<name>` subpaths are aliased to
// those project-source files so roblox-ts compiles them instead of rejecting a
// `node_modules` package import.
export const ARUNA_RUNTIME_MODULES = ["client", "server", "roblox", "schema", "testing"] as const;

// Every aruna-owned path alias and the absolute path of the generated file it
// maps to (actions + signals + vendored runtime). The single source of truth
// for what tsconfig.json must map: the tsconfig upkeep writes these, doctor
// reports them, and `aruna check` measures existing aliases against them.
export function arunaAliasTargets(
  projectRoot: string,
  generatedDir: string,
): Record<string, string> {
  const generatedDirAbs = path.resolve(projectRoot, generatedDir);
  const targets: Record<string, string> = {
    [ARUNA_ACTION_PATHS.client]: path.join(generatedDirAbs, GENERATED_CLIENT_ACTIONS_FILE),
    [ARUNA_ACTION_PATHS.server]: path.join(generatedDirAbs, GENERATED_SERVER_ACTIONS_FILE),
    [ARUNA_SIGNALS_ALIAS]: path.join(generatedDirAbs, GENERATED_SIGNALS_FILE),
  };
  for (const moduleName of ARUNA_RUNTIME_MODULES) {
    targets[`aruna/${moduleName}`] = path.join(
      generatedDirAbs,
      GENERATED_RUNTIME_DIR,
      `${moduleName}.ts`,
    );
  }
  return targets;
}

// True for alias keys owned by Aruna: the `$aruna/...` virtual modules and the
// bare `aruna/<name>` runtime subpaths.
export function isArunaOwnedAlias(alias: string): boolean {
  return alias.startsWith("$aruna/") || alias.startsWith("aruna/");
}

// Older builds generated `<generatedDir>/tsconfig.aruna.json` for the project
// tsconfig to `extends`. Aruna now writes its settings into tsconfig.json
// itself; the name is kept so the upkeep can drop a leftover reference and the
// build can prune the file.
export const RETIRED_TSCONFIG_FRAGMENT_FILE = "tsconfig.aruna.json";
