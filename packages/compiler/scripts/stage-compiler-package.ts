import fs from "node:fs/promises";
import path from "node:path";
import {
  nativePackageName,
  stagedCompilerPackageDirectory,
  SUPPORTED_NATIVE_TARGETS,
} from "./native-targets.ts";

export type StageCompilerPackageOptions = {
  workspaceRoot: string;
  version: string;
};

export type StagedCompilerPackage = {
  packageDirectory: string;
  packageJsonPath: string;
};

export async function stageCompilerPackage(options: StageCompilerPackageOptions): Promise<StagedCompilerPackage> {
  const packageDirectory = stagedCompilerPackageDirectory(options.workspaceRoot);
  const packageJsonPath = path.join(packageDirectory, "package.json");

  await fs.mkdir(packageDirectory, { recursive: true });
  await fs.writeFile(
    packageJsonPath,
    `${JSON.stringify(
      {
        name: "@arunajs/compiler",
        version: options.version,
        optionalDependencies: Object.fromEntries(
          SUPPORTED_NATIVE_TARGETS.map((target) => [nativePackageName(target), options.version]),
        ),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    packageDirectory,
    packageJsonPath,
  };
}
