import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  nativeArtifactName,
  nativePackageName,
  resolveNativeTarget,
  type NativeTarget,
} from "../src/native-platform.ts";
import { stagedNativePackageArtifactPath, stagedNativePackageDirectory } from "./native-targets.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(packageRoot, "../..");

type NativePackageJson = {
  name?: string;
  main?: string;
  files?: string[];
};

export type VerifyNativePackageResult = {
  target: NativeTarget;
  packageDirectory: string;
  packageJsonPath: string;
  artifactPath: string;
};

function workspaceRelative(root: string, candidatePath: string): string {
  const relative = path.relative(root, candidatePath);
  return relative.length > 0 && !relative.startsWith("..")
    ? relative.split(path.sep).join("/")
    : candidatePath;
}

async function verifyPackageJson(packageJsonPath: string, target: NativeTarget): Promise<void> {
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as NativePackageJson;
  const expectedArtifact = nativeArtifactName(target);

  if (packageJson.name !== nativePackageName(target)) {
    throw new Error(`Staged native package has the wrong package name: ${packageJsonPath}`);
  }

  if (packageJson.main !== `./${expectedArtifact}`) {
    throw new Error(
      `Staged native package must point main at ./${expectedArtifact}: ${packageJsonPath}`,
    );
  }

  if (
    !Array.isArray(packageJson.files) ||
    packageJson.files.length !== 1 ||
    packageJson.files[0] !== expectedArtifact
  ) {
    throw new Error(
      `Staged native package must list only ${expectedArtifact} in files: ${packageJsonPath}`,
    );
  }
}

export async function verifyNativePackage(
  workspaceRoot: string,
  target: NativeTarget,
): Promise<VerifyNativePackageResult> {
  const packageDirectory = stagedNativePackageDirectory(workspaceRoot, target);
  const packageJsonPath = path.join(packageDirectory, "package.json");
  const artifactPath = stagedNativePackageArtifactPath(workspaceRoot, target);

  try {
    await fs.access(packageDirectory);
  } catch {
    throw new Error(
      `Staged native package directory is missing: ${workspaceRelative(workspaceRoot, packageDirectory)}`,
    );
  }

  try {
    await fs.access(packageJsonPath);
  } catch {
    throw new Error(
      `Staged native package manifest is missing: ${workspaceRelative(workspaceRoot, packageJsonPath)}`,
    );
  }

  try {
    await fs.access(artifactPath);
  } catch {
    throw new Error(
      `Staged native artifact is missing: ${workspaceRelative(workspaceRoot, artifactPath)}`,
    );
  }

  await verifyPackageJson(packageJsonPath, target);

  return {
    target,
    packageDirectory,
    packageJsonPath,
    artifactPath,
  };
}

async function main(): Promise<void> {
  const target = resolveNativeTarget();
  const result = await verifyNativePackage(workspaceRoot, target);
  console.log(
    `Verified staged native package for ${result.target}: ${workspaceRelative(workspaceRoot, result.packageDirectory)}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
