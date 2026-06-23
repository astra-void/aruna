import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ArunaManifest, ArunaModuleKind, ArunaModuleRecord } from "@arunajs/core";

// Partitions the project into client/server/shared before compiling to Luau, so
// the emitted `out/` tree maps cleanly onto the Roblox DataModel — server code
// lands in ServerScriptService (NOT replicated to clients), client code in
// StarterPlayerScripts, and shared code (plus the vendored runtime and the
// client-callable stubs) in ReplicatedStorage.
//
// Mechanism: stage the whole source into a temp tree restructured by the
// compiler's module classification, rewriting relative imports (from the
// manifest's resolved import edges) to the new cross-partition paths, then run
// the consumer's `rbxtsc` against that staged tree and copy `out/` back. This
// avoids re-parsing TypeScript: the Rust compiler already resolved every import.

export type LayoutTarget = "client" | "server" | "shared";

export type PartitionResult =
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "ran"; readonly status: number; readonly stdout: string; readonly stderr: string };

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function stripModuleExtension(filePath: string): string {
  if (filePath.endsWith(".d.ts")) {
    return filePath.slice(0, -".d.ts".length);
  }
  return filePath.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
}

function isEntry(kind: ArunaModuleKind): boolean {
  return kind === "clientEntry" || kind === "serverEntry";
}

// Where a module lands. `.aruna` generated files are special-cased: the server
// action registry (which imports server implementations) must stay server-side,
// everything else generated is shared (client stubs, the signal registry, and
// the vendored runtime).
export function layoutTargetFor(
  modulePath: string,
  kind: ArunaModuleKind,
  generatedDirRel: string,
): LayoutTarget {
  const normalized = toPosix(modulePath);
  if (normalized.startsWith(`src/${generatedDirRel}/`)) {
    return kind === "serverAction" ? "server" : "shared";
  }
  switch (kind) {
    case "client":
    case "clientEntry":
      return "client";
    case "server":
    case "serverEntry":
    case "serverAction":
      return "server";
    default:
      return "shared";
  }
}

// Staged path (relative to staged `src/`) for a module. Entry modules are renamed
// to `*.client`/`*.server` so roblox-ts emits a LocalScript/Script.
export function stagePathFor(
  modulePath: string,
  kind: ArunaModuleKind,
  target: LayoutTarget,
): string {
  const sourceRel = toPosix(modulePath).replace(/^src\//, "");
  const ext = path.posix.extname(sourceRel) || ".ts";

  if (isEntry(kind)) {
    return target === "client" ? `client/main.client${ext}` : `server/main.server${ext}`;
  }
  return `${target}/${sourceRel}`;
}

function quoteVariants(specifier: string): string[] {
  return [`from "${specifier}"`, `from '${specifier}'`, `import("${specifier}")`, `import('${specifier}')`];
}

// Rewrites the relative module specifiers in one staged file using the manifest's
// resolved import edges, so cross-partition imports resolve to their new homes.
function rewriteImports(
  contents: string,
  importerPath: string,
  importerStageRel: string,
  edges: ReadonlyArray<{ from: string; specifier: string; to?: string | undefined }>,
  sourceToStage: Map<string, string>,
): string {
  let next = contents;
  const importerStageDir = path.posix.dirname(importerStageRel);

  for (const edge of edges) {
    if (edge.from !== importerPath || edge.to === undefined) {
      continue;
    }
    if (!edge.specifier.startsWith(".")) {
      continue;
    }
    const targetStage = sourceToStage.get(edge.to);
    if (targetStage === undefined) {
      continue;
    }
    const relativeTarget = stripModuleExtension(
      toPosix(path.posix.relative(importerStageDir, targetStage)),
    );
    const nextSpecifier =
      relativeTarget.startsWith(".") || relativeTarget === ""
        ? relativeTarget || "."
        : `./${relativeTarget}`;
    if (nextSpecifier === edge.specifier) {
      continue;
    }
    for (const from of quoteVariants(edge.specifier)) {
      const to = from.replace(edge.specifier, nextSpecifier);
      next = next.split(from).join(to);
    }
  }

  return next;
}

function copyDirSync(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(src, dest);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dest);
    }
  }
}

export type PartitionOptions = {
  readonly projectRoot: string;
  readonly generatedDir: string;
  readonly manifest: ArunaManifest;
  readonly rbxtscBin: string;
};

// Stages a partitioned copy of the project, compiles it with rbxtsc, and copies
// the resulting `out/client|server|shared` tree back into the project.
export function runPartitionedRbxtsc(options: PartitionOptions): PartitionResult {
  const { projectRoot, manifest, rbxtscBin } = options;
  const generatedDirRel = toPosix(path.relative("src", options.generatedDir)) || ".aruna";
  const srcRoot = path.join(projectRoot, "src");
  const outRoot = path.join(projectRoot, "out");

  const nodeModules = path.join(projectRoot, "node_modules");
  if (!fs.existsSync(nodeModules)) {
    return { kind: "skipped", reason: "node_modules not found for partitioned rbxtsc" };
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aruna-layout-"));
  try {
    // Mirror node_modules so rbxtsc resolves @rbxts and @types.
    fs.mkdirSync(path.join(tempRoot, "node_modules"), { recursive: true });
    for (const scope of ["@rbxts", "@types"]) {
      const src = path.join(nodeModules, scope);
      if (fs.existsSync(src)) {
        try {
          fs.symlinkSync(src, path.join(tempRoot, "node_modules", scope), "dir");
        } catch {
          copyDirSync(src, path.join(tempRoot, "node_modules", scope));
        }
      }
    }
    const includeDir = path.join(projectRoot, "include");
    if (fs.existsSync(includeDir)) {
      fs.symlinkSync(includeDir, path.join(tempRoot, "include"), "dir");
    } else {
      fs.mkdirSync(path.join(tempRoot, "include"), { recursive: true });
    }

    // Build the source -> staged-path map from the module classification.
    const sourceToStage = new Map<string, string>();
    const records: Array<{ record: ArunaModuleRecord; target: LayoutTarget; stage: string }> = [];
    for (const record of manifest.modules) {
      if (!toPosix(record.path).startsWith("src/")) {
        continue;
      }
      const target = layoutTargetFor(record.path, record.kind, generatedDirRel);
      const stage = stagePathFor(record.path, record.kind, target);
      sourceToStage.set(record.path, stage);
      records.push({ record, target, stage });
    }

    const stageSrc = path.join(tempRoot, "src");
    const edges = manifest.imports ?? [];

    // Stage each classified module, rewriting its relative imports.
    for (const { record, stage } of records) {
      const absoluteSource = path.join(projectRoot, record.path);
      if (!fs.existsSync(absoluteSource)) {
        continue;
      }
      const contents = fs.readFileSync(absoluteSource, "utf8");
      const rewritten = rewriteImports(contents, record.path, stage, edges, sourceToStage);
      const dest = path.join(stageSrc, stage);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, rewritten);
    }

    // The vendored runtime is shared and self-contained — copy it wholesale into
    // the shared partition with its internal structure (relative imports intact).
    const runtimeSrc = path.join(srcRoot, generatedDirRel, "runtime");
    if (fs.existsSync(runtimeSrc)) {
      copyDirSync(runtimeSrc, path.join(stageSrc, "shared", generatedDirRel, "runtime"));
    }

    // Resolve the generated/runtime aliases to their partitioned locations.
    const aliasPath = (target: LayoutTarget, rel: string): string[] => [`src/${target}/${generatedDirRel}/${rel}`];
    const runtimeAlias: Record<string, string[]> = {};
    const runtimeDir = path.join(stageSrc, "shared", generatedDirRel, "runtime");
    if (fs.existsSync(runtimeDir)) {
      for (const entry of fs.readdirSync(runtimeDir)) {
        if (entry.endsWith(".ts")) {
          const name = entry.replace(/\.ts$/, "");
          runtimeAlias[`aruna/${name}`] = [`src/shared/${generatedDirRel}/runtime/${name}.ts`];
        }
      }
    }

    const paths: Record<string, string[]> = {
      "$aruna/actions/client": aliasPath("shared", "actions.client.generated.ts"),
      "$aruna/actions/server": aliasPath("server", "actions.server.generated.ts"),
      "$aruna/signals": aliasPath("shared", "signals.generated.ts"),
      ...runtimeAlias,
    };

    const tsconfig = {
      compilerOptions: {
        target: "ESNext",
        module: "CommonJS",
        moduleResolution: "Node",
        moduleDetection: "force",
        strict: true,
        noLib: true,
        baseUrl: ".",
        rootDir: "src",
        outDir: "out",
        jsx: "preserve",
        declaration: false,
        declarationMap: false,
        downlevelIteration: true,
        allowSyntheticDefaultImports: true,
        esModuleInterop: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true,
        noUncheckedIndexedAccess: true,
        verbatimModuleSyntax: false,
        typeRoots: ["./node_modules", "./node_modules/@rbxts"],
        types: ["@rbxts/types", "@rbxts/compiler-types"],
        paths,
      },
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["out", "node_modules"],
    };
    // roblox-ts requires a package.json at the project root.
    fs.writeFileSync(
      path.join(tempRoot, "package.json"),
      `${JSON.stringify({ name: "aruna-staged", version: "0.0.0" }, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(tempRoot, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`);
    fs.writeFileSync(
      path.join(tempRoot, "default.project.json"),
      `${JSON.stringify(partitionedRojoProject(), null, 2)}\n`,
    );

    const result = spawnSync(rbxtscBin, ["--project", tempRoot], {
      cwd: tempRoot,
      encoding: "utf8",
    });
    if (result.error) {
      return { kind: "skipped", reason: `failed to launch rbxtsc: ${result.error.message}` };
    }
    const status = result.status ?? 1;
    if (status === 0) {
      const stagedOut = path.join(tempRoot, "out");
      if (fs.existsSync(stagedOut)) {
        fs.rmSync(outRoot, { recursive: true, force: true });
        copyDirSync(stagedOut, outRoot);
      }
      // Ensure every partition dir exists so the Rojo $path mounts resolve even
      // when a project declares no modules of a given kind.
      for (const partition of ["client", "server", "shared"]) {
        fs.mkdirSync(path.join(outRoot, partition), { recursive: true });
      }
    }
    return { kind: "ran", status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

// The Roblox DataModel contract the partitioned `out/` maps onto.
export function partitionedRojoProject(): unknown {
  return {
    name: "aruna-game",
    globIgnorePaths: ["**/package.json", "**/tsconfig.json"],
    tree: {
      $className: "DataModel",
      ServerScriptService: {
        $className: "ServerScriptService",
        TS: { $path: "out/server" },
      },
      ReplicatedStorage: {
        $className: "ReplicatedStorage",
        rbxts_include: {
          $path: "include",
          node_modules: {
            $className: "Folder",
            "@rbxts": { $path: "node_modules/@rbxts" },
          },
        },
        TS: { $path: "out/shared" },
      },
      StarterPlayer: {
        $className: "StarterPlayer",
        StarterPlayerScripts: {
          $className: "StarterPlayerScripts",
          TS: { $path: "out/client" },
        },
      },
      Workspace: { $className: "Workspace", $properties: { FilteringEnabled: true } },
    },
  };
}
