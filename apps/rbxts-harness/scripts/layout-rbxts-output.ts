import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { loadProjectConfig } from "../../../packages/compiler/src/config.ts";

type LayoutTarget = "client" | "server" | "shared";

type LayoutModuleKind =
  | "client"
  | "server"
  | "shared"
  | "clientEntry"
  | "serverEntry"
  | "serverAction"
  | "unknown";

type LayoutManifest = {
  version: 1;
  projectRoot: string;
  modules: Array<{
    path: string;
    kind: LayoutModuleKind;
  }>;
};

type LayoutEntry = {
  source: string;
  kind: LayoutModuleKind;
  target: LayoutTarget;
  entry: boolean;
};

type LayoutMetadata = {
  version: 1;
  rootDir: string;
  targets: LayoutEntry[];
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const workspaceRoot = path.resolve(projectRoot, "..", "..");
const sourceRoot = path.join(projectRoot, "src");
const outputRoot = path.join(projectRoot, "out");
const tempRootPrefix = path.join(workspaceRoot, "tmp", "rbxts-harness-");
let generatedRootRelative = ".aruna";

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function stripSourcePrefix(relativePath: string): string {
  return relativePath.startsWith("src/") ? relativePath.slice("src/".length) : relativePath;
}

function stripModuleExtension(filePath: string): string {
  if (
    filePath.endsWith(".ts") ||
    filePath.endsWith(".tsx") ||
    filePath.endsWith(".js") ||
    filePath.endsWith(".jsx") ||
    filePath.endsWith(".mjs") ||
    filePath.endsWith(".cjs")
  ) {
    return filePath.replace(/\.[^.]+$/, "");
  }

  if (filePath.endsWith(".d.ts")) {
    return filePath.slice(0, -".d.ts".length);
  }

  return filePath;
}

function hasTsExtension(filePath: string): boolean {
  return filePath.endsWith(".ts") || filePath.endsWith(".tsx");
}

function getScriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }

  if (filePath.endsWith(".ts")) {
    return ts.ScriptKind.TS;
  }

  return ts.ScriptKind.Unknown;
}

function isEntryModule(kind: LayoutModuleKind): boolean {
  return kind === "clientEntry" || kind === "serverEntry";
}

function resolveLayoutTarget(module: LayoutManifest["modules"][number]): LayoutTarget {
  const normalizedPath = toPosix(module.path);

  if (normalizedPath.startsWith(`src/${generatedRootRelative}/`)) {
    return module.kind === "serverAction" ? "server" : "shared";
  }

  switch (module.kind) {
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

function stageRelativePath(module: LayoutManifest["modules"][number]): string {
  const target = resolveLayoutTarget(module);
  const sourceRelative = stripSourcePrefix(toPosix(module.path));
  const extension = path.posix.extname(sourceRelative);

  if (isEntryModule(module.kind)) {
    if (target === "client") {
      return `client/main.client${extension || ".ts"}`;
    }

    if (target === "server") {
      return `server/main.server${extension || ".ts"}`;
    }
  }

  if (sourceRelative.startsWith("shared/")) {
    return `shared/${sourceRelative.slice("shared/".length)}`;
  }

  return `${target}/${sourceRelative}`;
}

function buildLayoutMetadata(manifest: LayoutManifest): LayoutMetadata {
  const targets = manifest.modules.map((module) => ({
    source: toPosix(module.path),
    kind: module.kind,
    target: resolveLayoutTarget(module),
    entry: isEntryModule(module.kind),
  }));

  targets.sort((left, right) =>
    left.source.localeCompare(right.source) ||
    left.kind.localeCompare(right.kind) ||
    left.target.localeCompare(right.target) ||
    Number(left.entry) - Number(right.entry),
  );

  return {
    version: 1,
    rootDir: "src",
    targets,
  };
}

function resolveModuleImport(
  importerSourcePath: string,
  specifier: string,
  knownSources: Set<string>,
): string | undefined {
  const normalizedSpecifier = toPosix(specifier);
  if (!normalizedSpecifier.startsWith(".")) {
    return undefined;
  }

  const importerDir = path.posix.dirname(importerSourcePath);
  const base = toPosix(path.posix.normalize(path.posix.join(importerDir, normalizedSpecifier)));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.d.ts`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.d.ts`,
    `${base}/index.js`,
    `${base}/index.jsx`,
  ];

  return candidates.find((candidate) => knownSources.has(candidate));
}

function formatStageImport(importerStagePath: string, importedStagePath: string): string {
  const importerDirectory = path.posix.dirname(importerStagePath);
  const targetPath = stripModuleExtension(importedStagePath);
  const relativePath = toPosix(path.posix.relative(importerDirectory, targetPath));

  if (relativePath === "") {
    return ".";
  }

  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

function isModuleSpecifierNode(node: ts.StringLiteralLike): boolean {
  const parent = node.parent;
  return (
    (ts.isImportDeclaration(parent) && parent.moduleSpecifier === node) ||
    (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node) ||
    (ts.isImportTypeNode(parent) && parent.argument === node) ||
    (ts.isCallExpression(parent) &&
      parent.expression.kind === ts.SyntaxKind.ImportKeyword &&
      parent.arguments[0] === node)
  );
}

async function rewriteStageContents(
  importerSourcePath: string,
  importerStagePath: string,
  contents: string,
  knownSources: Set<string>,
  sourceToStage: Map<string, string>,
): Promise<string> {
  if (!hasTsExtension(importerSourcePath)) {
    return contents;
  }

  const sourceFile = ts.createSourceFile(
    importerSourcePath,
    contents,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(importerSourcePath),
  );

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const visit: ts.Visitor = (node) => {
      if (ts.isStringLiteralLike(node) && isModuleSpecifierNode(node)) {
        const sourceImport = resolveModuleImport(importerSourcePath, node.text, knownSources);
        if (sourceImport) {
          const importedStagePath = sourceToStage.get(sourceImport);
          if (importedStagePath) {
            const nextSpecifier = formatStageImport(importerStagePath, importedStagePath);
            if (nextSpecifier !== node.text) {
              return ts.factory.createStringLiteral(nextSpecifier);
            }
          }
        }
      }

      return ts.visitEachChild(node, visit, context);
    };

    return (rootNode) => ts.visitNode(rootNode, visit);
  };

  const result = ts.transform(sourceFile, [transformer]);
  try {
    const transformed = result.transformed[0];
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    return printer.printFile(transformed);
  } finally {
    result.dispose();
  }
}

async function walkSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }

  await walk(root);
  return files;
}

async function writeJsonFile(absolutePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeLayoutMetadata(manifest: LayoutManifest): Promise<LayoutMetadata> {
  const layout = buildLayoutMetadata(manifest);
  await writeJsonFile(path.join(sourceRoot, generatedRootRelative, "rbxts-layout.json"), layout);
  return layout;
}

async function stageSourceTree(
  tempRoot: string,
  layout: LayoutMetadata,
): Promise<void> {
  const stageRoot = path.join(tempRoot, "src");
  const sourceFiles = await walkSourceFiles(sourceRoot);
  const sourceToStage = new Map<string, string>();
  const knownSources = new Set<string>();
  const layoutBySource = new Map(layout.targets.map((target) => [target.source, target]));

  for (const entry of layout.targets) {
    knownSources.add(entry.source);
    sourceToStage.set(entry.source, stageRelativePath({ path: entry.source, kind: entry.kind }));
  }

  for (const absoluteSourcePath of sourceFiles) {
    const relativeSourcePath = toPosix(path.relative(sourceRoot, absoluteSourcePath));

    if (layoutBySource.has(`src/${relativeSourcePath}`)) {
      const module = layoutBySource.get(`src/${relativeSourcePath}`)!;
      const destination = path.join(stageRoot, sourceToStage.get(module.source)!);
      const contents = await fs.readFile(absoluteSourcePath, "utf8");
      const stagedContents = await rewriteStageContents(
        module.source,
        sourceToStage.get(module.source)!,
        contents,
        knownSources,
        sourceToStage,
      );
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, stagedContents);
      continue;
    }

    if (relativeSourcePath.startsWith(`${generatedRootRelative}/`)) {
      const destination = path.join(stageRoot, "shared", relativeSourcePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(absoluteSourcePath, destination);
    }
  }
}

async function main(): Promise<void> {
  await fs.mkdir(path.join(workspaceRoot, "tmp"), { recursive: true });
  const tempRoot = await fs.mkdtemp(tempRootPrefix);

  try {
    const loadedConfig = loadProjectConfig(projectRoot);
    generatedRootRelative = toPosix(
      path.relative(sourceRoot, path.resolve(projectRoot, loadedConfig.config.generatedDir)),
    );

    await fs.mkdir(path.join(tempRoot, "include"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "node_modules"), { recursive: true });
    await fs.symlink(
      path.join(projectRoot, "node_modules", "@rbxts"),
      path.join(tempRoot, "node_modules", "@rbxts"),
      "dir",
    );
    await fs.symlink(
      path.join(workspaceRoot, "node_modules", "@types"),
      path.join(tempRoot, "node_modules", "@types"),
      "dir",
    );

    const manifestPath = path.resolve(projectRoot, loadedConfig.config.manifestOutput);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as LayoutManifest;
    const layout = await writeLayoutMetadata(manifest);
    await stageSourceTree(tempRoot, layout);

    const tsconfig = {
      extends: "../../tsconfig.base.json",
      compilerOptions: {
        baseUrl: ".",
        module: "CommonJS",
        moduleDetection: "force",
        moduleResolution: "Node",
        declaration: false,
        declarationMap: false,
        paths: {
          aruna: ["../../packages/aruna/dist/index.d.ts"],
          "aruna/*": ["../../packages/aruna/dist/*.d.ts"],
          "$aruna/actions/client": [`src/shared/${generatedRootRelative}/actions.client.generated.ts`],
          "$aruna/actions/server": [`src/server/${generatedRootRelative}/actions.server.generated.ts`],
        },
        noLib: true,
        outDir: "out",
        rootDir: "src",
        jsx: "preserve",
        verbatimModuleSyntax: false,
        typeRoots: ["./node_modules", "./node_modules/@rbxts"],
        types: ["@rbxts/types", "@rbxts/compiler-types"],
      },
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["dist", "node_modules"],
    };

    const defaultProject = JSON.parse(
      await fs.readFile(path.join(projectRoot, "default.project.json"), "utf8"),
    ) as Record<string, unknown>;

    await fs.writeFile(
      path.join(tempRoot, "tsconfig.json"),
      `${JSON.stringify(tsconfig, null, 2)}\n`,
    );
    await fs.writeFile(
      path.join(tempRoot, "default.project.json"),
      `${JSON.stringify(defaultProject, null, 2)}\n`,
    );

    const result = spawnSync("pnpm", ["exec", "rbxtsc", "--project", tempRoot], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: "inherit",
    });

    if (result.status !== 0) {
      throw new Error("rbxtsc failed");
    }

    await fs.rm(outputRoot, { recursive: true, force: true });
    await fs.cp(path.join(tempRoot, "out"), outputRoot, { recursive: true });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
