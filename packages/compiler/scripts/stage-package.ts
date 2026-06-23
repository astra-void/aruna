import fs from "node:fs/promises";
import path from "node:path";

export type StageWorkspacePackageOptions = {
  /** Absolute path to the source package directory (e.g. packages/aruna). */
  sourcePackageDirectory: string;
  /** Absolute path the staged package is written to (e.g. .npm/aruna). */
  stagedPackageDirectory: string;
  /** Release version stamped onto the staged manifest (lockstep across the graph). */
  version: string;
};

export type StagedWorkspacePackage = {
  packageDirectory: string;
  packageJsonPath: string;
  name: string;
};

type SourcePackageJson = {
  name?: string;
  version?: string;
  type?: string;
  repository?: unknown;
  bin?: string | Record<string, string>;
  main?: string;
  module?: string;
  types?: string;
  exports?: unknown;
  files?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rewrites every `workspace:*`-style dependency to the single release version.
 * Non-workspace specifiers (commander, picocolors, …) are passed through.
 */
export function rewriteWorkspaceDependencies(
  dependencies: Record<string, string> | undefined,
  version: string,
): Record<string, string> | undefined {
  if (!dependencies) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(dependencies).map(([name, specifier]) => [
      name,
      specifier.startsWith("workspace:") ? version : specifier,
    ]),
  );
}

/**
 * Copies the entries declared in package `files` into the staging directory.
 * Handles literal files, directories (recursively), and the root-level `*.ext`
 * globs that aruna uses for its compiled shim files (server.js, schema.d.ts, …).
 */
async function copyPackageFiles(
  sourceDirectory: string,
  stagedDirectory: string,
  files: string[],
): Promise<void> {
  for (const entry of files) {
    if (entry.startsWith("*")) {
      const suffix = entry.slice(1);
      const rootEntries = await fs.readdir(sourceDirectory, { withFileTypes: true });
      for (const dirent of rootEntries) {
        if (dirent.isFile() && dirent.name.endsWith(suffix)) {
          await fs.cp(
            path.join(sourceDirectory, dirent.name),
            path.join(stagedDirectory, dirent.name),
          );
        }
      }
      continue;
    }

    const source = path.join(sourceDirectory, entry);
    if (await exists(source)) {
      await fs.cp(source, path.join(stagedDirectory, entry), { recursive: true });
    }
  }
}

/**
 * Stages a workspace package (core, aruna) into a publishable directory:
 * copies its declared `files`, stamps the lockstep version, and rewrites
 * `workspace:*` dependencies to that version so npm can resolve them.
 */
export async function stageWorkspacePackage(
  options: StageWorkspacePackageOptions,
): Promise<StagedWorkspacePackage> {
  const sourcePackageJsonPath = path.join(options.sourcePackageDirectory, "package.json");
  const sourcePackageJson = JSON.parse(
    await fs.readFile(sourcePackageJsonPath, "utf8"),
  ) as SourcePackageJson;

  if (!sourcePackageJson.name) {
    throw new Error(`Package at ${options.sourcePackageDirectory} is missing a name.`);
  }

  const files = sourcePackageJson.files ?? ["dist"];

  await fs.rm(options.stagedPackageDirectory, { recursive: true, force: true });
  await fs.mkdir(options.stagedPackageDirectory, { recursive: true });
  await copyPackageFiles(options.sourcePackageDirectory, options.stagedPackageDirectory, files);

  const stagedPackageJson = {
    name: sourcePackageJson.name,
    version: options.version,
    type: sourcePackageJson.type,
    repository: sourcePackageJson.repository,
    bin: sourcePackageJson.bin,
    main: sourcePackageJson.main,
    module: sourcePackageJson.module,
    types: sourcePackageJson.types,
    exports: sourcePackageJson.exports,
    files,
    dependencies: rewriteWorkspaceDependencies(sourcePackageJson.dependencies, options.version),
    optionalDependencies: rewriteWorkspaceDependencies(
      sourcePackageJson.optionalDependencies,
      options.version,
    ),
    peerDependencies: rewriteWorkspaceDependencies(
      sourcePackageJson.peerDependencies,
      options.version,
    ),
  };

  const packageJsonPath = path.join(options.stagedPackageDirectory, "package.json");
  await fs.writeFile(packageJsonPath, `${JSON.stringify(stagedPackageJson, null, 2)}\n`, "utf8");

  return {
    packageDirectory: options.stagedPackageDirectory,
    packageJsonPath,
    name: sourcePackageJson.name,
  };
}
