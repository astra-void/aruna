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
  SUPPORTED_NATIVE_TARGETS,
  type NativeTarget,
} from "../packages/compiler/scripts/native-targets.ts";
import { stageCompilerPackage } from "../packages/compiler/scripts/stage-compiler-package.ts";
import { stageNativePackage } from "../packages/compiler/scripts/stage-native-package.ts";

export type ReleaseMode = "local" | "cross" | "full";

export type ReleaseCommand = "prepare" | "pack" | "publish";

export type ReleaseOptions = {
  mode: ReleaseMode;
  targets?: string;
  dryRun?: boolean;
  tag?: string;
  zig?: ZigPolicy;
  allowMissingTools?: boolean;
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
};

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptRoot, "..");
const compilerPackageRoot = path.join(workspaceRoot, "packages", "compiler");
const compilerPackageJsonPath = path.join(compilerPackageRoot, "package.json");
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
  return targetInfo.os === "linux" && targetInfo.libc === "gnu";
}

export function resolveTargetsForMode(mode: ReleaseMode, hostTarget: NativeTarget, targetList: NativeTarget[]): NativeTarget[] {
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

async function resolveNpmInvocation(): Promise<{ command: string; args: string[] }> {
  const candidatePaths = [
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
    "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js",
    path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];

  for (const candidatePath of candidatePaths) {
    try {
      await fs.access(candidatePath);
      return {
        command: process.execPath,
        args: [candidatePath],
      };
    } catch {
      // Try the next installed npm CLI location.
    }
  }

  return {
    command: "npm",
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
    return Object.values(value as Record<string, unknown>).some((entry) => hasWorkspaceProtocol(entry));
  }

  return false;
}

async function cleanDirectory(directory: string): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true });
}

async function readCompilerVersion(): Promise<string> {
  const packageJson = JSON.parse(await fs.readFile(compilerPackageJsonPath, "utf8")) as { version?: string };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error(`Could not determine the compiler package version from ${compilerPackageJsonPath}`);
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
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
  if (hasWorkspaceProtocol(packageJson)) {
    throw new Error(`Workspace protocols are not allowed in staged manifests: ${workspaceRelative(packageJsonPath)}`);
  }
}

async function validateNativePackage(packageDirectory: string, target: NativeTarget): Promise<void> {
  const expectedArtifact = nativeTargetInfo(target).artifactName;
  const entries = (await fs.readdir(packageDirectory)).filter((entry) => !entry.startsWith("."));
  const expectedEntries = ["package.json", expectedArtifact];

  if (entries.length !== expectedEntries.length || !expectedEntries.every((entry) => entries.includes(entry))) {
    throw new Error(
      `Native staging for ${target} is invalid. Expected only ${expectedEntries.join(", ")} in ${workspaceRelative(
        packageDirectory,
      )}.`,
    );
  }

  await ensureNoWorkspaceProtocols(path.join(packageDirectory, "package.json"));
}

async function validateCompilerPackage(packageDirectory: string, expectedTargets: NativeTarget[]): Promise<void> {
  const packageJsonPath = path.join(packageDirectory, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
    optionalDependencies?: Record<string, string>;
  };

  await ensureNoWorkspaceProtocols(packageJsonPath);

  const stagedOptionalDependencies = packageJson.optionalDependencies ?? {};
  const stagedKeys = Object.keys(stagedOptionalDependencies).sort();
  const expectedKeys = expectedTargets.map(nativePackageName).sort();

  if (stagedKeys.length !== expectedKeys.length || !expectedKeys.every((entry) => stagedKeys.includes(entry))) {
    throw new Error(
      `Compiler package optionalDependencies do not match staged targets. Expected: ${expectedKeys.join(", ")}`,
    );
  }

  const expectedVersion = await readCompilerVersion();
  for (const [name, version] of Object.entries(stagedOptionalDependencies)) {
    if (version !== expectedVersion) {
      throw new Error(`Compiler package optionalDependency ${name} must be ${expectedVersion}, found ${version}.`);
    }
  }

  try {
    await fs.access(path.join(packageDirectory, "dist"));
  } catch {
    throw new Error(`Compiler package dist directory is missing: ${workspaceRelative(path.join(packageDirectory, "dist"))}`);
  }
}

async function validateStagedRelease(
  stagedNativePackages: Array<{ packageDirectory: string; target: NativeTarget }>,
  compilerPackageDirectory: string,
  expectedTargets: NativeTarget[],
): Promise<void> {
  const rootEntries = (await fs.readdir(path.join(workspaceRoot, ".npm"))).filter((entry) => !entry.startsWith("."));
  const expectedRootEntries = [...stagedNativePackages.map((entry) => path.basename(entry.packageDirectory)), "compiler"];

  if (rootEntries.length !== expectedRootEntries.length || !expectedRootEntries.every((entry) => rootEntries.includes(entry))) {
    throw new Error(
      `Staged packages do not match the selected release targets. Expected only ${expectedRootEntries.join(", ")} under .npm/.`,
    );
  }

  for (const entry of stagedNativePackages) {
    await validateNativePackage(entry.packageDirectory, entry.target);
  }
  await validateCompilerPackage(compilerPackageDirectory, expectedTargets);
}

async function stageReleasePackages(
  options: ReleaseOptions,
  mode: ReleaseMode,
  targets: NativeTarget[],
  deps: ReleaseDeps,
): Promise<PreparedRelease> {
  const spawn = deps.spawnSync ?? spawnSync;
  const buildNativeArtifactFn = deps.buildNativeArtifact ?? buildNativeArtifact;
  const stageNativePackageFn = deps.stageNativePackage ?? stageNativePackage;
  const stageCompilerPackageFn = deps.stageCompilerPackage ?? stageCompilerPackage;
  const toolAvailability = deps.toolAvailability ?? detectToolAvailability(spawn);
  const hostTarget = resolveNativeTarget();
  const version = await readCompilerVersion();
  const npmDirectory = path.join(workspaceRoot, ".npm");
  const nativeTargets = [] as NativeTarget[];
  const skippedTargets: Array<{ target: NativeTarget; reason: string }> = [];
  const zigPolicy = options.zig ?? "auto";
  const allowMissingTools = options.allowMissingTools ?? false;

  await cleanDirectory(npmDirectory);
  runCommand(spawn, "pnpm", ["exec", "turbo", "run", "build"], workspaceRoot, "Failed to build TypeScript packages");

  const stagedNativePackages: Array<{ packageDirectory: string; target: NativeTarget }> = [];
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

  const compilerPackage = await stageCompilerPackageFn({
    workspaceRoot,
    version,
    nativeTargets,
  });

  await validateStagedRelease(stagedNativePackages, compilerPackage.packageDirectory, nativeTargets);

  return {
    workspaceRoot,
    version,
    mode,
    hostTarget,
    nativeTargets,
    skippedTargets,
    nativePackageDirectories: stagedNativePackages.map((entry) => entry.packageDirectory),
    compilerPackageDirectory: compilerPackage.packageDirectory,
  };
}

async function packPackage(packageDirectory: string, packDestination: string, spawn: typeof spawnSync): Promise<string> {
  const before = new Set(await fs.readdir(packDestination));
  const npmInvocation = await resolveNpmInvocation();
  runCommand(
    spawn,
    npmInvocation.command,
    [...npmInvocation.args, "pack", "--pack-destination", packDestination],
    packageDirectory,
    `Failed to pack ${workspaceRelative(packageDirectory)}`,
    { npm_config_cache: npmCacheDirectory() },
  );
  const after = await fs.readdir(packDestination);
  const newTarballs = after.filter((entry) => !before.has(entry) && entry.endsWith(".tgz"));
  if (newTarballs.length === 0) {
    throw new Error(`npm pack did not produce a tarball for ${workspaceRelative(packageDirectory)}`);
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
  tarballs.push(await packPackage(prepared.compilerPackageDirectory, packDestination, spawn));
  return tarballs;
}

async function ensurePublishCredentials(spawn: typeof spawnSync): Promise<void> {
  const npmInvocation = await resolveNpmInvocation();
  runCommand(
    spawn,
    npmInvocation.command,
    [...npmInvocation.args, "whoami"],
    workspaceRoot,
    "npm credentials are required to publish. Run `npm login` first.",
    { npm_config_cache: npmCacheDirectory() },
  );
}

async function publishRelease(prepared: PreparedRelease, options: ReleaseOptions, deps: ReleaseDeps): Promise<void> {
  const spawn = deps.spawnSync ?? spawnSync;
  if (!options.dryRun) {
    await ensurePublishCredentials(spawn);
  }
  const npmInvocation = await resolveNpmInvocation();

  for (const packageDirectory of prepared.nativePackageDirectories) {
    const args = [...npmInvocation.args, "publish", packageDirectory];
    if (options.dryRun) {
      args.push("--dry-run");
    }
    if (options.tag) {
      args.push("--tag", options.tag);
    }
    runCommand(
      spawn,
      npmInvocation.command,
      args,
      workspaceRoot,
      `Failed to publish ${workspaceRelative(packageDirectory)}`,
      { npm_config_cache: npmCacheDirectory() },
    );
  }

  const compilerArgs = [...npmInvocation.args, "publish", prepared.compilerPackageDirectory];
  if (options.dryRun) {
    compilerArgs.push("--dry-run");
  }
  if (options.tag) {
    compilerArgs.push("--tag", options.tag);
  }
  runCommand(
    spawn,
    npmInvocation.command,
    compilerArgs,
    workspaceRoot,
    `Failed to publish ${workspaceRelative(prepared.compilerPackageDirectory)}`,
    { npm_config_cache: npmCacheDirectory() },
  );
}

export async function prepareRelease(options: ReleaseOptions, deps: ReleaseDeps = {}): Promise<PreparedRelease> {
  const hostTarget = resolveNativeTarget();
  const targetList = parseTargetList(options.targets);
  const targets = resolveTargetsForMode(options.mode, hostTarget, targetList);
  return stageReleasePackages(options, options.mode, targets, deps);
}

export async function packPreparedRelease(options: ReleaseOptions, deps: ReleaseDeps = {}): Promise<string[]> {
  const prepared = await prepareRelease(options, deps);
  return packRelease(prepared, deps);
}

export async function publishPreparedRelease(options: ReleaseOptions, deps: ReleaseDeps = {}): Promise<void> {
  const prepared = await prepareRelease(options, deps);
  await publishRelease(prepared, options, deps);
}

async function runCli(command: ReleaseCommand, options: ReleaseOptions): Promise<void> {
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
      const opts = this.opts<{ mode: ReleaseMode; targets?: string; zig?: ZigPolicy; allowMissingTools?: boolean }>();
      await runCli("prepare", {
        mode: opts.mode,
        targets: opts.targets,
        zig: opts.zig,
        allowMissingTools: opts.allowMissingTools,
      });
    }),
  );

  addModeOptions(
    program.command("pack").action(async function (this: Command) {
      const opts = this.opts<{ mode: ReleaseMode; targets?: string; zig?: ZigPolicy; allowMissingTools?: boolean }>();
      await runCli("pack", {
        mode: opts.mode,
        targets: opts.targets,
        zig: opts.zig,
        allowMissingTools: opts.allowMissingTools,
      });
    }),
  );

  addModeOptions(
    program
      .command("publish")
      .option("--dry-run", "run npm publish in dry-run mode")
      .option("--tag <tag>", "publish tag", "latest")
      .action(async function (this: Command) {
        const opts = this.opts<{
          mode: ReleaseMode;
          targets?: string;
          dryRun?: boolean;
          tag?: string;
          zig?: ZigPolicy;
          allowMissingTools?: boolean;
        }>();
        await runCli("publish", {
          mode: opts.mode,
          targets: opts.targets,
          dryRun: opts.dryRun,
          tag: opts.tag,
          zig: opts.zig,
          allowMissingTools: opts.allowMissingTools,
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
