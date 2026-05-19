import fs from "node:fs/promises";
import path from "node:path";
import {
  nativePackageName,
  stagedCompilerPackageDirectory,
  type NativeTarget,
} from "./native-targets.js";

export type StageCompilerPackageOptions = {
  workspaceRoot: string;
  version: string;
  nativeTargets: readonly NativeTarget[];
  allowMissingDist?: boolean;
};

export type StagedCompilerPackage = {
  packageDirectory: string;
  packageJsonPath: string;
};

type SourcePackageJson = {
  name?: string;
  version?: string;
  type?: string;
  main?: string;
  module?: string;
  types?: string;
  exports?: unknown;
  files?: string[];
  dependencies?: Record<string, string>;
};

function replaceWorkspaceProtocol(value: string, replacement: string): string {
  return value.startsWith("workspace:") ? replacement : value;
}

function sanitizeDependencies(
  dependencies: Record<string, string> | undefined,
  replacement: string,
): Record<string, string> | undefined {
  if (!dependencies) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(dependencies).map(([name, version]) => [
      name,
      replaceWorkspaceProtocol(version, replacement),
    ]),
  );
}

export async function stageCompilerPackage(
  options: StageCompilerPackageOptions & { allowMissingDist: true },
): Promise<StagedCompilerPackage | null>;
export async function stageCompilerPackage(
  options: StageCompilerPackageOptions,
): Promise<StagedCompilerPackage>;
export async function stageCompilerPackage(
  options: StageCompilerPackageOptions,
): Promise<StagedCompilerPackage | null> {
  const packageDirectory = stagedCompilerPackageDirectory(options.workspaceRoot);
  const packageJsonPath = path.join(packageDirectory, "package.json");
  const sourcePackageDirectory = path.join(options.workspaceRoot, "packages", "compiler");
  const sourcePackageJsonPath = path.join(sourcePackageDirectory, "package.json");
  const sourceDistDirectory = path.join(sourcePackageDirectory, "dist");
  const sourcePackageJson = JSON.parse(
    await fs.readFile(sourcePackageJsonPath, "utf8"),
  ) as SourcePackageJson;

  try {
    await fs.access(sourceDistDirectory);
  } catch {
    if (options.allowMissingDist) {
      return null;
    }
    throw new Error(
      `Compiler package dist directory is missing: ${path.join(sourcePackageDirectory, "dist")}`,
    );
  }

  await fs.mkdir(packageDirectory, { recursive: true });
  await fs.cp(sourceDistDirectory, path.join(packageDirectory, "dist"), { recursive: true });

  const stagedPackageJson = {
    name: sourcePackageJson.name ?? "@arunajs/compiler",
    version: options.version,
    type: sourcePackageJson.type,
    main: sourcePackageJson.main,
    module: sourcePackageJson.module,
    types: sourcePackageJson.types,
    exports: sourcePackageJson.exports,
    files: sourcePackageJson.files ?? ["dist"],
    dependencies: sanitizeDependencies(sourcePackageJson.dependencies, options.version),
    ...(options.nativeTargets.length > 0
      ? {
          optionalDependencies: Object.fromEntries(
            options.nativeTargets.map((target) => [nativePackageName(target), options.version]),
          ),
        }
      : {}),
  };

  await fs.writeFile(packageJsonPath, `${JSON.stringify(stagedPackageJson, null, 2)}\n`, "utf8");

  return {
    packageDirectory,
    packageJsonPath,
  };
}
