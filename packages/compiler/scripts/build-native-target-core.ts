import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  nativeBuildOutputName,
  resolveNativeTarget,
  SUPPORTED_NATIVE_TARGETS,
  type NativeTarget,
} from "../src/native-platform.js";
import { buildNativeArtifact } from "./native-build.js";
import { stagedCompilerPackageDirectory } from "./native-targets.js";
import { stageCompilerPackage } from "./stage-compiler-package.js";
import { stageNativePackage } from "./stage-native-package.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(packageRoot, "../..");
const manifestPath = path.join(workspaceRoot, "crates", "aruna_napi", "Cargo.toml");
const profile = process.env.ARUNA_NATIVE_PROFILE === "release" ? "release" : "debug";

export type BuildNativeTargetDeps = {
  buildNativeArtifact?: typeof buildNativeArtifact;
  stageNativePackage?: typeof stageNativePackage;
  stageCompilerPackage?: typeof stageCompilerPackage;
  readVersion?: () => Promise<string>;
};

export type BuildNativeTargetResult = {
  hostTarget: NativeTarget;
  version: string;
  sourceArtifactPath: string;
  compilerPackageDirectory: string | null;
};

function detectHostLibc(): "gnu" | "musl" | undefined {
  const report = process.report?.getReport?.() as
    | {
        header?: {
          glibcVersionRuntime?: string;
        };
        sharedObjects?: string[];
      }
    | undefined;
  const glibcVersionRuntime = report?.header?.glibcVersionRuntime;
  if (typeof glibcVersionRuntime === "string" && glibcVersionRuntime.length > 0) {
    return "gnu";
  }

  const sharedObjects = report?.sharedObjects;
  if (
    Array.isArray(sharedObjects) &&
    sharedObjects.some((sharedObject) => sharedObject.includes("musl"))
  ) {
    return "musl";
  }

  return undefined;
}

async function ensureVersion(readVersion: () => Promise<string>): Promise<string> {
  const version = await readVersion();
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(
      `Could not determine package version from ${path.join(packageRoot, "package.json")}`,
    );
  }

  return version;
}

async function readPackageVersion(): Promise<string> {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
    version?: string;
  };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error(`Could not determine package version from ${packageJsonPath}`);
  }

  return packageJson.version;
}

export function hostBuildOutputName(): string {
  return nativeBuildOutputName(resolveHostNativeTarget());
}

export function resolveHostNativeTarget(): NativeTarget {
  return resolveNativeTarget({
    platform: process.platform,
    arch: process.arch,
    libc: process.platform === "linux" ? detectHostLibc() : undefined,
  });
}

export function readRequestedTarget(): NativeTarget | null {
  const flagIndex = process.argv.indexOf("--target");
  const cliTarget = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;

  if (flagIndex >= 0 && (typeof cliTarget === "undefined" || cliTarget.startsWith("-"))) {
    throw new Error('Missing value for "--target" CLI flag.');
  }

  const envTarget = process.env.ARUNA_NATIVE_TARGET;
  const requested = cliTarget ?? envTarget;

  if (!requested) {
    return null;
  }

  const hostTarget = resolveHostNativeTarget();
  if (!SUPPORTED_NATIVE_TARGETS.includes(requested as NativeTarget)) {
    throw new Error(
      `Unsupported explicit native target "${requested}". Phase 1 only builds the current host target. ` +
        `Future cross-compilation can use cargo-zigbuild for Linux targets such as ` +
        `x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu, x86_64-unknown-linux-musl, and ` +
        `aarch64-unknown-linux-musl.`,
    );
  }

  if (requested !== hostTarget) {
    throw new Error(
      `Explicit native target "${requested}" does not match the current host target "${hostTarget}". ` +
        `Phase 1 only stages the current host binary.`,
    );
  }

  return requested as NativeTarget;
}

export async function runBuildNativeTarget(
  deps: BuildNativeTargetDeps = {},
): Promise<BuildNativeTargetResult> {
  const buildNativeArtifactFn = deps.buildNativeArtifact ?? buildNativeArtifact;
  const stageNativePackageFn = deps.stageNativePackage ?? stageNativePackage;
  const stageCompilerPackageFn = deps.stageCompilerPackage ?? stageCompilerPackage;
  const readVersion = deps.readVersion ?? readPackageVersion;

  const hostTarget = resolveHostNativeTarget();
  const requestedTarget = readRequestedTarget();

  if (requestedTarget && requestedTarget !== hostTarget) {
    throw new Error(
      `Explicit native target "${requestedTarget}" does not match the current host target "${hostTarget}". ` +
        `Phase 1 only stages the current host binary.`,
    );
  }

  const buildResult = await buildNativeArtifactFn({
    workspaceRoot,
    target: hostTarget,
    hostTarget,
    profile,
    manifestPath,
  });

  console.info(`Raw artifact: ${buildResult.sourceArtifactPath}`);

  const version = await ensureVersion(readVersion);
  const stagedNativePackage = await stageNativePackageFn({
    workspaceRoot,
    version,
    target: hostTarget,
    sourceArtifactPath: buildResult.sourceArtifactPath,
  });
  console.info(`Staged artifact: ${stagedNativePackage.artifactPath}`);
  const stagedCompilerPackage = await stageCompilerPackageFn({
    workspaceRoot,
    version,
    nativeTargets: [hostTarget],
    allowMissingDist: true,
  });
  if (stagedCompilerPackage === null) {
    await fs.rm(stagedCompilerPackageDirectory(workspaceRoot), { recursive: true, force: true });
    console.info(
      "Skipped wrapper package staging because packages/compiler/dist does not exist. Run pnpm build before release packaging.",
    );
  } else {
    console.info(`Staged wrapper package: ${stagedCompilerPackage.packageDirectory}`);
  }

  return {
    hostTarget,
    version,
    sourceArtifactPath: buildResult.sourceArtifactPath,
    compilerPackageDirectory: stagedCompilerPackage?.packageDirectory ?? null,
  };
}
