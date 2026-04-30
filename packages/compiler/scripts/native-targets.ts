import path from "node:path";
import {
  nativeArtifactName,
  nativeBuildOutputName,
  nativePackageDirectoryName,
  nativePackageName,
  nativeTargetInfo,
  resolveNativeTarget,
  SUPPORTED_NATIVE_TARGETS,
  SUPPORTED_NATIVE_TARGET_INFOS,
  type NativeTarget,
} from "../src/native-platform.ts";

export type { NativeTarget };

export {
  nativeArtifactName,
  nativeBuildOutputName,
  nativePackageName,
  nativeTargetInfo,
  resolveNativeTarget,
  SUPPORTED_NATIVE_TARGETS,
  SUPPORTED_NATIVE_TARGET_INFOS,
};

export function stagedNativePackageDirectory(workspaceRoot: string, target: NativeTarget): string {
  return path.join(workspaceRoot, ".npm", nativePackageDirectoryName(target));
}

export function stagedNativePackageArtifactPath(
  workspaceRoot: string,
  target: NativeTarget,
): string {
  return path.join(stagedNativePackageDirectory(workspaceRoot, target), nativeArtifactName(target));
}

export function stagedCompilerPackageDirectory(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".npm", "compiler");
}
