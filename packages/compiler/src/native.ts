import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  nativeArtifactName,
  nativeBuildOutputName,
  nativePackageName,
  nativeTargetInfo,
  resolveNativeTarget,
  type NativeTarget,
} from "./native-platform.js";

export type NativeCompiler = {
  checkProject: (input: unknown) => unknown;
  inspectProject: (input: unknown) => unknown;
};

const NATIVE_MODULE_SHAPE_ERROR =
  "Loaded native compiler module did not expose checkProject and inspectProject functions.";

let cachedCompiler: NativeCompiler | null = null;

function workspaceRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function targetRoot(): string {
  const configured = process.env["CARGO_TARGET_DIR"];
  if (configured) {
    return path.resolve(workspaceRoot(), configured);
  }
  return path.join(workspaceRoot(), "target");
}

function resolveNativeTargetPath(target: NativeTarget): string {
  return path.join(workspaceRoot(), ".npm", `compiler-${target}`, nativeArtifactName(target));
}

function workspaceCandidatePaths(): string[] {
  const targetDir = targetRoot();
  const target = resolveNativeTarget();
  const rustTarget = nativeTargetInfo(target).rustTarget;
  const buildOutputName = nativeBuildOutputName(target);
  return [
    path.join(targetDir, rustTarget, "debug", buildOutputName),
    path.join(targetDir, rustTarget, "debug", "aruna_napi.node"),
    path.join(targetDir, rustTarget, "release", buildOutputName),
    path.join(targetDir, rustTarget, "release", "aruna_napi.node"),
    path.join(targetDir, "debug", "aruna_napi.node"),
    path.join(targetDir, "release", "aruna_napi.node"),
  ];
}

function formatDisplayPath(candidatePath: string): string {
  const root = workspaceRoot();
  const relative = path.relative(root, candidatePath);
  if (relative.length > 0 && !relative.startsWith("..")) {
    return relative.split(path.sep).join("/");
  }

  return candidatePath;
}

function packageSpecifier(target: NativeTarget): string {
  return `${nativePackageName(target)}/${nativeArtifactName(target)}`;
}

function validateNativeCompiler(value: unknown): asserts value is NativeCompiler {
  if (typeof value !== "object" || value === null) {
    throw new Error(NATIVE_MODULE_SHAPE_ERROR);
  }
  const candidate = value as Partial<NativeCompiler>;
  if (
    typeof candidate.checkProject !== "function" ||
    typeof candidate.inspectProject !== "function"
  ) {
    throw new Error(NATIVE_MODULE_SHAPE_ERROR);
  }
}

function createLoadFailureMessage(
  target: NativeTarget,
  expectedPackage: string,
  searchedPaths: string[],
): string {
  return [
    `Aruna native compiler could not be loaded for ${process.platform}/${process.arch}.`,
    `Resolved native target: ${target}`,
    `Expected native package: ${expectedPackage}`,
    `Expected native artifact: ${nativeArtifactName(target)}`,
    "",
    "Searched:",
    ...searchedPaths.map((candidate) => `- ${candidate}`),
    "",
    "Run pnpm build:native for local development, reinstall dependencies, or verify platform support.",
    "There is no TypeScript analyzer fallback.",
  ].join("\n");
}

export function loadNativeCompiler(): NativeCompiler {
  if (cachedCompiler) {
    return cachedCompiler;
  }

  const require = createRequire(import.meta.url);
  const target = resolveNativeTarget();
  const expectedPackage = packageSpecifier(target);
  const localFallbackPath = resolveNativeTargetPath(target);
  const searchedPaths = [
    expectedPackage,
    formatDisplayPath(localFallbackPath),
    ...workspaceCandidatePaths().map(formatDisplayPath),
  ];
  let lastError: unknown;

  try {
    const loaded = require(expectedPackage);
    validateNativeCompiler(loaded);
    cachedCompiler = loaded;
    return loaded;
  } catch (error) {
    lastError = error;
  }

  if (fs.existsSync(localFallbackPath)) {
    try {
      const loaded = require(localFallbackPath);
      validateNativeCompiler(loaded);
      cachedCompiler = loaded;
      return loaded;
    } catch (error) {
      lastError = error;
    }
  }

  for (const candidatePath of workspaceCandidatePaths()) {
    if (!fs.existsSync(candidatePath)) {
      continue;
    }

    try {
      const loaded = require(candidatePath);
      validateNativeCompiler(loaded);
      cachedCompiler = loaded;
      return loaded;
    } catch (error) {
      lastError = error;
    }
  }

  const error = new Error(createLoadFailureMessage(target, expectedPackage, searchedPaths));
  if (lastError !== undefined) {
    (error as Error & { cause?: unknown }).cause = lastError;
  }
  throw error;
}
