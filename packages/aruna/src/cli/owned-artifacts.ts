import fs from "node:fs/promises";
import path from "node:path";
import type { Diagnostic } from "@arunajs/core";
import { loadProjectConfig } from "@arunajs/compiler";
import { planTsconfigSetup } from "./tsconfig-setup.js";

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
// previous build owned that is no longer emitted, then rewrites the owned-file
// ledger. Only ever touches paths inside
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

// Collects layout-desync diagnostics for `aruna check`: Aruna aliases in
// tsconfig.json that map to something other than the files the current layout
// generates, and a tsconfig that still extends the generated fragment older
// builds wrote. Best-effort — a config or tsconfig that fails to load yields no
// diagnostics (the compiler reports those). A *missing* alias is not a desync:
// `aruna build` adds it before it compiles.
export async function collectLayoutDesyncDiagnostics(options: {
  projectRoot: string;
  configPath?: string | undefined;
}): Promise<Diagnostic[]> {
  let generatedDir: string;
  try {
    generatedDir = loadProjectConfig(options.projectRoot, options.configPath).config.generatedDir;
  } catch {
    return [];
  }

  const setup = planTsconfigSetup({ projectRoot: options.projectRoot, generatedDir });
  if (setup.status === "unreadable" || setup.status === "create") {
    return [];
  }

  const diagnostics: Diagnostic[] = [];
  const file = toPosix(path.relative(options.projectRoot, setup.tsconfigPath));
  if (setup.retiredFragment !== undefined) {
    diagnostics.push({
      code: "aruna::111",
      name: "tsconfig-alias-desync",
      severity: "warning",
      message: `tsconfig.json extends ${setup.retiredFragment}, which Aruna no longer generates.`,
      file,
      details:
        "Aruna writes its settings into tsconfig.json itself now, and `aruna build` deletes " +
        "the old fragment, taking the aliases it supplied with it.",
      suggestion:
        "Run `aruna build` (or `aruna doctor --fix`) to move the settings into tsconfig.json.",
    });
  }

  const stale = setup.aliases.filter((alias) => alias.status === "stale");
  if (stale.length > 0) {
    diagnostics.push({
      code: "aruna::111",
      name: "tsconfig-alias-desync",
      severity: "warning",
      message: `tsconfig path alias(es) do not match the current emit layout.`,
      file,
      details: stale
        .map(
          (alias) =>
            `${alias.alias} -> ${alias.actual}` +
            (alias.declaredIn !== undefined
              ? ` (in ${alias.declaredIn}; expected ${alias.expected} in tsconfig.json)`
              : ` (expected ${alias.expected})`),
        )
        .join("; "),
      suggestion: "Run `aruna build` (or `aruna doctor --fix`) to realign the aliases.",
    });
  }

  return diagnostics;
}
