import fs from "node:fs";
import path from "node:path";

// Codegen ownership for the one piece of Rojo wiring that changes every time a
// dependency is added: the `rbxts_include/node_modules` mount list.
//
// A Roblox-facing npm package only reaches the place if `default.project.json`
// mounts the scope it lives in. Nothing in the pipeline notices when it does
// not — `aruna build`, `rbxtsc` and `rojo build` all exit 0, and the game fails
// at runtime on the require. So every `pnpm add @some-ui/thing` used to come
// with a hand edit to the project file.
//
// Rojo resolves a `$path` that points at another `*.project.json` as a nested
// project, with paths inside it relative to that file. That gives Aruna a file
// of its own to own: the consumer's project file gains one static line
// (`"node_modules": { "$path": "src/.aruna/node_modules.project.json" }`) and
// the scope list is regenerated from `node_modules/` on every build.

export const NODE_MODULES_PROJECT_FILE = "node_modules.project.json";

// How deep to look for Luau inside a package before deciding it ships none.
// Real rbxts packages keep it at the root (`init.lua`) or one level down
// (`src/`, `out/`); the extra level covers `out/<subdir>/`.
const LUAU_SCAN_DEPTH = 3;

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function containsLuau(dir: string, depth: number): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && /\.luau?$/.test(entry.name)) {
      return true;
    }
  }
  if (depth <= 0) {
    return false;
  }
  for (const entry of entries) {
    // A package's own nested node_modules is a different package's business.
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    if (containsLuau(path.join(dir, entry.name), depth - 1)) {
      return true;
    }
  }
  return false;
}

// True when the package ships Luau, i.e. it is meant to end up in the DataModel.
// Build-time-only packages (`@facet-ui/theme`, `@types/*`, bundler binaries)
// ship JavaScript or type declarations and never qualify.
export function isRobloxFacingPackage(packageDir: string): boolean {
  return containsLuau(packageDir, LUAU_SCAN_DEPTH);
}

// Rojo names an instance after the directory it mounts, unless that directory
// holds a `default.project.json` — then the nested project's `name` wins. That
// is how `@lattice-ui/react-dialog` lands in the DataModel as `dialog`, and it
// is the name roblox-ts's resolver computes for a require. Per-package mounts
// have to reproduce it exactly, because an explicit key overrides it.
function rojoInstanceName(packageDir: string, directoryName: string): string {
  try {
    const project = JSON.parse(
      fs.readFileSync(path.join(packageDir, "default.project.json"), "utf8"),
    ) as { name?: unknown };
    if (typeof project.name === "string" && project.name.length > 0) {
      return project.name;
    }
  } catch {
    // No nested project, or an unreadable one: the directory name it is.
  }
  return directoryName;
}

export type RobloxScopeMount = {
  scope: string;
  // Roblox-facing packages in the scope, as {instance name -> directory name}
  // pairs. Empty when every package in the scope qualifies, which mounts the
  // scope directory wholesale.
  packages: Array<{ name: string; directory: string }>;
};

// Scopes under `node_modules/` holding at least one Roblox-facing package.
//
// A scope whose packages all ship Luau is mounted wholesale — the shape
// roblox-ts projects already use for `@rbxts`, and one that keeps working when
// a package is added to it. A mixed scope is mounted per qualifying package
// instead: mounting it wholesale would put every build-time-only package in the
// DataModel as an empty Folder and make Rojo walk its whole file tree, which is
// exactly what hand-written project files were spelling out mounts to avoid.
export function discoverRobloxScopes(projectRoot: string): RobloxScopeMount[] {
  const nodeModules = path.join(projectRoot, "node_modules");
  let scopes: fs.Dirent[];
  try {
    scopes = fs.readdirSync(nodeModules, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: RobloxScopeMount[] = [];
  for (const scope of scopes) {
    if (!scope.isDirectory() || !scope.name.startsWith("@")) {
      continue;
    }
    const scopeDir = path.join(nodeModules, scope.name);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(scopeDir, { withFileTypes: true });
    } catch {
      continue;
    }

    const directories = entries.filter((entry) => entry.isDirectory());
    const robloxFacing = directories.filter((entry) =>
      isRobloxFacingPackage(path.join(scopeDir, entry.name)),
    );
    if (robloxFacing.length === 0) {
      continue;
    }
    found.push({
      scope: scope.name,
      packages:
        robloxFacing.length === directories.length
          ? []
          : robloxFacing
              .map((entry) => ({
                name: rojoInstanceName(path.join(scopeDir, entry.name), entry.name),
                directory: entry.name,
              }))
              .sort((left, right) => left.name.localeCompare(right.name)),
    });
  }
  return found.sort((left, right) => left.scope.localeCompare(right.scope));
}

// Project-relative posix path of the generated nested project file, i.e. the
// value a consumer's `default.project.json` mounts.
export function nodeModulesProjectMount(generatedDir: string): string {
  return toPosix(path.join(generatedDir, NODE_MODULES_PROJECT_FILE));
}

// Contents of the generated nested project. `$path` values are relative to the
// file itself, so they climb back out of the generated dir to `node_modules/`.
export function arunaNodeModulesProjectContents(
  projectRoot: string,
  generatedDir: string,
  scopes: readonly RobloxScopeMount[] = discoverRobloxScopes(projectRoot),
): string {
  const upToRoot = toPosix(path.relative(path.resolve(projectRoot, generatedDir), projectRoot));
  const tree: Record<string, unknown> = { $className: "Folder" };
  for (const { scope, packages } of scopes) {
    if (packages.length === 0) {
      tree[scope] = { $path: `${upToRoot}/node_modules/${scope}` };
      continue;
    }
    const scopeTree: Record<string, unknown> = { $className: "Folder" };
    for (const entry of packages) {
      scopeTree[entry.name] = { $path: `${upToRoot}/node_modules/${scope}/${entry.directory}` };
    }
    tree[scope] = scopeTree;
  }
  return `${JSON.stringify(
    {
      // Generated by Aruna — `aruna build` rewrites this file from node_modules/.
      // Rojo takes the instance name from the parent project's key, so `name`
      // here is documentation only.
      name: "node_modules",
      tree,
    },
    null,
    2,
  )}\n`;
}

export type NodeModulesMountReport = {
  // Scopes with Roblox-facing packages, discovered from node_modules/.
  discovered: string[];
  // Of those, the ones the Rojo project never mounts — their modules fail to
  // require at runtime while every build step reports success.
  missing: string[];
  // True when the project mounts node_modules through the generated nested
  // project file, which makes `missing` structurally impossible.
  managed: boolean;
};

// Measures a Rojo project's node_modules mounts against what is installed.
// `mountedPaths` is the flat `$path` list from the project file
// (see collectRojoPaths in rojo-project.ts).
export function inspectNodeModulesMounts(
  projectRoot: string,
  generatedDir: string,
  mountedPaths: readonly string[],
): NodeModulesMountReport {
  const discovered = discoverRobloxScopes(projectRoot).map((entry) => entry.scope);
  const managedMount = nodeModulesProjectMount(generatedDir);
  const managed = mountedPaths.includes(managedMount);
  if (managed) {
    return { discovered, missing: [], managed };
  }

  const missing = discovered.filter(
    (scope) =>
      !mountedPaths.some(
        (mounted) =>
          mounted === "node_modules" ||
          mounted === `node_modules/${scope}` ||
          mounted.startsWith(`node_modules/${scope}/`),
      ),
  );
  return { discovered, missing, managed };
}

export function formatNodeModulesMountProblem(report: NodeModulesMountReport): string[] {
  if (report.managed || report.missing.length === 0) {
    return [];
  }
  return [
    `node_modules mounts are missing ${report.missing.join(", ")}.`,
    "  Modules from those packages fail to require at runtime while `aruna build`,",
    "  `rbxtsc` and `rojo build` all report success.",
    "  fix: mount the generated project file once and never edit this list again —",
    '  "node_modules": { "$path": "<generatedDir>/node_modules.project.json" }',
  ];
}
