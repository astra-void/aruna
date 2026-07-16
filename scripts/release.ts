import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
  buildNativeArtifact,
  detectToolAvailability,
  selectNativeBuildTool,
  type BuildNativeArtifactResult,
  type NativeBuildProfile,
  type ToolAvailability,
  type ZigPolicy,
} from "../packages/compiler/scripts/native-build.ts";
import {
  nativePackageName,
  nativeTargetInfo,
  resolveNativeTarget,
  stagedNativePackageDirectory,
  SUPPORTED_NATIVE_TARGETS,
  type NativeTarget,
} from "../packages/compiler/scripts/native-targets.ts";
import { stageCompilerPackage } from "../packages/compiler/scripts/stage-compiler-package.ts";
import { stageNativePackage } from "../packages/compiler/scripts/stage-native-package.ts";
import { stageWorkspacePackage } from "../packages/compiler/scripts/stage-package.ts";

export type ReleaseMode = "local" | "cross" | "full";

export type ReleaseCommand = "prepare" | "pack" | "publish" | "build-native";

export type ReleaseOptions = {
  mode: ReleaseMode;
  targets?: string;
  dryRun?: boolean;
  tag?: string;
  zig?: ZigPolicy;
  allowMissingTools?: boolean;
  provenance?: boolean;
  verifyCredentials?: boolean;
  /**
   * Skip native compilation and assemble the release from native packages that
   * are already staged under `.npm/` (e.g. downloaded from per-target build-job
   * artifacts in CI). The native target list is discovered from disk.
   */
  assemble?: boolean;
};

export type ReleaseDeps = {
  spawnSync?: typeof spawnSync;
  buildNativeArtifact?: typeof buildNativeArtifact;
  stageNativePackage?: typeof stageNativePackage;
  stageCompilerPackage?: typeof stageCompilerPackage;
  toolAvailability?: ToolAvailability;
};

export type PreparedRelease = {
  workspaceRoot: string;
  version: string;
  mode: ReleaseMode;
  hostTarget: NativeTarget;
  nativeTargets: NativeTarget[];
  skippedTargets: Array<{ target: NativeTarget; reason: string }>;
  nativePackageDirectories: string[];
  compilerPackageDirectory: string;
  corePackageDirectory: string;
  arunaPackageDirectory: string;
  createArunaPackageDirectory: string;
};

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptRoot, "..");
const compilerPackageRoot = path.join(workspaceRoot, "packages", "compiler");
const compilerPackageJsonPath = path.join(compilerPackageRoot, "package.json");
const corePackageRoot = path.join(workspaceRoot, "packages", "core");
const arunaPackageRoot = path.join(workspaceRoot, "packages", "aruna");
const createArunaPackageRoot = path.join(workspaceRoot, "packages", "create-aruna-app");
const stagedCoreDirectory = path.join(workspaceRoot, ".npm", "core");
const stagedArunaDirectory = path.join(workspaceRoot, ".npm", "aruna");
const stagedCreateArunaDirectory = path.join(workspaceRoot, ".npm", "create-aruna-app");
const releaseProfile: NativeBuildProfile = "release";

export function parseTargetList(value: string | undefined): NativeTarget[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      if (!SUPPORTED_NATIVE_TARGETS.includes(entry as NativeTarget)) {
        throw new Error(`Unsupported release target "${entry}".`);
      }
      return entry as NativeTarget;
    });
}

export function canBuildTargetOnHost(hostTarget: NativeTarget, target: NativeTarget): boolean {
  if (target === hostTarget) {
    return true;
  }

  const targetInfo = nativeTargetInfo(target);
  // Linux (gnu + musl) cross-compiles from any host via cargo-zigbuild; Windows
  // MSVC cross-compiles from any host via cargo-xwin. macOS targets need the
  // Apple SDK, which is only available on a macOS host.
  if (targetInfo.os === "linux" || targetInfo.os === "win32") {
    return true;
  }
  if (targetInfo.os === "darwin") {
    return nativeTargetInfo(hostTarget).os === "darwin";
  }
  return false;
}

export function resolveTargetsForMode(
  mode: ReleaseMode,
  hostTarget: NativeTarget,
  targetList: NativeTarget[],
): NativeTarget[] {
  if (mode === "local") {
    if (targetList.length > 0) {
      throw new Error("Local mode does not accept --targets.");
    }
    return [hostTarget];
  }

  if (mode === "cross") {
    if (targetList.length === 0) {
      throw new Error("Cross mode requires --targets.");
    }
    const unsupported = targetList.filter((target) => !canBuildTargetOnHost(hostTarget, target));
    if (unsupported.length > 0) {
      throw new Error(
        `Unsupported cross target(s) on ${hostTarget}: ${unsupported.join(", ")}. ` +
          "Aruna only enables verified Linux Zig builds at this phase.",
      );
    }
    return targetList;
  }

  return SUPPORTED_NATIVE_TARGETS.filter((target) => canBuildTargetOnHost(hostTarget, target));
}

function workspaceRelative(candidatePath: string): string {
  return path.relative(workspaceRoot, candidatePath).split(path.sep).join("/");
}

function npmCacheDirectory(): string {
  return path.join(process.env.TMPDIR ?? "/tmp", "aruna-npm-cache");
}

async function resolvePnpmInvocation(): Promise<{ command: string; args: string[] }> {
  // pnpm is the workspace package manager and always on PATH; it proxies
  // `pack`, `publish`, `whoami`, and `view` to the npm registry tooling.
  return {
    command: "pnpm",
    args: [],
  };
}

function hasWorkspaceProtocol(value: unknown): boolean {
  if (typeof value === "string") {
    return value.startsWith("workspace:");
  }

  if (Array.isArray(value)) {
    return value.some((entry) => hasWorkspaceProtocol(entry));
  }

  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((entry) =>
      hasWorkspaceProtocol(entry),
    );
  }

  return false;
}

async function cleanDirectory(directory: string): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true });
}

async function readCompilerVersion(): Promise<string> {
  const packageJson = JSON.parse(await fs.readFile(compilerPackageJsonPath, "utf8")) as {
    version?: string;
  };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error(
      `Could not determine the compiler package version from ${compilerPackageJsonPath}`,
    );
  }

  return packageJson.version;
}

function runCommand(
  spawn: typeof spawnSync,
  command: string,
  args: string[],
  cwd: string,
  failureMessage: string,
  extraEnv: Record<string, string> = {},
): void {
  const result = spawn(command, args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  if (result.error) {
    throw new Error(`${failureMessage}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(failureMessage);
  }
}

async function ensureNoWorkspaceProtocols(packageJsonPath: string): Promise<void> {
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as Record<
    string,
    unknown
  >;
  if (hasWorkspaceProtocol(packageJson)) {
    throw new Error(
      `Workspace protocols are not allowed in staged manifests: ${workspaceRelative(packageJsonPath)}`,
    );
  }
}

async function validateNativePackage(
  packageDirectory: string,
  target: NativeTarget,
): Promise<void> {
  const expectedArtifact = nativeTargetInfo(target).artifactName;
  const expectedTargetInfo = nativeTargetInfo(target);
  const entries = (await fs.readdir(packageDirectory)).filter((entry) => !entry.startsWith("."));
  const expectedEntries = ["package.json", expectedArtifact];

  if (
    entries.length !== expectedEntries.length ||
    !expectedEntries.every((entry) => entries.includes(entry))
  ) {
    throw new Error(
      `Native staging for ${target} is invalid. Expected only ${expectedEntries.join(", ")} in ${workspaceRelative(
        packageDirectory,
      )}.`,
    );
  }

  const packageJson = JSON.parse(
    await fs.readFile(path.join(packageDirectory, "package.json"), "utf8"),
  ) as {
    name?: string;
    version?: string;
    main?: string;
    files?: string[];
    os?: string[];
    cpu?: string[];
    libc?: string;
  };

  if (packageJson.name !== nativePackageName(target)) {
    throw new Error(
      `Native package ${workspaceRelative(packageDirectory)} has the wrong package name.`,
    );
  }

  if (packageJson.main !== `./${expectedArtifact}`) {
    throw new Error(
      `Native package ${workspaceRelative(packageDirectory)} must point main at ./${expectedArtifact}.`,
    );
  }

  if (
    !Array.isArray(packageJson.files) ||
    packageJson.files.length !== 1 ||
    packageJson.files[0] !== expectedArtifact
  ) {
    throw new Error(
      `Native package ${workspaceRelative(packageDirectory)} must list only ${expectedArtifact} in files.`,
    );
  }

  if (
    !Array.isArray(packageJson.os) ||
    packageJson.os.length !== 1 ||
    packageJson.os[0] !== expectedTargetInfo.os
  ) {
    throw new Error(
      `Native package ${workspaceRelative(packageDirectory)} must restrict os to ${expectedTargetInfo.os}.`,
    );
  }

  if (
    !Array.isArray(packageJson.cpu) ||
    packageJson.cpu.length !== 1 ||
    packageJson.cpu[0] !== expectedTargetInfo.arch
  ) {
    throw new Error(
      `Native package ${workspaceRelative(packageDirectory)} must restrict cpu to ${expectedTargetInfo.arch}.`,
    );
  }

  if (expectedTargetInfo.libc) {
    if (packageJson.libc !== expectedTargetInfo.libc) {
      throw new Error(
        `Native package ${workspaceRelative(packageDirectory)} must restrict libc to ${expectedTargetInfo.libc}.`,
      );
    }
  } else if (packageJson.libc !== undefined) {
    throw new Error(
      `Native package ${workspaceRelative(packageDirectory)} must not declare libc for ${target}.`,
    );
  }

  await ensureNoWorkspaceProtocols(path.join(packageDirectory, "package.json"));
}

async function validateCompilerPackage(
  packageDirectory: string,
  expectedTargets: NativeTarget[],
): Promise<void> {
  const packageJsonPath = path.join(packageDirectory, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
    optionalDependencies?: Record<string, string>;
  };

  await ensureNoWorkspaceProtocols(packageJsonPath);

  const stagedOptionalDependencies = packageJson.optionalDependencies ?? {};
  const stagedKeys = Object.keys(stagedOptionalDependencies).sort();
  const expectedKeys = expectedTargets.map(nativePackageName).sort();

  if (
    stagedKeys.length !== expectedKeys.length ||
    !expectedKeys.every((entry) => stagedKeys.includes(entry))
  ) {
    throw new Error(
      `Compiler package optionalDependencies do not match staged targets. Expected: ${expectedKeys.join(", ")}`,
    );
  }

  const expectedVersion = await readCompilerVersion();
  for (const [name, version] of Object.entries(stagedOptionalDependencies)) {
    if (version !== expectedVersion) {
      throw new Error(
        `Compiler package optionalDependency ${name} must be ${expectedVersion}, found ${version}.`,
      );
    }
  }

  try {
    await fs.access(path.join(packageDirectory, "dist"));
  } catch {
    throw new Error(
      `Compiler package dist directory is missing: ${workspaceRelative(path.join(packageDirectory, "dist"))}`,
    );
  }
}

async function validateStagedRelease(
  stagedNativePackages: Array<{ packageDirectory: string; target: NativeTarget }>,
  compilerPackageDirectory: string,
  expectedTargets: NativeTarget[],
): Promise<void> {
  const rootEntries = (await fs.readdir(path.join(workspaceRoot, ".npm"))).filter(
    (entry) => !entry.startsWith("."),
  );
  const expectedRootEntries = [
    ...stagedNativePackages.map((entry) => path.basename(entry.packageDirectory)),
    "compiler",
    "core",
    "aruna",
    "create-aruna-app",
  ];

  if (
    rootEntries.length !== expectedRootEntries.length ||
    !expectedRootEntries.every((entry) => rootEntries.includes(entry))
  ) {
    throw new Error(
      `Staged packages do not match the selected release targets. Expected only ${expectedRootEntries.join(", ")} under .npm/.`,
    );
  }

  for (const entry of stagedNativePackages) {
    await validateNativePackage(entry.packageDirectory, entry.target);
  }
  await validateCompilerPackage(compilerPackageDirectory, expectedTargets);
  await ensureNoWorkspaceProtocols(path.join(stagedCoreDirectory, "package.json"));
  await ensureNoWorkspaceProtocols(path.join(stagedArunaDirectory, "package.json"));
  await ensureNoWorkspaceProtocols(path.join(stagedCreateArunaDirectory, "package.json"));
}

type StagedNativePackage = { packageDirectory: string; target: NativeTarget };

function buildPublishableTypeScriptPackages(spawn: typeof spawnSync): void {
  // Build only the publishable packages. A full-workspace `turbo run build`
  // also builds the apps/* harnesses, which require the `aruna` binary on PATH
  // and per-app node_modules — neither is present in the publish job, so they
  // fail. The `^build` dependency pulls in their workspace deps anyway.
  runCommand(
    spawn,
    "pnpm",
    [
      "exec",
      "turbo",
      "run",
      "build",
      "--filter=@arunajs/core",
      "--filter=@arunajs/compiler",
      "--filter=@arunajs/aruna",
      "--filter=create-aruna-app",
    ],
    workspaceRoot,
    "Failed to build TypeScript packages",
  );
}

async function buildAndStageNativeTargets(
  options: ReleaseOptions,
  targets: NativeTarget[],
  deps: ReleaseDeps,
): Promise<{
  stagedNativePackages: StagedNativePackage[];
  nativeTargets: NativeTarget[];
  skippedTargets: Array<{ target: NativeTarget; reason: string }>;
}> {
  const spawn = deps.spawnSync ?? spawnSync;
  const buildNativeArtifactFn = deps.buildNativeArtifact ?? buildNativeArtifact;
  const stageNativePackageFn = deps.stageNativePackage ?? stageNativePackage;
  const toolAvailability = deps.toolAvailability ?? detectToolAvailability(spawn);
  const hostTarget = resolveNativeTarget();
  const version = await readCompilerVersion();
  const zigPolicy = options.zig ?? "auto";
  const allowMissingTools = options.allowMissingTools ?? false;

  const stagedNativePackages: StagedNativePackage[] = [];
  const nativeTargets: NativeTarget[] = [];
  const skippedTargets: Array<{ target: NativeTarget; reason: string }> = [];

  for (const target of targets) {
    const selection = selectNativeBuildTool({
      target,
      hostTarget,
      policy: zigPolicy,
      tools: toolAvailability,
      allowMissingTools,
    });

    if (typeof selection !== "string") {
      skippedTargets.push({ target, reason: selection.reason });
      continue;
    }

    const buildResult: BuildNativeArtifactResult = await buildNativeArtifactFn({
      workspaceRoot,
      target,
      hostTarget,
      profile: releaseProfile,
      buildTool: selection,
    });
    const staged = await stageNativePackageFn({
      workspaceRoot,
      version,
      target,
      sourceArtifactPath: buildResult.sourceArtifactPath,
    });
    stagedNativePackages.push({ packageDirectory: staged.packageDirectory, target });
    nativeTargets.push(target);
  }

  return { stagedNativePackages, nativeTargets, skippedTargets };
}

async function stagePublishablePackages(
  nativeTargets: NativeTarget[],
  deps: ReleaseDeps,
): Promise<{ compilerPackageDirectory: string }> {
  const stageCompilerPackageFn = deps.stageCompilerPackage ?? stageCompilerPackage;
  const version = await readCompilerVersion();

  const compilerPackage = await stageCompilerPackageFn({
    workspaceRoot,
    version,
    nativeTargets,
  });

  await stageWorkspacePackage({
    sourcePackageDirectory: corePackageRoot,
    stagedPackageDirectory: stagedCoreDirectory,
    version,
  });
  await stageWorkspacePackage({
    sourcePackageDirectory: arunaPackageRoot,
    stagedPackageDirectory: stagedArunaDirectory,
    version,
  });
  await stageWorkspacePackage({
    sourcePackageDirectory: createArunaPackageRoot,
    stagedPackageDirectory: stagedCreateArunaDirectory,
    version,
  });

  return { compilerPackageDirectory: compilerPackage.packageDirectory };
}

function toPreparedRelease(args: {
  version: string;
  mode: ReleaseMode;
  hostTarget: NativeTarget;
  nativeTargets: NativeTarget[];
  skippedTargets: Array<{ target: NativeTarget; reason: string }>;
  stagedNativePackages: StagedNativePackage[];
  compilerPackageDirectory: string;
}): PreparedRelease {
  return {
    workspaceRoot,
    version: args.version,
    mode: args.mode,
    hostTarget: args.hostTarget,
    nativeTargets: args.nativeTargets,
    skippedTargets: args.skippedTargets,
    nativePackageDirectories: args.stagedNativePackages.map((entry) => entry.packageDirectory),
    compilerPackageDirectory: args.compilerPackageDirectory,
    corePackageDirectory: stagedCoreDirectory,
    arunaPackageDirectory: stagedArunaDirectory,
    createArunaPackageDirectory: stagedCreateArunaDirectory,
  };
}

async function stageReleasePackages(
  options: ReleaseOptions,
  mode: ReleaseMode,
  targets: NativeTarget[],
  deps: ReleaseDeps,
): Promise<PreparedRelease> {
  const spawn = deps.spawnSync ?? spawnSync;
  const hostTarget = resolveNativeTarget();
  const version = await readCompilerVersion();
  const npmDirectory = path.join(workspaceRoot, ".npm");

  await cleanDirectory(npmDirectory);
  buildPublishableTypeScriptPackages(spawn);

  const { stagedNativePackages, nativeTargets, skippedTargets } =
    await buildAndStageNativeTargets(options, targets, deps);

  const { compilerPackageDirectory } = await stagePublishablePackages(nativeTargets, deps);

  await validateStagedRelease(stagedNativePackages, compilerPackageDirectory, nativeTargets);

  return toPreparedRelease({
    version,
    mode,
    hostTarget,
    nativeTargets,
    skippedTargets,
    stagedNativePackages,
    compilerPackageDirectory,
  });
}

async function discoverStagedNativeTargets(): Promise<NativeTarget[]> {
  const discovered: NativeTarget[] = [];
  for (const target of SUPPORTED_NATIVE_TARGETS) {
    try {
      await fs.access(stagedNativePackageDirectory(workspaceRoot, target));
      discovered.push(target);
    } catch {
      // Target was not built/downloaded for this release; skip it.
    }
  }

  if (discovered.length === 0) {
    throw new Error(
      "No staged native packages found under .npm/. Run `release build-native` on each " +
        "target (or download the per-target build artifacts) before assembling the release.",
    );
  }

  return discovered;
}

// Assemble a release from native packages already staged under `.npm/` (built on
// other machines and downloaded as artifacts). Skips native compilation entirely;
// only the TypeScript packages are built and the compiler/core/aruna manifests are
// staged around the pre-built native packages.
async function assembleReleasePackages(deps: ReleaseDeps): Promise<PreparedRelease> {
  const spawn = deps.spawnSync ?? spawnSync;
  const hostTarget = resolveNativeTarget();
  const version = await readCompilerVersion();

  const nativeTargets = await discoverStagedNativeTargets();
  const stagedNativePackages: StagedNativePackage[] = nativeTargets.map((target) => ({
    packageDirectory: stagedNativePackageDirectory(workspaceRoot, target),
    target,
  }));

  buildPublishableTypeScriptPackages(spawn);

  const { compilerPackageDirectory } = await stagePublishablePackages(nativeTargets, deps);

  await validateStagedRelease(stagedNativePackages, compilerPackageDirectory, nativeTargets);

  return toPreparedRelease({
    version,
    mode: "full",
    hostTarget,
    nativeTargets,
    skippedTargets: [],
    stagedNativePackages,
    compilerPackageDirectory,
  });
}

async function packPackage(
  packageDirectory: string,
  packDestination: string,
  spawn: typeof spawnSync,
): Promise<string> {
  const before = new Set(await fs.readdir(packDestination));
  const pnpmInvocation = await resolvePnpmInvocation();
  runCommand(
    spawn,
    pnpmInvocation.command,
    [...pnpmInvocation.args, "pack", "--pack-destination", packDestination],
    packageDirectory,
    `Failed to pack ${workspaceRelative(packageDirectory)}`,
    { npm_config_cache: npmCacheDirectory() },
  );
  const after = await fs.readdir(packDestination);
  const newTarballs = after.filter((entry) => !before.has(entry) && entry.endsWith(".tgz"));
  if (newTarballs.length === 0) {
    throw new Error(
      `pnpm pack did not produce a tarball for ${workspaceRelative(packageDirectory)}`,
    );
  }

  return path.join(packDestination, newTarballs[0]);
}

async function packRelease(prepared: PreparedRelease, deps: ReleaseDeps): Promise<string[]> {
  const spawn = deps.spawnSync ?? spawnSync;
  const packDestination = path.join(workspaceRoot, ".npm-pack");
  await cleanDirectory(packDestination);

  const tarballs: string[] = [];
  for (const packageDirectory of prepared.nativePackageDirectories) {
    tarballs.push(await packPackage(packageDirectory, packDestination, spawn));
  }
  tarballs.push(await packPackage(prepared.corePackageDirectory, packDestination, spawn));
  tarballs.push(await packPackage(prepared.compilerPackageDirectory, packDestination, spawn));
  tarballs.push(await packPackage(prepared.arunaPackageDirectory, packDestination, spawn));
  tarballs.push(await packPackage(prepared.createArunaPackageDirectory, packDestination, spawn));
  return tarballs;
}

async function ensurePublishCredentials(spawn: typeof spawnSync): Promise<void> {
  const pnpmInvocation = await resolvePnpmInvocation();
  runCommand(
    spawn,
    pnpmInvocation.command,
    [...pnpmInvocation.args, "whoami"],
    workspaceRoot,
    "npm credentials are required to publish. Run `pnpm login` first.",
    { npm_config_cache: npmCacheDirectory() },
  );
}

async function readStagedPackageName(packageDirectory: string): Promise<string> {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(packageDirectory, "package.json"), "utf8"),
  ) as { name?: string };
  if (!packageJson.name) {
    throw new Error(`Staged package ${workspaceRelative(packageDirectory)} is missing a name.`);
  }
  return packageJson.name;
}

function isAlreadyPublished(
  spawn: typeof spawnSync,
  pnpmInvocation: { command: string; args: string[] },
  name: string,
  version: string,
): boolean {
  const result = spawn(
    pnpmInvocation.command,
    [...pnpmInvocation.args, "view", `${name}@${version}`, "version"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: npmCacheDirectory() },
    },
  );
  return (
    result.status === 0 &&
    typeof result.stdout === "string" &&
    result.stdout.trim() === version
  );
}

async function publishPackage(
  spawn: typeof spawnSync,
  pnpmInvocation: { command: string; args: string[] },
  packageDirectory: string,
  options: ReleaseOptions,
  version: string,
): Promise<void> {
  const name = await readStagedPackageName(packageDirectory);
  // Idempotent: a re-run after a partial failure skips what already landed.
  if (!options.dryRun && isAlreadyPublished(spawn, pnpmInvocation, name, version)) {
    console.log(`Skipping ${name}@${version} (already published).`);
    return;
  }

  // Scoped @arunajs/* packages default to restricted (private) access on npm;
  // publish them publicly. `--no-git-checks` keeps pnpm from refusing to publish
  // off a detached tag checkout in CI.
  const args = [
    ...pnpmInvocation.args,
    "publish",
    packageDirectory,
    "--access",
    "public",
    "--no-git-checks",
  ];
  if (options.dryRun) {
    args.push("--dry-run");
  }
  if (options.tag) {
    args.push("--tag", options.tag);
  }
  if (options.provenance) {
    args.push("--provenance");
  }
  runCommand(
    spawn,
    pnpmInvocation.command,
    args,
    workspaceRoot,
    `Failed to publish ${workspaceRelative(packageDirectory)}`,
    { npm_config_cache: npmCacheDirectory() },
  );
}

async function publishRelease(
  prepared: PreparedRelease,
  options: ReleaseOptions,
  deps: ReleaseDeps,
): Promise<void> {
  const spawn = deps.spawnSync ?? spawnSync;
  // OIDC trusted publishing has no logged-in identity, so `pnpm whoami` would fail;
  // CI skips the check with --no-verify-credentials.
  if (!options.dryRun && options.verifyCredentials !== false) {
    await ensurePublishCredentials(spawn);
  }
  const pnpmInvocation = await resolvePnpmInvocation();

  // Dependency order: native binaries → core → compiler → aruna → create-aruna-app
  // (the scaffolder installs @arunajs/aruna, so it publishes last).
  const orderedDirectories = [
    ...prepared.nativePackageDirectories,
    prepared.corePackageDirectory,
    prepared.compilerPackageDirectory,
    prepared.arunaPackageDirectory,
    prepared.createArunaPackageDirectory,
  ];

  for (const packageDirectory of orderedDirectories) {
    await publishPackage(spawn, pnpmInvocation, packageDirectory, options, prepared.version);
  }
}

export type NativeBuildResult = {
  workspaceRoot: string;
  version: string;
  nativeTargets: NativeTarget[];
  skippedTargets: Array<{ target: NativeTarget; reason: string }>;
  nativePackageDirectories: string[];
};

// Build and stage ONLY the requested native packages, without touching the
// TypeScript/compiler/core/aruna packages. Used by the per-target CI build jobs,
// which upload `.npm/compiler-<target>` as an artifact for the publish job to
// assemble. Each job runs in a fresh checkout, so `.npm/` is cleaned first.
export async function buildNativeRelease(
  options: ReleaseOptions,
  deps: ReleaseDeps = {},
): Promise<NativeBuildResult> {
  const hostTarget = resolveNativeTarget();
  const targetList = parseTargetList(options.targets);
  const targets = resolveTargetsForMode(options.mode, hostTarget, targetList);
  const version = await readCompilerVersion();
  const npmDirectory = path.join(workspaceRoot, ".npm");

  await cleanDirectory(npmDirectory);

  const { stagedNativePackages, nativeTargets, skippedTargets } =
    await buildAndStageNativeTargets(options, targets, deps);

  for (const entry of stagedNativePackages) {
    await validateNativePackage(entry.packageDirectory, entry.target);
  }

  return {
    workspaceRoot,
    version,
    nativeTargets,
    skippedTargets,
    nativePackageDirectories: stagedNativePackages.map((entry) => entry.packageDirectory),
  };
}

export async function prepareRelease(
  options: ReleaseOptions,
  deps: ReleaseDeps = {},
): Promise<PreparedRelease> {
  if (options.assemble) {
    return assembleReleasePackages(deps);
  }
  const hostTarget = resolveNativeTarget();
  const targetList = parseTargetList(options.targets);
  const targets = resolveTargetsForMode(options.mode, hostTarget, targetList);
  return stageReleasePackages(options, options.mode, targets, deps);
}

export async function packPreparedRelease(
  options: ReleaseOptions,
  deps: ReleaseDeps = {},
): Promise<string[]> {
  const prepared = await prepareRelease(options, deps);
  return packRelease(prepared, deps);
}

export async function publishPreparedRelease(
  options: ReleaseOptions,
  deps: ReleaseDeps = {},
): Promise<void> {
  const prepared = await prepareRelease(options, deps);
  await publishRelease(prepared, options, deps);
}

async function runCli(command: ReleaseCommand, options: ReleaseOptions): Promise<void> {
  if (command === "build-native") {
    const result = await buildNativeRelease(options);
    console.log(
      [
        `Built ${result.nativeTargets.length} native package(s).`,
        `Built: ${result.nativeTargets.length > 0 ? result.nativeTargets.join(", ") : "none"}`,
        `Skipped: ${result.skippedTargets.length > 0 ? result.skippedTargets.map((entry) => `${entry.target} (${entry.reason})`).join(", ") : "none"}`,
        ...result.nativePackageDirectories.map((directory) => `- ${workspaceRelative(directory)}`),
      ].join("\n"),
    );
    return;
  }

  if (command === "prepare") {
    const prepared = await prepareRelease(options);
    console.log(
      [
        `Prepared ${prepared.nativeTargets.length} native package(s) for ${prepared.mode} mode.`,
        `Built: ${prepared.nativeTargets.length > 0 ? prepared.nativeTargets.join(", ") : "none"}`,
        `Skipped: ${prepared.skippedTargets.length > 0 ? prepared.skippedTargets.map((entry) => `${entry.target} (${entry.reason})`).join(", ") : "none"}`,
        `Staged under: ${workspaceRelative(path.join(workspaceRoot, ".npm"))}`,
      ].join("\n"),
    );
    return;
  }

  if (command === "pack") {
    const tarballs = await packPreparedRelease(options);
    console.log(
      [
        `Packed ${tarballs.length} tarball(s) into ${workspaceRelative(path.join(workspaceRoot, ".npm-pack"))}.`,
        ...tarballs.map((tarball) => `- ${workspaceRelative(tarball)}`),
      ].join("\n"),
    );
    return;
  }

  await publishPreparedRelease(options);
  console.log(options.dryRun ? "Dry-run publish completed." : "Publish completed.");
}

async function main(): Promise<void> {
  const program = new Command();
  program.name("release");
  program.exitOverride();

  const addModeOptions = (command: Command) =>
    command
      .option("--mode <mode>", "release mode: local, cross, or full", "local")
      .option("--targets <targets>", "comma-separated native targets for cross mode")
      .option("--zig <policy>", "zig policy: auto, always, or never", "auto")
      .option("--allow-missing-tools", "skip requested cross targets when build tools are missing");

  addModeOptions(
    program.command("prepare").action(async function (this: Command) {
      const opts = this.opts<{
        mode: ReleaseMode;
        targets?: string;
        zig?: ZigPolicy;
        allowMissingTools?: boolean;
      }>();
      await runCli("prepare", {
        mode: opts.mode,
        targets: opts.targets,
        zig: opts.zig,
        allowMissingTools: opts.allowMissingTools,
      });
    }),
  );

  addModeOptions(
    program.command("build-native").action(async function (this: Command) {
      const opts = this.opts<{
        mode: ReleaseMode;
        targets?: string;
        zig?: ZigPolicy;
        allowMissingTools?: boolean;
      }>();
      await runCli("build-native", {
        mode: opts.mode,
        targets: opts.targets,
        zig: opts.zig,
        allowMissingTools: opts.allowMissingTools,
      });
    }),
  );

  addModeOptions(
    program
      .command("pack")
      .option("--assemble", "assemble from native packages already staged under .npm/")
      .action(async function (this: Command) {
        const opts = this.opts<{
          mode: ReleaseMode;
          targets?: string;
          zig?: ZigPolicy;
          allowMissingTools?: boolean;
          assemble?: boolean;
        }>();
        await runCli("pack", {
          mode: opts.mode,
          targets: opts.targets,
          zig: opts.zig,
          allowMissingTools: opts.allowMissingTools,
          assemble: opts.assemble,
        });
      }),
  );

  addModeOptions(
    program
      .command("publish")
      .option("--dry-run", "run pnpm publish in dry-run mode")
      .option("--tag <tag>", "publish tag", "latest")
      .option("--provenance", "publish with npm provenance attestation (CI/OIDC)")
      .option("--no-verify-credentials", "skip the pnpm whoami check (use with OIDC trusted publishing)")
      .option("--assemble", "assemble from native packages already staged under .npm/ (CI publish job)")
      .action(async function (this: Command) {
        const opts = this.opts<{
          mode: ReleaseMode;
          targets?: string;
          dryRun?: boolean;
          tag?: string;
          zig?: ZigPolicy;
          allowMissingTools?: boolean;
          provenance?: boolean;
          verifyCredentials?: boolean;
          assemble?: boolean;
        }>();
        await runCli("publish", {
          mode: opts.mode,
          targets: opts.targets,
          dryRun: opts.dryRun,
          tag: opts.tag,
          zig: opts.zig,
          allowMissingTools: opts.allowMissingTools,
          provenance: opts.provenance,
          verifyCredentials: opts.verifyCredentials,
          assemble: opts.assemble,
        });
      }),
  );

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Use one of:")) {
      console.error(message);
    } else {
      console.error(message);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
