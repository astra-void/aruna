import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";

type PackageJson = {
  name?: string;
  version?: string;
  type?: string;
  main?: string;
  module?: string;
  types?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
  files?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export type VerifyPackageConsumptionArgs = {
  keepTemp: boolean;
};

export type PackedPackage = {
  name: string;
  tarballName: string;
  tarballPath: string;
};

export const publicArunaSubpathFiles = [
  "client.d.ts",
  "client.js",
  "roblox.d.ts",
  "roblox.js",
  "schema.d.ts",
  "schema.js",
  "server.d.ts",
  "server.js",
] as const;

export const forbiddenPackageConsumptionFragments = [
  "../../packages/aruna",
  "packages/aruna/src",
  "packages/aruna/dist",
  "include/aruna",
] as const;

type ConsumerPackageJson = {
  name: string;
  private: boolean;
  type: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

type JsonRecord = Record<string, unknown>;

type TsconfigJson = JsonRecord & {
  compilerOptions?: unknown;
};

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptRoot, "..");
const tempRoot = path.join(os.tmpdir(), "package-consumption-smoke");
const packsRoot = path.join(tempRoot, "packs");
const logsRoot = path.join(tempRoot, "logs");
const stagedRoot = path.join(tempRoot, "staged");
const pnpmStoreRoot = path.join(tempRoot, "pnpm-store");
const workspacePackagesRoot = path.join(tempRoot, "packages");

function parseBoolFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

export function parseVerifyPackageConsumptionArgs(
  argv: readonly string[] = process.argv.slice(2),
): VerifyPackageConsumptionArgs {
  for (const arg of argv) {
    if (arg === "--keep-temp") {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      throw new Error("Usage: tsx scripts/verify-package-consumption.ts [--keep-temp]");
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    keepTemp: parseBoolFlag(argv, "--keep-temp"),
  };
}

function getTarballFileSpecifier(tarballName: string): string {
  return `file:./packs/${tarballName}`;
}

function getPackedPackageOverrides(
  packedPackages: readonly PackedPackage[],
): Record<string, string> {
  return Object.fromEntries(
    packedPackages.map((packedPackage) => [
      packedPackage.name,
      getTarballFileSpecifier(packedPackage.tarballName),
    ]),
  );
}

export function buildConsumerPackageJson(
  packedPackages: readonly PackedPackage[],
): ConsumerPackageJson {
  const tarballByName = new Map(packedPackages.map((entry) => [entry.name, entry.tarballName]));
  const consumerDependencies: Record<string, string> = {};

  for (const packageName of ["aruna", "@arunajs/core", "@arunajs/compiler"]) {
    const tarballName = tarballByName.get(packageName);
    if (!tarballName) {
      throw new Error(`Missing tarball for ${packageName}.`);
    }
    consumerDependencies[packageName] = getTarballFileSpecifier(tarballName);
  }

  return {
    name: "package-consumption-smoke",
    private: true,
    type: "module",
    scripts: {
      doctor: "aruna doctor --fix --emit-runtime --project .",
      check: "aruna check --project .",
      build: "aruna build --emit-runtime --project .",
      inspect: "aruna inspect actions --project .",
      contract: "aruna inspect contract --project . --json",
      typecheck: "tsc -p tsconfig.typecheck.json --noEmit",
      rbxtsc: "rbxtsc --project .",
    },
    dependencies: consumerDependencies,
    devDependencies: {
      "@rbxts/compiler-types": "3.0.0-types.0",
      "@rbxts/types": "^1.0.920",
      "roblox-ts": "3.0.0",
      typescript: "^5.8.3",
    },
  };
}

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function resetDirectory(absolutePath: string): Promise<void> {
  await fs.rm(absolutePath, { recursive: true, force: true });
  await fs.mkdir(absolutePath, { recursive: true });
}

async function readJson<T>(absolutePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(absolutePath, "utf8")) as T;
}

async function writeJson(absolutePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(absolutePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents, "utf8");
}

function packageNameToWorkspacePath(packageName: string): string {
  return path.join(...packageName.split("/"));
}

export function rewriteWorkspaceVersions(
  dependencies: Record<string, string> | undefined,
  workspaceVersions: Record<string, string>,
  fallbackVersion: string,
): Record<string, string> | undefined {
  if (!dependencies) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(dependencies).map(([name, dependencyVersion]) => [
      name,
      dependencyVersion.startsWith("workspace:")
        ? workspaceVersions[name] ?? fallbackVersion
        : dependencyVersion,
    ]),
  );
}

export function findForbiddenPackageConsumptionFragments(contents: string): string[] {
  return forbiddenPackageConsumptionFragments.filter((fragment) => contents.includes(fragment));
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

// Split-tree generated layout (see packages/aruna/src/cli/tsconfig-paths.ts):
// client stubs + signals land in shared/, the server registry in server/, and the
// vendored runtime in shared/runtime/.
const GENERATED_CLIENT_ACTIONS_REL = "src/.aruna/shared/actions.client.generated.ts";
const GENERATED_SERVER_ACTIONS_REL = "src/.aruna/server/actions.server.generated.ts";
const GENERATED_RUNTIME_CLIENT_REL = "src/.aruna/shared/runtime/client.ts";

function formatGeneratedActionAliasFailure(logPath: string): string {
  return [
    "aruna doctor --fix did not install generated action aliases in tsconfig.json.",
    "Expected:",
    `  $aruna/actions/client -> ${GENERATED_CLIENT_ACTIONS_REL}`,
    `  $aruna/actions/server -> ${GENERATED_SERVER_ACTIONS_REL}`,
    `See ${logPath}`,
  ].join("\n");
}

function formatGeneratedActionFileFailure(logPath: string): string {
  return [
    "aruna build did not write generated action files before TypeScript.",
    "Expected generated files under src/.aruna.",
    `See ${logPath}`,
  ].join("\n");
}

function formatGeneratedActionImportFailure(logPath: string): string {
  return [
    "Generated action files did not use public Aruna subpaths.",
    "Expected the client stub to import aruna/client.",
    "Expected the server stub to stay on relative project imports.",
    `See ${logPath}`,
  ].join("\n");
}

export function buildConsumerTsconfigJson(tsconfigBasePath: string): string {
  return [
    "{",
    `  "extends": "${tsconfigBasePath}",`,
    '  "compilerOptions": {',
    '    "baseUrl": ".",',
    '    "module": "CommonJS",',
    '    "moduleDetection": "force",',
    '    "moduleResolution": "Node",',
    '    "declaration": false,',
    '    "declarationMap": false,',
    '    "paths": {},',
    '    "noLib": true,',
    '    "outDir": "out",',
    '    "rootDir": "src",',
    '    "jsx": "preserve",',
    '    "verbatimModuleSyntax": false,',
    '    "typeRoots": ["./node_modules", "./node_modules/@rbxts"],',
    '    "types": ["@rbxts/types", "@rbxts/compiler-types"]',
    "  },",
    // The generated dir is named explicitly — TypeScript's wildcard globs skip
    // dot-prefixed segments, so `src/**/*` alone leaves it out of the program.
    // Mirrors what `aruna init` scaffolds.
    '  "include": ["src/**/*.ts", "src/**/*.tsx", "src/.aruna/**/*.ts", "src/.aruna/**/*.tsx"],',
    '  "exclude": ["aruna.config.ts", "dist", "node_modules", "out"]',
    "}",
    "",
  ].join("\n");
}

export function buildConsumerTypecheckTsconfigJson(): string {
  return [
    "{",
    '  "extends": "./tsconfig.json",',
    '  "compilerOptions": {',
    '    "module": "ESNext",',
    '    "moduleResolution": "Bundler",',
    '    "rootDir": ".",',
    '    "noEmit": true',
    "  },",
    '  "include": ["src/**/*.ts", "src/**/*.tsx", "src/.aruna/**/*.ts", "src/.aruna/**/*.tsx", "aruna.config.ts"],',
    '  "exclude": ["dist", "node_modules", "out"]',
    "}",
    "",
  ].join("\n");
}

export function buildPublicPackageSubpathFiles(): readonly string[] {
  return publicArunaSubpathFiles;
}

export async function assertPublicPackageSubpathFiles(packageRoot: string): Promise<void> {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJson = await readJson<PackageJson>(packageJsonPath);
  const exportsRecord = packageJson.exports;

  if (!isRecord(exportsRecord)) {
    throw new Error(
      `Expected package exports to define public Aruna subpaths in ${packageJsonPath}.`,
    );
  }

  const expectedExports: Record<string, { import: string; types: string }> = {
    "./client": { import: "./client.js", types: "./client.d.ts" },
    "./roblox": { import: "./roblox.js", types: "./roblox.d.ts" },
    "./schema": { import: "./schema.js", types: "./schema.d.ts" },
    "./server": { import: "./server.js", types: "./server.d.ts" },
  };

  for (const [subpath, expected] of Object.entries(expectedExports)) {
    const actual = exportsRecord[subpath];
    if (!isRecord(actual) || actual.import !== expected.import || actual.types !== expected.types) {
      throw new Error(
        `Expected ${subpath} to map to ${expected.import} and ${expected.types} in ${packageJsonPath}.`,
      );
    }
  }

  for (const fileName of publicArunaSubpathFiles) {
    const absolutePath = path.join(packageRoot, fileName);
    if (!(await exists(absolutePath))) {
      throw new Error(`Missing public package subpath file: ${absolutePath}`);
    }

    const contents = await fs.readFile(absolutePath, "utf8");
    if (contents.trim().length === 0) {
      throw new Error(`Public package subpath file is empty: ${absolutePath}`);
    }
  }
}

export async function assertGeneratedActionAliases(projectRoot: string): Promise<void> {
  const tsconfigPath = path.join(projectRoot, "tsconfig.json");
  const doctorLogPath = path.join(projectRoot, "logs", "06-doctor-fix.log");
  const tsconfig = await readJson<TsconfigJson>(tsconfigPath);

  if (!isRecord(tsconfig)) {
    throw new Error(formatGeneratedActionAliasFailure(doctorLogPath));
  }

  const compilerOptions = tsconfig.compilerOptions;
  if (!isRecord(compilerOptions)) {
    throw new Error(formatGeneratedActionAliasFailure(doctorLogPath));
  }

  if (typeof compilerOptions.baseUrl !== "string" || compilerOptions.baseUrl.length === 0) {
    throw new Error(formatGeneratedActionAliasFailure(doctorLogPath));
  }

  const paths = compilerOptions.paths;
  if (!isRecord(paths)) {
    throw new Error(formatGeneratedActionAliasFailure(doctorLogPath));
  }

  const clientAlias = paths["$aruna/actions/client"];
  const serverAlias = paths["$aruna/actions/server"];
  if (
    !isStringArray(clientAlias) ||
    clientAlias.length !== 1 ||
    clientAlias[0] !== GENERATED_CLIENT_ACTIONS_REL ||
    !isStringArray(serverAlias) ||
    serverAlias.length !== 1 ||
    serverAlias[0] !== GENERATED_SERVER_ACTIONS_REL
  ) {
    throw new Error(formatGeneratedActionAliasFailure(doctorLogPath));
  }
}

export async function assertGeneratedActionFiles(projectRoot: string): Promise<void> {
  const buildLogPath = path.join(projectRoot, "logs", "08-build.log");
  const expectedFiles = [
    GENERATED_CLIENT_ACTIONS_REL,
    GENERATED_SERVER_ACTIONS_REL,
    "src/.aruna/manifest.json",
  ] as const;

  for (const relativePath of expectedFiles) {
    const absolutePath = path.join(projectRoot, relativePath);
    if (!(await exists(absolutePath))) {
      throw new Error(formatGeneratedActionFileFailure(buildLogPath));
    }

    const contents = await fs.readFile(absolutePath, "utf8");
    if (contents.trim().length === 0) {
      throw new Error(formatGeneratedActionFileFailure(buildLogPath));
    }
  }

  const clientContents = await fs.readFile(
    path.join(projectRoot, GENERATED_CLIENT_ACTIONS_REL),
    "utf8",
  );
  if (!clientContents.includes("export const purchaseItem =")) {
    throw new Error(formatGeneratedActionFileFailure(buildLogPath));
  }

  const serverContents = await fs.readFile(
    path.join(projectRoot, GENERATED_SERVER_ACTIONS_REL),
    "utf8",
  );
  if (!serverContents.includes("export const actions = {")) {
    throw new Error(formatGeneratedActionFileFailure(buildLogPath));
  }
}

export async function assertGeneratedActionImports(projectRoot: string): Promise<void> {
  const buildLogPath = path.join(projectRoot, "logs", "08-build.log");
  const clientContents = await fs.readFile(
    path.join(projectRoot, GENERATED_CLIENT_ACTIONS_REL),
    "utf8",
  );
  const serverContents = await fs.readFile(
    path.join(projectRoot, GENERATED_SERVER_ACTIONS_REL),
    "utf8",
  );
  const clientPackageImports = clientContents.match(/from "aruna[^"]*"/g) ?? [];
  const serverPackageImports = serverContents.match(/from "aruna[^"]*"/g) ?? [];

  if (
    clientPackageImports.length !== 1 ||
    clientPackageImports[0] !== 'from "aruna/client"' ||
    serverPackageImports.length !== 0
  ) {
    throw new Error(formatGeneratedActionImportFailure(buildLogPath));
  }
}

// Regression for the silent-oncompile bug: a project upgraded from the flat
// codegen layout must (1) have `aruna check` surface the desync, (2) have
// `aruna build` prune the stale flat artifacts, and (3) have `aruna doctor --fix`
// realign the tsconfig aliases onto the split-tree layout. Runs last, against the
// already-built smoke project.
export async function assertLayoutTransitionRegression(projectRoot: string): Promise<void> {
  // 1. Simulate the upgrade: plant flat-layout artifacts and point the aliases
  // back at them, exactly the state a pre-split-tree project lands in.
  const flatArtifacts = [
    "src/.aruna/actions.client.generated.ts",
    "src/.aruna/actions.server.generated.ts",
    "src/.aruna/signals.generated.ts",
    "src/.aruna/runtime/client.ts",
    "src/.aruna/runtime/server.ts",
  ];
  for (const relativePath of flatArtifacts) {
    await writeText(path.join(projectRoot, relativePath), "// stale flat-layout artifact\n");
  }

  const tsconfigPath = path.join(projectRoot, "tsconfig.json");
  const tsconfig = await readJson<TsconfigJson>(tsconfigPath);
  const compilerOptions = (
    isRecord(tsconfig.compilerOptions) ? tsconfig.compilerOptions : {}
  ) as JsonRecord;
  compilerOptions.paths = {
    ...(isRecord(compilerOptions.paths) ? compilerOptions.paths : {}),
    "$aruna/actions/client": ["src/.aruna/actions.client.generated.ts"],
    "$aruna/actions/server": ["src/.aruna/actions.server.generated.ts"],
    "$aruna/signals": ["src/.aruna/signals.generated.ts"],
    "aruna/client": ["src/.aruna/runtime/client.ts"],
  };
  tsconfig.compilerOptions = compilerOptions;
  await writeJson(tsconfigPath, tsconfig);

  // 2. `aruna check` must surface the desync (it exits 0 with warnings).
  await runCommand(
    "aruna check (stale layout)",
    "pnpm",
    ["exec", "aruna", "check", "--project", "."],
    projectRoot,
    "13-check-stale.log",
  );
  const checkLog = await fs.readFile(path.join(logsRoot, "13-check-stale.log"), "utf8");
  if (!checkLog.includes("Stale generated artifact") || !checkLog.includes("current emit layout")) {
    throw new Error(
      [
        "`aruna check` did not flag the flat-layout desync (expected aruna::110 + aruna::111).",
        `See ${path.join(logsRoot, "13-check-stale.log")}`,
      ].join("\n"),
    );
  }

  // 3. `aruna build` must prune the stale flat artifacts.
  await runCommand(
    "aruna build (prune stale)",
    "pnpm",
    ["exec", "aruna", "build", "--emit-runtime", "--no-emit-luau", "--project", "."],
    projectRoot,
    "14-build-prune.log",
  );
  for (const relativePath of [
    "src/.aruna/actions.client.generated.ts",
    "src/.aruna/actions.server.generated.ts",
    "src/.aruna/signals.generated.ts",
    "src/.aruna/runtime",
  ]) {
    if (await exists(path.join(projectRoot, relativePath))) {
      throw new Error(
        [
          `aruna build did not prune the stale artifact ${relativePath}.`,
          `See ${path.join(logsRoot, "14-build-prune.log")}`,
        ].join("\n"),
      );
    }
  }

  // 4. `aruna doctor --fix` must realign every alias onto the split-tree layout.
  await runCommand(
    "aruna doctor --fix (realign)",
    "pnpm",
    ["exec", "aruna", "doctor", "--fix", "--emit-runtime", "--project", "."],
    projectRoot,
    "15-doctor-realign.log",
  );
  await assertGeneratedActionAliases(projectRoot);
  const realigned = await readJson<TsconfigJson>(tsconfigPath);
  const realignedOptions = isRecord(realigned.compilerOptions) ? realigned.compilerOptions : {};
  const realignedPaths = isRecord(realignedOptions.paths) ? realignedOptions.paths : {};
  const runtimeClient = realignedPaths["aruna/client"];
  if (!isStringArray(runtimeClient) || runtimeClient[0] !== GENERATED_RUNTIME_CLIENT_REL) {
    throw new Error(
      [
        `aruna doctor --fix did not realign aruna/client to ${GENERATED_RUNTIME_CLIENT_REL}.`,
        `See ${path.join(logsRoot, "15-doctor-realign.log")}`,
      ].join("\n"),
    );
  }
}

async function stagePackage(options: {
  sourcePackageDirectory: string;
  stagedPackageDirectory: string;
  workspaceVersions?: Record<string, string>;
}): Promise<PackageJson> {
  const packageJsonPath = path.join(options.sourcePackageDirectory, "package.json");
  const sourcePackageJson = await readJson<PackageJson>(packageJsonPath);
  const distSource = path.join(options.sourcePackageDirectory, "dist");
  const distDestination = path.join(options.stagedPackageDirectory, "dist");
  const sourceVersion = sourcePackageJson.version ?? "0.0.0";
  const workspaceVersions = options.workspaceVersions ?? {};

  await fs.rm(options.stagedPackageDirectory, { recursive: true, force: true });
  await fs.mkdir(options.stagedPackageDirectory, { recursive: true });
  await fs.cp(distSource, distDestination, { recursive: true });
  for (const fileName of publicArunaSubpathFiles) {
    const sourcePath = path.join(options.sourcePackageDirectory, fileName);
    if (await exists(sourcePath)) {
      await fs.cp(sourcePath, path.join(options.stagedPackageDirectory, fileName));
    }
  }
  // The roblox-ts-native runtime source is shipped (via package "files") and
  // vendored into consumers by `aruna build --emit-runtime`. Only aruna has it.
  const robloxSource = path.join(options.sourcePackageDirectory, "roblox");
  if (await exists(robloxSource)) {
    await fs.cp(robloxSource, path.join(options.stagedPackageDirectory, "roblox"), {
      recursive: true,
    });
  }

  const stagedPackageJson: PackageJson = {
    name: sourcePackageJson.name,
    version: sourceVersion,
    type: sourcePackageJson.type,
    main: sourcePackageJson.main,
    module: sourcePackageJson.module,
    types: sourcePackageJson.types,
    bin: sourcePackageJson.bin,
    exports: sourcePackageJson.exports,
    files: sourcePackageJson.files ?? ["dist"],
    dependencies: rewriteWorkspaceVersions(
      sourcePackageJson.dependencies,
      workspaceVersions,
      sourceVersion,
    ),
    optionalDependencies: rewriteWorkspaceVersions(
      sourcePackageJson.optionalDependencies,
      workspaceVersions,
      sourceVersion,
    ),
    peerDependencies: rewriteWorkspaceVersions(
      sourcePackageJson.peerDependencies,
      workspaceVersions,
      sourceVersion,
    ),
  };

  await writeJson(path.join(options.stagedPackageDirectory, "package.json"), stagedPackageJson);
  return stagedPackageJson;
}

async function packDirectory(packageDirectory: string, packDestination: string): Promise<string> {
  const before = new Set(await fs.readdir(packDestination));
  const result = spawnSync("pnpm", ["pack", "--pack-destination", packDestination], {
    cwd: packageDirectory,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`Failed to pack ${packageDirectory}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const message = result.stderr || result.stdout || `pnpm pack failed for ${packageDirectory}`;
    throw new Error(message.trim());
  }

  const after = await fs.readdir(packDestination);
  const tarballs = after.filter((entry) => entry.endsWith(".tgz") && !before.has(entry));

  if (tarballs.length !== 1) {
    throw new Error(`Could not determine packed tarball for ${packageDirectory}.`);
  }

  return path.join(packDestination, tarballs[0]);
}

async function extractTarballToWorkspacePackage(
  tarballPath: string,
  packageName: string,
): Promise<string> {
  const destinationDirectory = path.join(
    workspacePackagesRoot,
    packageNameToWorkspacePath(packageName),
  );

  await fs.rm(destinationDirectory, { recursive: true, force: true });
  await fs.mkdir(destinationDirectory, { recursive: true });

  const result = spawnSync(
    "tar",
    ["-xzf", tarballPath, "-C", destinationDirectory, "--strip-components=1"],
    {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    },
  );

  if (result.error) {
    throw new Error(`Failed to extract ${packageName}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const message = result.stderr || result.stdout || `tar failed for ${packageName}`;
    throw new Error(message.trim());
  }

  return destinationDirectory;
}

async function runCommand(
  label: string,
  command: string,
  args: string[],
  cwd: string,
  logFile: string,
): Promise<void> {
  process.stdout.write(`$ ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      INIT_CWD: cwd,
      pnpm_config_store_dir: pnpmStoreRoot,
    },
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  await writeText(path.join(logsRoot, logFile), `${stdout}${stderr}`);

  if (stdout.length > 0) {
    process.stdout.write(stdout);
  }
  if (stderr.length > 0) {
    process.stderr.write(stderr);
  }

  if (result.error) {
    throw new Error(`${label} failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`${label} failed. See ${path.join(logsRoot, logFile)}`);
  }
}

function summarizeRbxtscFailure(logText: string): string {
  const summaries: string[] = [];

  if (logText.includes("You cannot use modules directly under node_modules.")) {
    summaries.push("rbxtsc rejected direct package imports from node_modules.");
  }

  if (logText.includes("Could not find Rojo data.")) {
    summaries.push("rbxtsc could not map emitted files to the current Rojo project tree.");
  }

  if (summaries.length === 0) {
    return "rbxtsc failed without a recognized summary.";
  }

  return summaries.join(" ");
}

async function createConsumerFiles(
  packedPackages: readonly PackedPackage[],
): Promise<void> {
  const tsconfigBasePath = path
    .join(workspaceRoot, "tsconfig.base.json");
  await writeJson(path.join(tempRoot, "package.json"), buildConsumerPackageJson(packedPackages));

  await writeText(
    path.join(tempRoot, "aruna.config.ts"),
    [
      'import { defineConfig } from "aruna";',
      "",
      "export default defineConfig({",
      '  compiler: {',
      '    generatedDir: "src/.aruna",',
      '    manifest: "src/.aruna/manifest.json",',
      "  },",
      "  actions: {",
      '    transport: "remote-event",',
      "    defaultRateLimit: {",
      '      key: "player",',
      "      windowMs: 1000,",
      "      max: 20,",
      "    },",
      "  },",
      "  conventions: {",
      '    client: ["src/client.tsx", "src/domains/**/ui.tsx"],',
      '    server: ["src/server.ts", "src/domains/**/actions.ts"],',
      '    shared: ["src/app/**", "src/shared/**", "src/domains/**/schema.ts", "src/domains/**/model.ts"],',
      "  },",
      "});",
      "",
    ].join("\n"),
  );

  await writeText(
    path.join(tempRoot, "tsconfig.json"),
    buildConsumerTsconfigJson(tsconfigBasePath),
  );

  await writeText(
    path.join(tempRoot, "tsconfig.typecheck.json"),
    buildConsumerTypecheckTsconfigJson(),
  );

  await writeText(
    path.join(tempRoot, "default.project.json"),
    [
      "{",
      '  "name": "aruna-package-consumption-smoke",',
      '  "globIgnorePaths": ["**/package.json", "**/tsconfig.json"],',
      '  "tree": {',
      '    "$className": "DataModel",',
      '    "ServerScriptService": {',
      '      "$className": "ServerScriptService",',
      '      "TS": { "$path": "out/server" }',
      "    },",
      '    "ReplicatedStorage": {',
      '      "$className": "ReplicatedStorage",',
      '      "rbxts_include": {',
      '        "$path": "include",',
      '        "node_modules": {',
      '          "$className": "Folder",',
      '          "@rbxts": {',
      '            "$path": "node_modules/@rbxts"',
      "          }",
      "        }",
      "      },",
      '      "TS": { "$path": "out/shared" }',
      "    },",
      '    "StarterPlayer": {',
      '      "$className": "StarterPlayer",',
      '      "StarterPlayerScripts": {',
      '        "$className": "StarterPlayerScripts",',
      '        "TS": { "$path": "out/client" }',
      "      }",
      "    },",
      '    "Workspace": {',
      '      "$className": "Workspace",',
      '      "$properties": {',
      '        "FilteringEnabled": true',
      "      }",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n"),
  );

  await writeText(path.join(tempRoot, "include", ".gitkeep"), "");

  await writeText(
    path.join(tempRoot, "src", "app", "bootstrap.ts"),
    [
      "export function createHarnessRequestId(): string {",
      '  return "package-consumption-request";',
      "}",
      "",
    ].join("\n"),
  );

  await writeText(
    path.join(tempRoot, "src", "app", "providers.ts"),
    ['export const packageConsumptionLabel = "package-consumption-harness";', ""].join("\n"),
  );

  await writeText(
    path.join(tempRoot, "src", "shared", "ids.ts"),
    ['export const shopActionId = "shop.purchaseItem";', ""].join("\n"),
  );

  await writeText(
    path.join(tempRoot, "src", "shared", "result.ts"),
    ['export type PurchaseResult = { ok: boolean };', ""].join("\n"),
  );

  await writeText(
    path.join(tempRoot, "src", "domains", "shop", "model.ts"),
    [
      "export function canPurchaseItem(itemId: string): boolean {",
      '  return itemId !== "";',
      "}",
      "",
    ].join("\n"),
  );

  await writeText(
    path.join(tempRoot, "src", "domains", "shop", "schema.ts"),
    [
      'import { schema } from "aruna/schema";',
      "",
      "export const purchaseItemInput = schema.object({",
      "  itemId: schema.string(),",
      "});",
      "",
      "export const purchaseItemOutput = schema.object({",
      "  ok: schema.boolean(),",
      "});",
      "",
    ].join("\n"),
  );

  await writeText(
    path.join(tempRoot, "src", "domains", "shop", "actions.ts"),
    [
      'import { defineAction } from "aruna/server";',
      'import { schema } from "aruna/schema";',
      'import { canPurchaseItem } from "./model";',
      "",
      "export const purchaseItem = defineAction({",
      '  id: "shop.purchaseItem",',
      '  rateLimit: { key: "player", windowMs: 1000, max: 5 },',
      "  input: schema.object({",
      "    itemId: schema.string(),",
      "  }),",
      "  output: schema.object({",
      "    ok: schema.boolean(),",
      "  }),",
      "  run(_ctx, input) {",
      "    return { ok: canPurchaseItem(input.itemId) };",
      "  },",
      "});",
      "",
    ].join("\n"),
  );

  await writeText(
    path.join(tempRoot, "src", "client.tsx"),
    [
      'import { createClientApp } from "aruna/client";',
      'import { createActionInvoker } from "aruna/roblox";',
      'import { purchaseItem } from "$aruna/actions/client";',
      'import { createHarnessRequestId } from "./app/bootstrap";',
      'import { packageConsumptionLabel } from "./app/providers";',
      "",
      "export function startClientApp() {",
      "  const clientApp = createClientApp({",
      "    invoker: createActionInvoker({",
      "      createRequestId: createHarnessRequestId,",
      "    }),",
      "  });",
      "",
      "  void purchaseItem({",
      "    itemId: packageConsumptionLabel,",
      "  });",
      "",
      "  return clientApp;",
      "}",
      "",
      "startClientApp();",
      "",
    ].join("\n"),
  );

  await writeText(
    path.join(tempRoot, "src", "server.ts"),
    [
      'import { createServerApp } from "aruna/server";',
      'import { robloxRemoteEvent } from "aruna/roblox";',
      'import { actions } from "$aruna/actions/server";',
      "",
      "export function startServerApp() {",
      "  // The app owns the transport binding (recommended wiring): every dispatch",
      "  // option, including defaultRateLimit, reaches the wire.",
      "  const serverApp = createServerApp<Player>({",
      "    actions,",
      "    transport: robloxRemoteEvent(),",
      "  });",
      "",
      "  return serverApp;",
      "}",
      "",
      "startServerApp();",
      "",
    ].join("\n"),
  );
}

async function runChecks(): Promise<void> {
  const corePackageJson = await readJson<PackageJson>(
    path.join(workspaceRoot, "packages", "core", "package.json"),
  );
  const compilerPackageJsonSource = await readJson<PackageJson>(
    path.join(workspaceRoot, "packages", "compiler", "package.json"),
  );

  const coreVersion = corePackageJson.version;
  const compilerVersion = compilerPackageJsonSource.version;

  if (
    typeof coreVersion !== "string" ||
    coreVersion.length === 0 ||
    typeof compilerVersion !== "string" ||
    compilerVersion.length === 0
  ) {
    throw new Error("Could not determine package versions for the packed smoke.");
  }

  await resetDirectory(tempRoot);
  await fs.mkdir(packsRoot, { recursive: true });
  await fs.mkdir(logsRoot, { recursive: true });
  await fs.mkdir(stagedRoot, { recursive: true });
  await fs.mkdir(pnpmStoreRoot, { recursive: true });

  await runCommand("build:native", "pnpm", ["build:native"], workspaceRoot, "01-build-native.log");
  await runCommand(
    "@arunajs/core build",
    "pnpm",
    ["--filter", "@arunajs/core", "build"],
    workspaceRoot,
    "02-core-build.log",
  );
  await runCommand(
    "@arunajs/compiler build",
    "pnpm",
    ["--filter", "@arunajs/compiler", "build"],
    workspaceRoot,
    "03-compiler-build.log",
  );
  await runCommand(
    "aruna build",
    "pnpm",
    ["--filter", "aruna", "build"],
    workspaceRoot,
    "04-aruna-build.log",
  );

  const corePackageDirectory = path.join(workspaceRoot, "packages", "core");
  const arunaPackageDirectory = path.join(workspaceRoot, "packages", "aruna");
  const stagedCoreDirectory = path.join(stagedRoot, "core");
  const stagedArunaDirectory = path.join(stagedRoot, "aruna");

  await stagePackage({
    sourcePackageDirectory: corePackageDirectory,
    stagedPackageDirectory: stagedCoreDirectory,
  });
  await stagePackage({
    sourcePackageDirectory: arunaPackageDirectory,
    stagedPackageDirectory: stagedArunaDirectory,
    workspaceVersions: {
      "@arunajs/core": coreVersion,
      "@arunajs/compiler": compilerVersion,
    },
  });

  const packedPackages: PackedPackage[] = [];
  const coreTarballPath = await packDirectory(stagedCoreDirectory, packsRoot);
  packedPackages.push({
    name: "@arunajs/core",
    tarballName: path.basename(coreTarballPath),
    tarballPath: coreTarballPath,
  });
  const arunaTarballPath = await packDirectory(stagedArunaDirectory, packsRoot);
  packedPackages.push({
    name: "aruna",
    tarballName: path.basename(arunaTarballPath),
    tarballPath: arunaTarballPath,
  });

  const compilerPackageDirectory = path.join(workspaceRoot, ".npm", "compiler");
  if (!(await exists(compilerPackageDirectory))) {
    throw new Error("Expected staged compiler package under .npm/compiler.");
  }

  const compilerPackageJson = await readJson<PackageJson>(
    path.join(compilerPackageDirectory, "package.json"),
  );
  const compilerTarballPath = await packDirectory(compilerPackageDirectory, packsRoot);
  packedPackages.push({
    name: compilerPackageJson.name ?? "@arunajs/compiler",
    tarballName: path.basename(compilerTarballPath),
    tarballPath: compilerTarballPath,
  });

  const nativePackageDirectories = (
    await fs.readdir(path.join(workspaceRoot, ".npm"), { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("compiler-"))
    .map((entry) => path.join(workspaceRoot, ".npm", entry.name))
    .sort();

  for (const nativePackageDirectory of nativePackageDirectories) {
    const packageJson = await readJson<PackageJson>(path.join(nativePackageDirectory, "package.json"));
    const tarballPath = await packDirectory(nativePackageDirectory, packsRoot);
    packedPackages.push({
      name: packageJson.name ?? path.basename(nativePackageDirectory),
      tarballName: path.basename(tarballPath),
      tarballPath,
    });
  }

  await fs.mkdir(workspacePackagesRoot, { recursive: true });
  for (const packedPackage of packedPackages) {
    await extractTarballToWorkspacePackage(packedPackage.tarballPath, packedPackage.name);
  }

  const workspaceOverrides = getPackedPackageOverrides(packedPackages);
  await writeText(
    path.join(tempRoot, "pnpm-workspace.yaml"),
    [
      "packages:",
      '  - "packages/**"',
      "overrides:",
      ...Object.entries(workspaceOverrides).map(([packageName, tarballSpec]) => {
        return `  ${JSON.stringify(packageName)}: ${JSON.stringify(tarballSpec)}`;
      }),
      "",
    ].join("\n"),
  );

  await createConsumerFiles(packedPackages);

  try {
    await runCommand("pnpm install", "pnpm", ["install"], tempRoot, "05-install.log");
  } catch (error) {
    const installLogPath = path.join(logsRoot, "05-install.log");
    const installLog = (await exists(installLogPath))
      ? await fs.readFile(installLogPath, "utf8")
      : "";
    const localPackageNames = packedPackages.map((entry) => entry.name);
    const registryLookups = getRegistryLookupsForLocalPackages(installLog, localPackageNames);

    if (registryLookups.length > 0) {
      throw new Error(
        [
          "Packed package consumption failed because a local Aruna package was resolved from the npm registry.",
          "Check pnpm.overrides in the generated smoke package.json.",
          `Registry lookups: ${registryLookups.join(", ")}`,
          `Install log: ${installLogPath}`,
        ].join("\n"),
      );
    }

    throw error;
  }
  await runCommand(
    "aruna doctor --fix",
    "pnpm",
    ["exec", "aruna", "doctor", "--fix", "--emit-runtime", "--project", "."],
    tempRoot,
    "06-doctor-fix.log",
  );
  await runCommand(
    "aruna check",
    "pnpm",
    ["exec", "aruna", "check", "--project", "."],
    tempRoot,
    "07-check.log",
  );
  await runCommand(
    "aruna build",
    "pnpm",
    ["exec", "aruna", "build", "--emit-runtime", "--project", "."],
    tempRoot,
    "08-build.log",
  );
  await assertGeneratedActionAliases(tempRoot);
  await assertGeneratedActionFiles(tempRoot);
  await assertGeneratedActionImports(tempRoot);
  await runCommand(
    "aruna inspect actions",
    "pnpm",
    ["exec", "aruna", "inspect", "actions", "--project", "."],
    tempRoot,
    "09-inspect-actions.log",
  );
  await runCommand(
    "aruna inspect contract --json",
    "pnpm",
    ["exec", "aruna", "inspect", "contract", "--project", ".", "--json"],
    tempRoot,
    "10-inspect-contract.log",
  );
  await runCommand(
    "tsc",
    "pnpm",
    ["exec", "tsc", "-p", "tsconfig.typecheck.json", "--noEmit"],
    tempRoot,
    "11-typecheck.log",
  );
  await assertPublicPackageSubpathFiles(path.join(tempRoot, "node_modules", "aruna"));
  // Final Luau-compile gate. Use the turnkey `aruna build` (which partitions the
  // project into client/server/shared and runs rbxtsc against the service-separated
  // default.project.json) rather than a bare `rbxtsc --project .`: the partition
  // contract means plain rbxtsc can't map the emitted out/ onto the Rojo tree.
  try {
    await runCommand(
      "aruna build (luau compile)",
      "pnpm",
      ["exec", "aruna", "build", "--emit-runtime", "--project", "."],
      tempRoot,
      "12-rbxtsc.log",
    );
  } catch (error) {
    const rbxtscLogPath = path.join(logsRoot, "12-rbxtsc.log");
    const rbxtscLog = (await exists(rbxtscLogPath)) ? await fs.readFile(rbxtscLogPath, "utf8") : "";
    throw new Error(
      [
        summarizeRbxtscFailure(rbxtscLog),
        `rbxtsc log: ${rbxtscLogPath}`,
        error instanceof Error ? error.message : String(error),
      ].join("\n"),
    );
  }

  const scanTargets = [
    path.join(tempRoot, "aruna.config.ts"),
    path.join(tempRoot, "default.project.json"),
    path.join(tempRoot, "package.json"),
    path.join(tempRoot, "src"),
  ];

  for (const scanTarget of scanTargets) {
    if (!(await exists(scanTarget))) {
      continue;
    }

    const stats = await fs.stat(scanTarget);
    if (stats.isFile()) {
      const contents = await fs.readFile(scanTarget, "utf8");
      for (const fragment of findForbiddenPackageConsumptionFragments(contents)) {
        throw new Error(`Forbidden reference found in ${scanTarget}: ${fragment}`);
      }
      continue;
    }

    const stack = [scanTarget];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }

      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(absolute);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        const contents = await fs.readFile(absolute, "utf8");
        for (const fragment of findForbiddenPackageConsumptionFragments(contents)) {
          throw new Error(`Forbidden reference found in ${absolute}: ${fragment}`);
        }
      }
    }
  }

  // Last, exercise the flat -> split-tree layout transition (stale prune + check
  // desync + doctor realign). Runs after the main flow so it can perturb the
  // already-validated project without disturbing the earlier assertions.
  await assertLayoutTransitionRegression(tempRoot);
}

function getRegistryLookupsForLocalPackages(
  logText: string,
  localPackageNames: readonly string[],
): string[] {
  if (logText.length === 0) {
    return [];
  }

  const registryMarker = "registry.npmjs.org/";
  if (!logText.includes(registryMarker)) {
    return [];
  }

  const matches = new Set<string>();
  for (const packageName of localPackageNames) {
    const encodedName = packageName.replaceAll("/", "%2F");
    if (
      logText.includes(`${registryMarker}${packageName}`) ||
      logText.includes(`${registryMarker}${encodedName}`)
    ) {
      matches.add(packageName);
    }
  }

  return [...matches];
}

async function main(): Promise<void> {
  const { keepTemp } = parseVerifyPackageConsumptionArgs();

  try {
    await runChecks();
    if (!keepTemp) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.stderr.write(`Temp project: ${tempRoot}\n`);

    if (await exists(logsRoot)) {
      const logs = (await fs.readdir(logsRoot)).sort();
      for (const log of logs) {
        process.stderr.write(`Log: ${path.join(logsRoot, log)}\n`);
      }
    }

    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
