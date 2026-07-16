import fs from "node:fs/promises";
import path from "node:path";
import type { Diagnostic } from "@arunajs/core";
import { loadProjectConfig } from "@arunajs/compiler";
import {
  ARUNA_ACTION_PATHS,
  ARUNA_RUNTIME_MODULES,
  ARUNA_SIGNALS_ALIAS,
  ARUNA_TSCONFIG_FRAGMENT_FILE,
  arunaTsconfigExtendsRef,
  arunaTsconfigFragmentContents,
  extendsIncludesFragment,
  resolveAllArunaAliasPaths,
  resolveArunaActionPaths,
  resolveArunaRuntimePaths,
  resolveArunaSignalPaths,
} from "./tsconfig-paths.js";

// The build ledger: a manifest of the files `aruna build` itself emits into the
// generatedDir, written after every build. It is what makes stale-artifact
// pruning safe — only paths this build (or a previous build) owned are ever
// removed, never hand-written user files. Distinct from the module-classification
// `manifest.json`, which describes discovered actions/signals, not owned files.
export const OWNED_MANIFEST_FILE = ".aruna-build.json";

export type OwnedArtifactManifest = {
  readonly version: 1;
  readonly layout: "split-tree";
  // Paths relative to generatedDir, posix-separated.
  readonly generated: string[];
  readonly runtime: string[];
};

// Artifacts from the pre-split-tree (flat) codegen layout. These names and
// locations are unambiguously Aruna-owned *within the generatedDir* — a project
// never hand-authors a `actions.client.generated.ts` or a `runtime/` tree under
// its generated dir — so they are safe to prune even on the first build after
// upgrading, before any owned-file ledger exists. Mirrors the new split-tree
// targets in tsconfig-paths.ts (shared/*, server/*, shared/runtime/*).
const LEGACY_FLAT_GENERATED_FILES = [
  "actions.client.generated.ts",
  "actions.server.generated.ts",
  "signals.generated.ts",
] as const;
// The runtime used to vendor flat at `<gen>/runtime/`; it now lives at
// `<gen>/shared/runtime/`. The two never collide, so removing the flat one is safe.
const LEGACY_RUNTIME_DIR = "runtime";

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

// True when `candidate` resolves to `base` itself or something nested under it.
// Guards every deletion so a malformed (e.g. `../`) relative path can never reach
// outside the generatedDir.
function isInside(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function dedupeSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export async function readOwnedManifest(
  generatedDirAbs: string,
): Promise<OwnedArtifactManifest | undefined> {
  try {
    const raw = await fs.readFile(path.join(generatedDirAbs, OWNED_MANIFEST_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<OwnedArtifactManifest>;
    if (!Array.isArray(parsed.generated) || !Array.isArray(parsed.runtime)) {
      return undefined;
    }
    return {
      version: 1,
      layout: "split-tree",
      generated: parsed.generated.filter((entry): entry is string => typeof entry === "string"),
      runtime: parsed.runtime.filter((entry): entry is string => typeof entry === "string"),
    };
  } catch {
    return undefined;
  }
}

async function writeOwnedManifest(
  generatedDirAbs: string,
  manifest: OwnedArtifactManifest,
): Promise<void> {
  await fs.mkdir(generatedDirAbs, { recursive: true });
  await fs.writeFile(
    path.join(generatedDirAbs, OWNED_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

// Scans the generatedDir for artifacts left behind by the pre-split-tree layout:
// the flat `*.generated.ts` stubs at the root and the flat `runtime/` directory.
// Returns generatedDir-relative posix paths that actually exist. Used both to
// prune (build) and to report desync (check).
export async function detectLegacyArtifacts(generatedDirAbs: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of LEGACY_FLAT_GENERATED_FILES) {
    if (await pathExists(path.join(generatedDirAbs, name))) {
      found.push(name);
    }
  }
  if (await pathExists(path.join(generatedDirAbs, LEGACY_RUNTIME_DIR))) {
    found.push(LEGACY_RUNTIME_DIR);
  }
  return found;
}

// Removes directories left empty after pruning, walking up from each pruned path
// toward (but never including or past) the generatedDir.
async function removeEmptyParents(generatedDirAbs: string, prunedRel: readonly string[]): Promise<void> {
  const dirs = new Set<string>();
  for (const rel of prunedRel) {
    let dir = path.dirname(path.resolve(generatedDirAbs, rel));
    while (isInside(generatedDirAbs, dir) && dir !== generatedDirAbs) {
      dirs.add(dir);
      dir = path.dirname(dir);
    }
  }
  // Deepest first so a parent becomes empty only after its children are gone.
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      const entries = await fs.readdir(dir);
      if (entries.length === 0) {
        await fs.rmdir(dir);
      }
    } catch {
      // Best-effort: a missing or non-empty dir is fine.
    }
  }
}

export type CurrentOwnedArtifacts = {
  // Generated `.ts`/`.json` files this build wrote, relative to generatedDir.
  readonly generated: readonly string[];
  // Vendored runtime files relative to generatedDir, or undefined when this build
  // did not re-emit the runtime (`--no-emit-runtime`) — in which case the previous
  // ledger's runtime set is preserved so the live runtime is never pruned.
  readonly runtime?: readonly string[] | undefined;
};

export type ReconcileResult = {
  readonly pruned: string[];
  readonly manifest: OwnedArtifactManifest;
};

// Reconciles the generatedDir against what this build emitted: prunes any file a
// previous build owned (or any known legacy-layout artifact) that is no longer
// emitted, then rewrites the owned-file ledger. Only ever touches paths inside
// the generatedDir. Returns the pruned paths (generatedDir-relative) for reporting.
export async function reconcileOwnedArtifacts(options: {
  generatedDirAbs: string;
  current: CurrentOwnedArtifacts;
}): Promise<ReconcileResult> {
  const { generatedDirAbs } = options;
  const previous = await readOwnedManifest(generatedDirAbs);
  const runtime = options.current.runtime ?? previous?.runtime ?? [];
  const manifest: OwnedArtifactManifest = {
    version: 1,
    layout: "split-tree",
    generated: dedupeSorted(options.current.generated),
    runtime: dedupeSorted(runtime),
  };

  const keep = new Set<string>([...manifest.generated, ...manifest.runtime]);

  const staleCandidates = new Set<string>();
  if (previous) {
    for (const rel of [...previous.generated, ...previous.runtime]) {
      if (!keep.has(rel)) {
        staleCandidates.add(rel);
      }
    }
  }
  for (const rel of await detectLegacyArtifacts(generatedDirAbs)) {
    if (!keep.has(rel)) {
      staleCandidates.add(rel);
    }
  }

  const pruned: string[] = [];
  for (const rel of staleCandidates) {
    const absolute = path.resolve(generatedDirAbs, rel);
    if (!isInside(generatedDirAbs, absolute) || absolute === generatedDirAbs) {
      continue;
    }
    if (!(await pathExists(absolute))) {
      continue;
    }
    await fs.rm(absolute, { recursive: true, force: true });
    pruned.push(toPosix(rel));
  }

  await removeEmptyParents(generatedDirAbs, pruned);
  await writeOwnedManifest(generatedDirAbs, manifest);

  return { pruned: pruned.sort(), manifest };
}

async function readTsconfigObject(
  tsconfigPath: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await fs.readFile(tsconfigPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function tsconfigPathsOf(tsconfig: Record<string, unknown>): Record<string, unknown> | undefined {
  const compilerOptions = tsconfig["compilerOptions"];
  if (typeof compilerOptions !== "object" || compilerOptions === null || Array.isArray(compilerOptions)) {
    return undefined;
  }
  const paths = (compilerOptions as Record<string, unknown>)["paths"];
  return typeof paths === "object" && paths !== null && !Array.isArray(paths)
    ? (paths as Record<string, unknown>)
    : undefined;
}

function aliasTarget(paths: Record<string, unknown>, alias: string): string | undefined {
  const value = paths[alias];
  if (Array.isArray(value) && typeof value[0] === "string") {
    return toPosix(value[0]);
  }
  return undefined;
}

// Collects layout-desync diagnostics for `aruna check`: stale generated artifacts
// still on disk, and tsconfig aliases whose targets no longer match the current
// emit layout. Best-effort — any failure to load config/tsconfig yields no
// diagnostics (those problems are already reported by the compiler/doctor).
export async function collectLayoutDesyncDiagnostics(options: {
  projectRoot: string;
  configPath?: string | undefined;
}): Promise<Diagnostic[]> {
  let generatedDir: string;
  let tsconfigPath: string;
  try {
    const loaded = loadProjectConfig(options.projectRoot, options.configPath);
    generatedDir = loaded.config.generatedDir;
    tsconfigPath = loaded.tsconfigPath;
  } catch {
    return [];
  }

  const diagnostics: Diagnostic[] = [];
  const generatedDirAbs = path.resolve(options.projectRoot, generatedDir);

  const legacy = await detectLegacyArtifacts(generatedDirAbs);
  for (const rel of legacy) {
    diagnostics.push({
      code: "aruna::110",
      name: "stale-generated-artifact",
      severity: "warning",
      message: `Stale generated artifact ${toPosix(path.join(generatedDir, rel))} from a previous codegen layout.`,
      file: toPosix(path.join(generatedDir, rel)),
      details:
        "This path is no longer emitted under the current split-tree layout. " +
        "An out-of-date alias pointing here can silently shadow the current generated output.",
      suggestion: "Run `aruna build` to prune stale artifacts, or delete the path manually.",
    });
  }

  const tsconfig = await readTsconfigObject(tsconfigPath);
  const tsconfigPaths = tsconfig !== undefined ? tsconfigPathsOf(tsconfig) : undefined;
  const fragmentRef = arunaTsconfigExtendsRef(tsconfigPath, generatedDir);
  const fragmentReferenced = tsconfig !== undefined && extendsIncludesFragment(tsconfig, fragmentRef);
  const fragmentRel = toPosix(path.join(generatedDir, ARUNA_TSCONFIG_FRAGMENT_FILE));

  if (fragmentReferenced) {
    // Extends-managed project: the generated fragment supplies the aliases.
    const fragmentAbs = path.resolve(generatedDirAbs, ARUNA_TSCONFIG_FRAGMENT_FILE);
    let fragmentContents: string | undefined;
    try {
      fragmentContents = await fs.readFile(fragmentAbs, "utf8");
    } catch {
      fragmentContents = undefined;
    }
    const expectedContents = arunaTsconfigFragmentContents(options.projectRoot, generatedDir);
    if (fragmentContents !== expectedContents) {
      diagnostics.push({
        code: "aruna::111",
        name: "tsconfig-alias-desync",
        severity: "warning",
        message:
          fragmentContents === undefined
            ? `Generated tsconfig fragment ${fragmentRel} is missing.`
            : `Generated tsconfig fragment ${fragmentRel} is stale.`,
        file: fragmentRel,
        details:
          "The project tsconfig extends this fragment for its Aruna path aliases, " +
          "so a missing or stale fragment breaks alias resolution.",
        suggestion: "Run `aruna build` (or `aruna doctor --fix`) to regenerate the fragment.",
      });
    }

    // Inline paths shadow the extended fragment wholesale (TS extends
    // semantics). Only a shadow that actually breaks an aruna alias is flagged.
    if (tsconfigPaths !== undefined) {
      const expectedAll = resolveAllArunaAliasPaths(tsconfigPath, generatedDir);
      const broken: string[] = [];
      for (const [alias, targets] of Object.entries(expectedAll)) {
        const actual = aliasTarget(tsconfigPaths, alias);
        if (actual === undefined) {
          broken.push(`${alias} (missing inline)`);
        } else if (actual !== toPosix(targets[0]!)) {
          broken.push(`${alias} -> ${actual} (expected ${toPosix(targets[0]!)})`);
        }
      }
      if (broken.length > 0) {
        diagnostics.push({
          code: "aruna::112",
          name: "tsconfig-paths-shadow-generated",
          severity: "warning",
          message:
            "compilerOptions.paths shadows the generated Aruna tsconfig fragment and breaks alias(es).",
          file: toPosix(path.relative(options.projectRoot, tsconfigPath)),
          details:
            `TypeScript replaces inherited paths wholesale, so the fragment's aliases are inert. Broken: ${broken.join("; ")}`,
          suggestion:
            "Run `aruna doctor --fix --project .` to realign the inline aliases, or remove compilerOptions.paths to use the fragment.",
        });
      }
    }

    return diagnostics;
  }

  if (tsconfigPaths !== undefined) {
    const expectedAction = resolveArunaActionPaths(tsconfigPath, generatedDir);
    const expectedSignal = resolveArunaSignalPaths(tsconfigPath, generatedDir);
    const expectedRuntime = resolveArunaRuntimePaths(tsconfigPath, generatedDir);

    const mismatches: string[] = [];
    const checkAlias = (alias: string, expected: string): void => {
      const actual = aliasTarget(tsconfigPaths, alias);
      // Only flag aliases that exist but point somewhere stale — a *missing*
      // alias is doctor's concern, not a desync.
      if (actual !== undefined && actual !== toPosix(expected)) {
        mismatches.push(`${alias} -> ${actual} (expected ${toPosix(expected)})`);
      }
    };

    checkAlias(ARUNA_ACTION_PATHS.client, expectedAction.client[0]!);
    checkAlias(ARUNA_ACTION_PATHS.server, expectedAction.server[0]!);
    checkAlias(ARUNA_SIGNALS_ALIAS, expectedSignal[ARUNA_SIGNALS_ALIAS]![0]!);
    for (const moduleName of ARUNA_RUNTIME_MODULES) {
      const alias = `aruna/${moduleName}`;
      checkAlias(alias, expectedRuntime[alias]![0]!);
    }

    if (mismatches.length > 0) {
      diagnostics.push({
        code: "aruna::111",
        name: "tsconfig-alias-desync",
        severity: "warning",
        message: `tsconfig path alias(es) do not match the current emit layout.`,
        file: toPosix(path.relative(options.projectRoot, tsconfigPath)),
        details: mismatches.join("; "),
        suggestion: "Run `aruna doctor --fix --emit-runtime --project .` to realign the aliases.",
      });
    }
  }

  return diagnostics;
}
