import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Manifest, ModuleKind, ModuleRecord } from "@arunajs/core";
import { spawnSyncCommand } from "./spawn.js";

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

function isEntry(kind: ModuleKind): boolean {
  return kind === "clientEntry" || kind === "serverEntry";
}

// Where a module lands. `.aruna` generated files are special-cased: the split
// tree already encodes the partition in the path — `server/` holds the action
// registry and the generated server entry, `client/` holds the generated client
// entry, and everything else (client stubs, the signal registry, the vendored
// runtime) is replication-safe shared.
export function layoutTargetFor(
  modulePath: string,
  kind: ModuleKind,
  generatedDirRel: string,
): LayoutTarget {
  const normalized = toPosix(modulePath);
  const generatedPrefix = `src/${generatedDirRel}/`;
  if (normalized.startsWith(generatedPrefix)) {
    const generatedRel = normalized.slice(generatedPrefix.length);
    if (generatedRel.startsWith("server/")) {
      return "server";
    }
    if (generatedRel.startsWith("client/")) {
      return "client";
    }
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
  kind: ModuleKind,
  target: LayoutTarget,
): string {
  const sourceRel = toPosix(modulePath).replace(/^src\//, "");
  const ext = path.posix.extname(sourceRel) || ".ts";

  if (isEntry(kind)) {
    return target === "client" ? `client/main.client${ext}` : `server/main.server${ext}`;
  }
  return `${target}/${sourceRel}`;
}

// TypeScript's wildcard include globs never match a directory segment starting
// with a dot, so `src/**/*.ts` alone skips the whole staged generated tree
// (`src/<target>/.aruna/...`). Files there still reached the program when
// something imported them, which hid the hole — but with `entries: "generated"`
// the entry scripts themselves live there and nothing imports them, so they were
// silently never compiled and the built place came out with no Script or
// LocalScript at all. Naming the generated dir explicitly opts it back in.
export function stagedIncludeGlobs(generatedDirRel: string): string[] {
  return [
    "src/**/*.ts",
    "src/**/*.tsx",
    `src/*/${generatedDirRel}/**/*.ts`,
    `src/*/${generatedDirRel}/**/*.tsx`,
  ];
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
  readonly manifest: Manifest;
  readonly rbxtscBin: string;
  // The consumer's tsconfig, whose compilerOptions the staged build inherits.
  // Defaults to <projectRoot>/tsconfig.json.
  readonly tsconfigPath?: string | undefined;
};

// Strips // and /* */ comments outside of string literals. tsconfig.json is
// JSONC and real projects do comment it.
export function stripJsonComments(contents: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < contents.length; i += 1) {
    const char = contents[i] ?? "";
    const next = contents[i + 1] ?? "";
    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next;
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += char;
  }
  return out;
}

// Relative `typeRoots` in an extended config are resolved by TypeScript against
// *that* config's directory, so a fragment under `src/.aruna/` writes them as
// `../../node_modules`. The staged compile writes one flat tsconfig at the
// staged root, where those would climb out of the temp tree — rebase them onto
// the root config's directory, which is what the staged node_modules mirror
// reproduces. Absolute entries are left alone.
function rebaseTypeRoots(
  options: Record<string, unknown>,
  fromDir: string,
  toDir: string,
): Record<string, unknown> {
  const typeRoots = options["typeRoots"];
  if (fromDir === toDir || !Array.isArray(typeRoots)) {
    return options;
  }
  return {
    ...options,
    typeRoots: typeRoots.map((entry) => {
      if (typeof entry !== "string" || path.isAbsolute(entry)) {
        return entry;
      }
      const rebased = path.relative(toDir, path.resolve(fromDir, entry)).split(path.sep).join("/");
      return rebased.startsWith(".") ? rebased : `./${rebased}`;
    }),
  };
}

// compilerOptions from a tsconfig and everything it extends, nearest-wins.
// Package-name `extends` refs are skipped: they resolve through node
// resolution, which the staged tree cannot reproduce faithfully.
export function readInheritedCompilerOptions(
  tsconfigPath: string,
  seen: Set<string> = new Set(),
  // Directory the returned relative paths are anchored on. Defaults to the
  // entry config's own directory.
  baseDir?: string,
): Record<string, unknown> {
  const resolved = path.resolve(tsconfigPath);
  if (seen.has(resolved) || !fs.existsSync(resolved)) {
    return {};
  }
  seen.add(resolved);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripJsonComments(fs.readFileSync(resolved, "utf8"))) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }

  const own =
    typeof parsed["compilerOptions"] === "object" && parsed["compilerOptions"] !== null
      ? (parsed["compilerOptions"] as Record<string, unknown>)
      : {};

  const extendsField = parsed["extends"];
  const refs =
    typeof extendsField === "string"
      ? [extendsField]
      : Array.isArray(extendsField)
        ? extendsField.filter((entry): entry is string => typeof entry === "string")
        : [];

  const anchorDir = baseDir ?? path.dirname(resolved);
  let inherited: Record<string, unknown> = {};
  for (const ref of refs) {
    if (!ref.startsWith(".")) {
      continue;
    }
    inherited = {
      ...inherited,
      ...readInheritedCompilerOptions(path.resolve(path.dirname(resolved), ref), seen, anchorDir),
    };
  }

  return { ...inherited, ...rebaseTypeRoots(own, path.dirname(resolved), anchorDir) };
}

// Ambient declaration files carry `declare global` / JSX augmentations that the
// rest of the project type-checks against, but they are not modules, so the
// compiler's manifest never lists them and staging would drop them — taking
// every augmented prop with it. Collect them straight off disk instead.
export function collectAmbientDeclarations(srcRoot: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
        found.push(toPosix(path.relative(srcRoot, full)));
      }
    }
  };
  walk(srcRoot);
  return found.sort();
}

// compilerOptions the partitioned layout owns outright: they describe the
// staged tree, so a value inherited from the consumer would point outside it.
const STAGED_OWNED_COMPILER_OPTIONS = [
  "rootDir",
  "rootDirs",
  "outDir",
  "outFile",
  "baseUrl",
  "paths",
  "declaration",
  "declarationDir",
  "declarationMap",
  "composite",
  "incremental",
  "tsBuildInfoFile",
  "noEmit",
] as const;

export function stagedCompilerOptions(
  inherited: Record<string, unknown>,
  owned: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...inherited };
  for (const key of STAGED_OWNED_COMPILER_OPTIONS) {
    delete merged[key];
  }
  return { ...merged, ...owned };
}

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
    // Mirror every top-level entry in the consumer's node_modules so rbxtsc
    // resolves all packages (@rbxts, @types, and any other scopes or flat
    // packages the project depends on). Each entry is symlinked individually
    // (not as one whole-directory symlink) so broken nested symlinks inside
    // packages like roblox-ts don't surface through the staged tree.
    fs.mkdirSync(path.join(tempRoot, "node_modules"), { recursive: true });
    for (const entry of fs.readdirSync(nodeModules)) {
      // Skip hidden directories (.bin, .cache, .pnpm, .modules.yaml, …).
      if (entry.startsWith(".")) continue;
      const src = path.join(nodeModules, entry);
      const dest = path.join(tempRoot, "node_modules", entry);
      try {
        fs.symlinkSync(fs.realpathSync(src), dest, "dir");
      } catch {
        // Skip packages whose real path can't be resolved (broken symlinks).
      }
    }
    // rbxtsc copies its runtime library (RuntimeLib.lua, Promise, …) into this
    // folder. Stage it empty here, then copy it back into the project after a
    // successful compile so the Rojo `rbxts_include` mount ($path: "include")
    // resolves — otherwise `rojo build` fails on a missing path.
    const stagedInclude = path.join(tempRoot, "include");
    fs.mkdirSync(stagedInclude, { recursive: true });

    // Root-level config files travel with the project. rbxtsc transformers and
    // other toolchain plugins read their own config relative to the project root
    // (vela.config.ts, and whatever the next plugin invents), and a staged root
    // without them compiles against silent defaults. The three files staging
    // writes itself are overwritten below; hidden files are left behind.
    for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith(".")) {
        continue;
      }
      fs.copyFileSync(path.join(projectRoot, entry.name), path.join(tempRoot, entry.name));
    }

    // Build the source -> staged-path map from the module classification.
    const sourceToStage = new Map<string, string>();
    const records: Array<{ record: ModuleRecord; target: LayoutTarget; stage: string }> = [];
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

    // Ambient declarations are copied at their original path relative to src/,
    // outside the partition dirs, so a single copy is visible to the whole
    // staged program — duplicating a `declare global` per partition would
    // collide instead.
    for (const declaration of collectAmbientDeclarations(srcRoot)) {
      const dest = path.join(stageSrc, declaration);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(srcRoot, declaration), dest);
    }

    // The vendored runtime is shared and self-contained — copy it wholesale into
    // the shared partition with its internal structure (relative imports intact).
    // Split-tree layout vendors it under `<generatedDir>/shared/runtime`.
    const runtimeSrc = path.join(srcRoot, generatedDirRel, "shared", "runtime");
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

    // Derive path aliases for baseUrl-relative imports (e.g. "shared/*", "client/*").
    // Source files at src/{dir}/... are staged at src/{target}/{dir}/..., so a
    // bare "{dir}/*" import needs an alias to bridge the extra target prefix.
    //
    // Only "canonical" kinds (client/server/shared) define these aliases —
    // serverAction modules live in a different partition and are accessed via
    // the generated action registry, not bare baseUrl imports. Including them
    // would map "shared/*" → "src/server/shared/*", breaking cross-partition
    // imports of plain shared utilities like "shared/constants".
    const baseUrlAliases: Record<string, string[]> = {};
    const genDirPrefix = `src/${generatedDirRel}/`;
    for (const { record, target } of records) {
      if (record.kind === "serverAction") continue;
      const recordPath = toPosix(record.path);
      if (recordPath.startsWith(genDirPrefix)) continue;
      const sourceRel = recordPath.replace(/^src\//, "");
      const slash = sourceRel.indexOf("/");
      if (slash < 0) continue;
      const prefix = sourceRel.slice(0, slash);
      const pattern = `${prefix}/*`;
      if (!(pattern in baseUrlAliases)) {
        baseUrlAliases[pattern] = [`src/${target}/${prefix}/*`];
      }
    }

    const paths: Record<string, string[]> = {
      ...baseUrlAliases,
      // Split-tree layout: the generated files carry their partition subdir in the
      // source path (e.g. `<gen>/server/actions.server.generated.ts`), and staging
      // adds the target prefix on top — so the alias targets include both.
      "$aruna/actions/client": aliasPath("shared", "shared/actions.client.generated.ts"),
      "$aruna/actions/server": aliasPath("server", "server/actions.server.generated.ts"),
      "$aruna/signals": aliasPath("shared", "shared/signals.generated.ts"),
      ...runtimeAlias,
    };

    // Build typeRoots: start with "./node_modules" so roblox-ts can resolve the
    // package paths in the `types` field (e.g. "./node_modules/@rbxts/types").
    // Then add each scoped (@*) entry from the staged node_modules so roblox-ts
    // allows imports from those scopes — it rejects "@scope/pkg" imports when
    // the corresponding "./node_modules/@scope" isn't listed explicitly.
    const typeRoots: string[] = ["./node_modules"];
    const stagedNm = path.join(tempRoot, "node_modules");
    for (const entry of fs.readdirSync(stagedNm)) {
      if (entry.startsWith("@")) {
        typeRoots.push(`./node_modules/${entry}`);
      }
    }

    // Start from the consumer's own compilerOptions so the staged compile is the
    // one they configured — `jsx`/`jsxFactory`, rbxtsc `plugins` (transformers),
    // `experimentalDecorators`, `lib`, strictness flags. Rebuilding this config
    // from scratch silently dropped all of it: a project relying on a transformer
    // compiled with the transform absent.
    const inheritedOptions = readInheritedCompilerOptions(
      options.tsconfigPath ?? path.join(projectRoot, "tsconfig.json"),
    );
    // The consumer's own typeRoots are relative to their project root, which the
    // staged node_modules mirror reproduces — keep them alongside ours.
    const inheritedTypeRoots = Array.isArray(inheritedOptions["typeRoots"])
      ? (inheritedOptions["typeRoots"] as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    const mergedTypeRoots = [
      ...typeRoots,
      ...inheritedTypeRoots.filter((entry) => !typeRoots.includes(entry)),
    ];

    const tsconfig = {
      compilerOptions: stagedCompilerOptions(inheritedOptions, {
        target: "ESNext",
        module: "CommonJS",
        moduleResolution: "Node",
        moduleDetection: "force",
        noLib: true,
        baseUrl: ".",
        rootDir: "src",
        outDir: "out",
        declaration: false,
        declarationMap: false,
        downlevelIteration: true,
        allowSyntheticDefaultImports: true,
        esModuleInterop: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true,
        verbatimModuleSyntax: false,
        typeRoots: mergedTypeRoots,
        // Strictness is the consumer's call, not roblox-ts's — only supply a
        // default when their config is silent, or the staged build reports type
        // errors their own `tsc` never would.
        ...(inheritedOptions["strict"] === undefined ? { strict: true } : {}),
        ...(inheritedOptions["noUncheckedIndexedAccess"] === undefined
          ? { noUncheckedIndexedAccess: true }
          : {}),
        // `types` restricts which typeRoots packages load automatically, so only
        // impose our floor when the consumer left it unset.
        ...(inheritedOptions["types"] === undefined
          ? { types: ["@rbxts/types", "@rbxts/compiler-types"] }
          : {}),
        // jsx belongs to the consumer (react vs preserve, and the factory pair);
        // fall back to the roblox-ts default only when they say nothing.
        ...(inheritedOptions["jsx"] === undefined ? { jsx: "preserve" } : {}),
        paths,
      }),
      include: stagedIncludeGlobs(generatedDirRel),
      exclude: ["out", "node_modules"],
    };
    // roblox-ts requires a package.json at the project root.
    fs.writeFileSync(
      path.join(tempRoot, "package.json"),
      `${JSON.stringify({ name: "aruna-staged", version: "0.0.0" }, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(tempRoot, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`);
    // Pass every scoped (@*) package from staged node_modules so rojo-resolver
    // can locate their compiled output (e.g. @lattice-ui, @rbxts-js).
    const extraNpmScopes: string[] = [];
    for (const entry of fs.readdirSync(stagedNm)) {
      if (entry.startsWith("@") && entry !== "@rbxts") {
        extraNpmScopes.push(entry);
      }
    }
    fs.writeFileSync(
      path.join(tempRoot, "default.project.json"),
      `${JSON.stringify(partitionedRojoProject(extraNpmScopes), null, 2)}\n`,
    );

    const result = spawnSyncCommand(rbxtscBin, ["--project", tempRoot], {
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
      // Copy the rbxtsc-generated runtime library back so the Rojo `rbxts_include`
      // mount resolves when `rojo build` runs against the project.
      if (fs.existsSync(stagedInclude)) {
        const includeRoot = path.join(projectRoot, "include");
        fs.rmSync(includeRoot, { recursive: true, force: true });
        copyDirSync(stagedInclude, includeRoot);
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

export type RojoProjectShape = {
  // Scopes mounted inline next to `@rbxts`. Used by the staged compile, whose
  // temp root has no generated dir to point a nested project file at.
  readonly extraNpmScopes?: readonly string[] | undefined;
  // Project-relative path of the generated nested node_modules project file.
  // When set it replaces the inline scope list entirely, so the consumer's
  // project file stops needing an edit per dependency.
  readonly nodeModulesProject?: string | undefined;
};

// The Roblox DataModel contract the partitioned `out/` maps onto.
export function partitionedRojoProject(
  options: readonly string[] | RojoProjectShape = {},
): unknown {
  const shape: RojoProjectShape = Array.isArray(options)
    ? { extraNpmScopes: options }
    : (options as RojoProjectShape);
  const nodeModules: Record<string, unknown> =
    shape.nodeModulesProject !== undefined
      ? { $path: shape.nodeModulesProject }
      : {
          $className: "Folder",
          "@rbxts": { $path: "node_modules/@rbxts" },
        };
  if (shape.nodeModulesProject === undefined) {
    for (const scope of shape.extraNpmScopes ?? []) {
      nodeModules[scope] = { $path: `node_modules/${scope}` };
    }
  }
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
          node_modules: nodeModules,
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
