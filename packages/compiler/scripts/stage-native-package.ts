import fs from "node:fs/promises";
import path from "node:path";
import {
  nativeArtifactName,
  nativePackageName,
  nativeTargetInfo,
  stagedNativePackageArtifactPath,
  stagedNativePackageDirectory,
  type NativeTarget,
} from "./native-targets.ts";

export type StageNativePackageOptions = {
  workspaceRoot: string;
  version: string;
  target: NativeTarget;
  sourceArtifactPath: string;
};

export type StagedNativePackage = {
  packageDirectory: string;
  packageJsonPath: string;
  artifactPath: string;
};

export async function stageNativePackage(
  options: StageNativePackageOptions,
): Promise<StagedNativePackage> {
  const packageDirectory = stagedNativePackageDirectory(options.workspaceRoot, options.target);
  const artifactPath = stagedNativePackageArtifactPath(options.workspaceRoot, options.target);
  const packageJsonPath = path.join(packageDirectory, "package.json");
  const targetInfo = nativeTargetInfo(options.target);

  try {
    await fs.access(options.sourceArtifactPath);
  } catch {
    throw new Error(
      `Native build artifact is missing and cannot be staged: ${options.sourceArtifactPath}`,
    );
  }

  await fs.mkdir(packageDirectory, { recursive: true });
  await fs.copyFile(options.sourceArtifactPath, artifactPath);
  await fs.writeFile(
    packageJsonPath,
    `${JSON.stringify(
      {
        name: nativePackageName(options.target),
        version: options.version,
        main: `./${nativeArtifactName(options.target)}`,
        files: [nativeArtifactName(options.target)],
        os: [targetInfo.os],
        cpu: [targetInfo.arch],
        ...(targetInfo.libc ? { libc: targetInfo.libc } : {}),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    packageDirectory,
    packageJsonPath,
    artifactPath,
  };
}
