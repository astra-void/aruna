import path from "node:path";
import {
  nativeArtifactName,
  nativePackageDirectoryName,
  nativePackageName,
  nativeTargetInfo,
  resolveNativeTarget,
  SUPPORTED_NATIVE_TARGETS,
  type NativeTarget,
} from "../src/native-platform.ts";

export type { NativeTarget };

export { nativeArtifactName, nativePackageName, nativeTargetInfo, resolveNativeTarget, SUPPORTED_NATIVE_TARGETS };

export function stagedNativePackageDirectory(workspaceRoot: string, target: NativeTarget): string {
  return path.join(workspaceRoot, ".npm", nativePackageDirectoryName(target));
}

export function stagedNativePackageArtifactPath(workspaceRoot: string, target: NativeTarget): string {
  return path.join(stagedNativePackageDirectory(workspaceRoot, target), nativeArtifactName(target));
}

export function stagedCompilerPackageDirectory(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".npm", "compiler");
}
