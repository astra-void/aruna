import fs from "node:fs";
import path from "node:path";
import {
  formatNodeModulesMountProblem,
  inspectNodeModulesMounts,
  type NodeModulesMountReport,
} from "./rojo-node-modules.js";

// Inspects the consumer's Rojo project file against the partitioned `out/`
// contract that `aruna build` emits (see rojo-layout.ts).
//
// This is the one check that catches Aruna's worst silent failure: a project
// whose Rojo file never mounts `out/` builds a place with none of the compiled
// code in it, while `aruna build` and `rojo build` both exit 0. The classic way
// in is adopting Aruna inside an existing Rojo project — `rojo init` scaffolds a
// project file that mounts `src/` (Luau sources) directly, and `aruna init`
// keeps it rather than clobbering the user's layout.

export const ROJO_PROJECT_FILE = "default.project.json";

// The mounts `partitionedRojoProject()` writes. `include` carries the roblox-ts
// runtime library (RuntimeLib) that every compiled script requires at boot.
export const REQUIRED_ROJO_MOUNTS = ["out/client", "out/server", "out/shared", "include"] as const;

export type RojoMount = (typeof REQUIRED_ROJO_MOUNTS)[number];

export type RojoProjectReport = {
  // Project-relative posix path of the inspected file.
  path: string;
  status: "missing" | "unreadable" | "aligned" | "incomplete";
  // Mounts present in the project tree, in REQUIRED_ROJO_MOUNTS order.
  present: RojoMount[];
  // Mounts the project never mounts — the code that will not reach the place.
  absent: RojoMount[];
  // Installed Roblox-facing npm scopes measured against the project's
  // node_modules mounts. Present only when a generatedDir was supplied.
  nodeModules?: NodeModulesMountReport | undefined;
  error?: string | undefined;
};

function normalizeMountPath(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//, "").replace(/\/+$/, "");
}

// Every `$path` in the tree, at any depth. Rojo accepts both the string form
// (`"$path": "out/server"`) and the object form (`{ "optional": "out/server" }`).
export function collectRojoPaths(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const entry of node) {
      collectRojoPaths(entry, found);
    }
    return found;
  }
  if (typeof node !== "object" || node === null) {
    return found;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$path") {
      if (typeof value === "string") {
        found.push(normalizeMountPath(value));
      } else if (typeof value === "object" && value !== null) {
        for (const nested of Object.values(value as Record<string, unknown>)) {
          if (typeof nested === "string") {
            found.push(normalizeMountPath(nested));
          }
        }
      }
      continue;
    }
    collectRojoPaths(value, found);
  }
  return found;
}

// A mount counts when the project mounts it exactly, mounts an ancestor of it
// (mounting `out` wholesale still replicates the code, even though it loses the
// service separation), or mounts something underneath it.
function mountsPath(mountedPaths: readonly string[], required: string): boolean {
  return mountedPaths.some(
    (mounted) =>
      mounted === required ||
      required.startsWith(`${mounted}/`) ||
      mounted.startsWith(`${required}/`),
  );
}

// Rojo project files may be named anything (`rojo build` defaults to
// default.project.json). Prefer the default, then fall back to a single
// non-default `*.project.json` so a project using its own name is inspected
// rather than reported missing.
export function findRojoProjectFile(projectRoot: string): string | undefined {
  if (fs.existsSync(path.join(projectRoot, ROJO_PROJECT_FILE))) {
    return ROJO_PROJECT_FILE;
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(projectRoot);
  } catch {
    return undefined;
  }
  const candidates = entries.filter((entry) => entry.endsWith(".project.json"));
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function inspectRojoProject(
  projectRoot: string,
  fileName?: string,
  // When supplied, the report also measures the node_modules mounts against
  // the Roblox-facing packages actually installed.
  generatedDir?: string,
): RojoProjectReport {
  const resolvedName = fileName ?? findRojoProjectFile(projectRoot);
  if (resolvedName === undefined) {
    return {
      path: ROJO_PROJECT_FILE,
      status: "missing",
      present: [],
      absent: [...REQUIRED_ROJO_MOUNTS],
    };
  }

  const absolutePath = path.join(projectRoot, resolvedName);
  if (!fs.existsSync(absolutePath)) {
    return {
      path: resolvedName,
      status: "missing",
      present: [],
      absent: [...REQUIRED_ROJO_MOUNTS],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    return {
      path: resolvedName,
      status: "unreadable",
      present: [],
      absent: [...REQUIRED_ROJO_MOUNTS],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const mountedPaths = collectRojoPaths(parsed);
  const present = REQUIRED_ROJO_MOUNTS.filter((required) => mountsPath(mountedPaths, required));
  const absent = REQUIRED_ROJO_MOUNTS.filter((required) => !present.includes(required));

  return {
    path: resolvedName,
    status: absent.length === 0 ? "aligned" : "incomplete",
    present: [...present],
    absent: [...absent],
    ...(generatedDir !== undefined
      ? { nodeModules: inspectNodeModulesMounts(projectRoot, generatedDir, mountedPaths) }
      : {}),
  };
}

// One-line summary plus the actionable detail lines, shared by `aruna init` and
// `aruna doctor` so both speak with the same voice about the same defect.
export function formatRojoProjectProblem(report: RojoProjectReport): string[] {
  // Same failure shape as an unmounted `out/`, one level down: the code
  // compiles, the place builds, and the require fails at runtime.
  const nodeModulesProblem = formatNodeModulesMountProblem(
    report.nodeModules ?? { discovered: [], missing: [], managed: false },
  );
  if (report.status === "aligned") {
    return nodeModulesProblem;
  }
  if (report.status === "missing") {
    return [
      `no Rojo project file found (looked for ${report.path} and *.project.json).`,
      "  If your Rojo config lives elsewhere, make sure it mounts out/client, out/server,",
      "  out/shared and include. Otherwise run `aruna init` to scaffold one.",
    ];
  }
  if (report.status === "unreadable") {
    return [
      `${report.path} could not be parsed: ${report.error ?? "invalid JSON"}`,
      "  fix: repair the JSON, or delete the file and run `aruna init`.",
    ];
  }

  const lines = [
    `${report.path} does not mount ${report.absent.join(", ")}.`,
    "  Code under those paths never reaches the place — `aruna build` and `rojo build`",
    "  both succeed and the built place comes out empty.",
  ];
  if (report.present.length === 0) {
    lines.push(
      "  This is the usual shape after adopting Aruna inside an existing Rojo project:",
      "  the scaffolded project file still mounts your Luau sources directly.",
    );
  }
  lines.push(
    "  fix: `aruna init --force` to overwrite it with the Aruna layout, or add the mounts",
    "  yourself — out/server -> ServerScriptService, out/client -> StarterPlayerScripts,",
    "  out/shared + include -> ReplicatedStorage (see `aruna init` output for the shape).",
  );
  return [...lines, ...nodeModulesProblem];
}
