import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveNativeTarget, SUPPORTED_NATIVE_TARGETS, type NativeTarget } from "../src/native-platform.ts";
import { stageCompilerPackage } from "./stage-compiler-package.ts";
import { stageNativePackage } from "./stage-native-package.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(packageRoot, "../..");
const manifestPath = path.join(workspaceRoot, "crates", "aruna_napi", "Cargo.toml");
const profile = process.env.ARUNA_NATIVE_PROFILE === "release" ? "release" : "debug";
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(workspaceRoot, process.env.CARGO_TARGET_DIR)
  : path.join(workspaceRoot, "target");

type NodeReport = {
  header?: {
    glibcVersionRuntime?: string | undefined;
  } | undefined;
  sharedObjects?: string[] | undefined;
};

export type BuildNativeTargetDeps = {
  spawnSync?: typeof spawnSync;
  access?: typeof fs.access;
  copyFile?: typeof fs.copyFile;
  mkdir?: typeof fs.mkdir;
  stageNativePackage?: typeof stageNativePackage;
  stageCompilerPackage?: typeof stageCompilerPackage;
  readVersion?: () => Promise<string>;
};

export type BuildNativeTargetResult = {
  hostTarget: NativeTarget;
  version: string;
  sourceArtifactPath: string;
};

function detectHostLibc(): "gnu" | "musl" | null {
  const report =
    typeof process.report?.getReport === "function" ? (process.report.getReport() as NodeReport) : null;
  const glibcVersionRuntime = report?.header?.glibcVersionRuntime;
  if (typeof glibcVersionRuntime === "string" && glibcVersionRuntime.length > 0) {
    return "gnu";
  }

  const sharedObjects = report?.sharedObjects;
  if (Array.isArray(sharedObjects) && sharedObjects.some((sharedObject) => sharedObject.includes("musl"))) {
    return "musl";
  }

  return null;
}

export function resolveHostNativeTarget(): NativeTarget {
  return resolveNativeTarget({
    platform: process.platform,
    arch: process.arch,
    libc: process.platform === "linux" ? detectHostLibc() ?? undefined : undefined,
  });
}

export function readRequestedTarget(): NativeTarget | null {
  const flagIndex = process.argv.indexOf("--target");
  const cliTarget = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
  const envTarget = process.env.ARUNA_NATIVE_TARGET;
  const requested = cliTarget ?? envTarget;

  if (!requested) {
    return null;
  }

  if (!isNativeTarget(requested)) {
    throw new Error(
      `Unsupported explicit native target "${requested}". Phase 1 only builds the current host target. ` +
        `Future cross-compilation can use cargo-zigbuild for Linux targets such as ` +
        `x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu, x86_64-unknown-linux-musl, and ` +
        `aarch64-unknown-linux-musl.`,
    );
  }

  return requested;
}

export function isNativeTarget(value: string): value is NativeTarget {
  return SUPPORTED_NATIVE_TARGETS.includes(value as NativeTarget);
}

export function hostBuildOutputName(): string {
  if (process.platform === "win32") {
    return "aruna_napi.dll";
  }

  if (process.platform === "darwin") {
    return "libaruna_napi.dylib";
  }

  if (process.platform === "linux") {
    return "libaruna_napi.so";
  }

  throw new Error(`Unsupported host platform for native build: ${process.platform}/${process.arch}`);
}

export function findNativeBuildArtifact(): string {
  return path.join(targetDir, profile, hostBuildOutputName());
}

async function ensureVersion(readVersion: () => Promise<string>): Promise<string> {
  const version = await readVersion();
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`Could not determine package version from ${path.join(packageRoot, "package.json")}`);
  }

  return version;
}

async function readPackageVersion(): Promise<string> {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as { version?: string };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error(`Could not determine package version from ${packageJsonPath}`);
  }

  return packageJson.version;
}

async function copyWorkspaceFallback(
  sourceArtifactPath: string,
  copyFile: typeof fs.copyFile,
  mkdir: typeof fs.mkdir,
): Promise<string> {
  const fallbackPath = path.join(targetDir, profile, "aruna_napi.node");
  await mkdir(path.dirname(fallbackPath), { recursive: true });
  await copyFile(sourceArtifactPath, fallbackPath);
  return fallbackPath;
}

export async function runBuildNativeTarget(deps: BuildNativeTargetDeps = {}): Promise<BuildNativeTargetResult> {
  const spawn = deps.spawnSync ?? spawnSync;
  const access = deps.access ?? fs.access;
  const copyFile = deps.copyFile ?? fs.copyFile;
  const mkdir = deps.mkdir ?? fs.mkdir;
  const stageNativePackageFn = deps.stageNativePackage ?? stageNativePackage;
  const stageCompilerPackageFn = deps.stageCompilerPackage ?? stageCompilerPackage;
  const readVersion = deps.readVersion ?? readPackageVersion;

  const hostTarget = resolveHostNativeTarget();
  const requestedTarget = readRequestedTarget();

  if (requestedTarget && requestedTarget !== hostTarget) {
    throw new Error(
      `Explicit native target "${requestedTarget}" does not match the current host target "${hostTarget}". ` +
        `Phase 1 only stages the current host binary. Future cross-target builds can use cargo-zigbuild instead ` +
        `of faking platform artifacts.`,
    );
  }

  const profileArg = profile === "release" ? ["--release"] : [];
  const buildArgs = [
    "build",
    "--manifest-path",
    manifestPath,
    "--package",
    "aruna_napi",
    "--features",
    "napi-addon",
    ...profileArg,
  ];

  const build = spawn("cargo", buildArgs, {
    cwd: workspaceRoot,
    stdio: "inherit",
    env: process.env,
  });

  if (build.error) {
    throw new Error(`Failed to run cargo for aruna_napi: ${build.error.message}`);
  }

  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }

  const sourceArtifactPath = findNativeBuildArtifact();
  await access(sourceArtifactPath);

  const version = await ensureVersion(readVersion);
  await copyWorkspaceFallback(sourceArtifactPath, copyFile, mkdir);
  await stageNativePackageFn({
    workspaceRoot,
    version,
    target: hostTarget,
    sourceArtifactPath,
  });
  await stageCompilerPackageFn({
    workspaceRoot,
    version,
  });

  return {
    hostTarget,
    version,
    sourceArtifactPath,
  };
}
