import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  nativeBuildOutputName,
  nativeTargetInfo,
  resolveNativeTarget,
  type NativeTarget,
  type NativeTargetInfo,
} from "./native-targets.ts";

export type NativeBuildProfile = "debug" | "release";
export type ZigPolicy = "auto" | "always" | "never";
export type BuildTool = "cargo" | "cargo-zigbuild";

export type ToolAvailability = {
  cargo: boolean;
  cargoZigbuild: boolean;
  zig: boolean;
};

export type BuildNativeArtifactOptions = {
  workspaceRoot: string;
  target: NativeTarget;
  hostTarget?: NativeTarget;
  profile?: NativeBuildProfile;
  manifestPath?: string;
  zigPolicy?: ZigPolicy;
  buildTool?: BuildTool;
  tools?: ToolAvailability;
  spawnSync?: typeof spawnSync;
  access?: typeof fs.access;
};

export type BuildNativeArtifactResult = {
  targetInfo: NativeTargetInfo;
  profile: NativeBuildProfile;
  sourceArtifactPath: string;
  command: BuildTool;
  args: string[];
};

export type NativeBuildToolSelection = BuildTool | { skip: true; reason: string };

function profileArg(profile: NativeBuildProfile): string[] {
  return profile === "release" ? ["--release"] : [];
}

function rustupBinDirectory(): string {
  return path.join(os.homedir(), ".cargo", "bin");
}

function zigCacheHome(): string {
  return path.join(os.tmpdir(), "aruna-zig-cache");
}

function zigBuildHome(): string {
  return process.platform === "darwin"
    ? "/private/tmp/aruna-zigbuild-home"
    : path.join(os.tmpdir(), "aruna-zigbuild-home");
}

function zigCacheEnv(): Record<string, string> {
  const cacheHome = zigCacheHome();
  return {
    XDG_CACHE_HOME: cacheHome,
    ZIG_GLOBAL_CACHE_DIR: path.join(cacheHome, "global"),
    ZIG_LOCAL_CACHE_DIR: path.join(cacheHome, "local"),
  };
}

async function withRustupPath(extraEnv: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
  const currentPath = extraEnv.PATH ?? process.env.PATH ?? "";
  return {
    ...process.env,
    ...extraEnv,
    PATH: [rustupBinDirectory(), currentPath]
      .filter((entry) => entry.length > 0)
      .join(path.delimiter),
  };
}

function resolveRustupToolchain(spawn: typeof spawnSync): string {
  const explicit = process.env.RUSTUP_TOOLCHAIN;
  if (typeof explicit === "string" && explicit.length > 0) {
    return explicit;
  }

  const result = spawn("rustup", ["show", "active-toolchain"], {
    stdio: "pipe",
    encoding: "utf8",
  });

  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error(
      "Failed to determine the active rustup toolchain. Set RUSTUP_TOOLCHAIN and retry.",
    );
  }

  const toolchain = result.stdout.trim().split(/\s+/)[0];
  if (!toolchain) {
    throw new Error("Failed to parse the active rustup toolchain. Set RUSTUP_TOOLCHAIN and retry.");
  }

  return toolchain;
}

function resolveRustupToolchainBinary(
  spawn: typeof spawnSync,
  toolchain: string,
  command: "cargo" | "rustc",
): string {
  const result = spawn("rustup", ["which", command, "--toolchain", toolchain], {
    stdio: "pipe",
    encoding: "utf8",
  });

  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error(`Failed to resolve ${command} for rustup toolchain ${toolchain}.`);
  }

  const resolved = result.stdout.trim();
  if (resolved.length === 0) {
    throw new Error(`rustup returned an empty path for ${command} on toolchain ${toolchain}.`);
  }

  return resolved;
}

function versionCheck(spawn: typeof spawnSync, command: string, args: string[]): boolean {
  const result = spawn(command, args, {
    stdio: "pipe",
    encoding: "utf8",
  });

  return result.error === undefined && result.status === 0;
}

export function detectToolAvailability(spawn: typeof spawnSync = spawnSync): ToolAvailability {
  return {
    cargo: versionCheck(spawn, "cargo", ["--version"]),
    cargoZigbuild: versionCheck(spawn, "cargo-zigbuild", ["--version"]),
    zig: versionCheck(spawn, "zig", ["version"]),
  };
}

function targetArtifactCandidates(
  workspaceRoot: string,
  targetInfo: NativeTargetInfo,
  profile: NativeBuildProfile,
): string[] {
  const targetDir = path.join(workspaceRoot, "target");
  const genericTargetDir = path.join(targetDir, profile);
  return [
    path.join(targetDir, targetInfo.rustTarget, profile, nativeBuildOutputName(targetInfo.target)),
    path.join(targetDir, targetInfo.rustTarget, profile, "aruna_napi.node"),
    path.join(genericTargetDir, nativeBuildOutputName(targetInfo.target)),
    path.join(genericTargetDir, "aruna_napi.node"),
  ];
}

async function resolveArtifactPath(
  workspaceRoot: string,
  target: NativeTarget,
  profile: NativeBuildProfile,
  access: typeof fs.access,
): Promise<string> {
  const candidates = targetArtifactCandidates(workspaceRoot, nativeTargetInfo(target), profile);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep trying the remaining real build output locations.
    }
  }

  throw new Error(
    [
      `Could not find the native build artifact for ${target}.`,
      "Searched:",
      ...candidates.map((candidate) => `- ${candidate}`),
    ].join("\n"),
  );
}

async function ensureRustTargetInstalled(
  spawn: typeof spawnSync,
  rustTarget: string,
  workspaceRoot: string,
  toolchain: string,
): Promise<void> {
  const result = spawn("rustup", ["target", "add", "--toolchain", toolchain, rustTarget], {
    cwd: workspaceRoot,
    stdio: "inherit",
    env: await withRustupPath(),
  });

  if (result.error) {
    throw new Error(
      `Failed to install Rust target ${rustTarget}: ${result.error.message}. ` +
        `Install it manually with \`rustup target add ${rustTarget}\` and retry.`,
    );
  }

  if (result.status !== 0) {
    throw new Error(
      `rustup target add ${rustTarget} failed. Install it manually with \`rustup target add ${rustTarget}\` and retry.`,
    );
  }
}

function buildToolMissingMessage(missing: string[]): string {
  return missing.length === 1 ? missing[0] : missing.join(" and ");
}

export function selectNativeBuildTool(args: {
  target: NativeTarget;
  hostTarget: NativeTarget;
  policy: ZigPolicy;
  tools: ToolAvailability;
  allowMissingTools?: boolean;
}): NativeBuildToolSelection {
  const targetInfo = nativeTargetInfo(args.target);

  if (!args.tools.cargo) {
    throw new Error(`cargo is unavailable. Native builds require cargo for ${args.target}.`);
  }

  if (args.target === args.hostTarget) {
    return "cargo";
  }

  if (targetInfo.os !== "linux") {
    const reason = `Cross-compiling ${args.target} from ${args.hostTarget} is not supported. Only Linux targets can use cargo-zigbuild in this release.`;
    if (args.allowMissingTools) {
      return { skip: true, reason };
    }
    throw new Error(reason);
  }

  if (args.policy === "never") {
    const reason = `--zig never forbids cargo-zigbuild for ${args.target}. This target cannot be built with plain cargo on the current host.`;
    if (args.allowMissingTools) {
      return { skip: true, reason };
    }
    throw new Error(reason);
  }

  const missingTools: string[] = [];
  if (!args.tools.cargoZigbuild) {
    missingTools.push("cargo-zigbuild");
  }
  if (!args.tools.zig) {
    missingTools.push("zig");
  }

  if (missingTools.length > 0) {
    const reason = `Cannot build ${args.target} with cargo-zigbuild because ${buildToolMissingMessage(missingTools)} ${missingTools.length === 1 ? "is" : "are"} unavailable.`;
    if (args.allowMissingTools) {
      return { skip: true, reason };
    }

    throw new Error(
      `${reason} Re-run with --allow-missing-tools to skip this target or install the missing build tools.`,
    );
  }

  return "cargo-zigbuild";
}

export function resolveNativeArtifactCandidates(
  workspaceRoot: string,
  target: NativeTarget,
  profile: NativeBuildProfile,
): string[] {
  return targetArtifactCandidates(workspaceRoot, nativeTargetInfo(target), profile);
}

export async function buildNativeArtifact(
  options: BuildNativeArtifactOptions,
): Promise<BuildNativeArtifactResult> {
  const spawn = options.spawnSync ?? spawnSync;
  const access = options.access ?? fs.access;
  const profile = options.profile ?? "debug";
  const targetInfo = nativeTargetInfo(options.target);
  const hostTarget = options.hostTarget ?? resolveNativeTarget();
  const toolchain = resolveRustupToolchain(spawn);
  const toolchainCargo = resolveRustupToolchainBinary(spawn, toolchain, "cargo");
  const toolchainRustc = resolveRustupToolchainBinary(spawn, toolchain, "rustc");
  const buildTool =
    options.buildTool ??
    (() => {
      const selection = selectNativeBuildTool({
        target: options.target,
        hostTarget,
        policy: options.zigPolicy ?? "auto",
        tools: options.tools ?? detectToolAvailability(spawn),
      });

      if (typeof selection === "string") {
        return selection;
      }

      throw new Error(selection.reason);
    })();

  if (buildTool === "cargo-zigbuild") {
    await ensureRustTargetInstalled(spawn, targetInfo.rustTarget, options.workspaceRoot, toolchain);
  }

  const extraEnv: Record<string, string> = {
    CARGO: toolchainCargo,
    RUSTC: toolchainRustc,
    ...(buildTool === "cargo-zigbuild" ? zigCacheEnv() : {}),
  };

  if (buildTool === "cargo-zigbuild") {
    extraEnv.HOME = zigBuildHome();
    extraEnv.CARGO_HOME = path.join(os.homedir(), ".cargo");
    extraEnv.RUSTUP_HOME = path.join(os.homedir(), ".rustup");

    await fs.mkdir(extraEnv.HOME, { recursive: true });
    await fs.mkdir(extraEnv.CARGO_HOME, { recursive: true });
    await fs.mkdir(extraEnv.RUSTUP_HOME, { recursive: true });
    await fs.mkdir(extraEnv.XDG_CACHE_HOME, { recursive: true });
    await fs.mkdir(extraEnv.ZIG_GLOBAL_CACHE_DIR, { recursive: true });
    await fs.mkdir(extraEnv.ZIG_LOCAL_CACHE_DIR, { recursive: true });
  }

  const args = [
    buildTool === "cargo-zigbuild" ? "zigbuild" : "build",
    "--manifest-path",
    options.manifestPath ?? path.join(options.workspaceRoot, "crates", "aruna_napi", "Cargo.toml"),
    "--package",
    "aruna_napi",
    "--features",
    "napi-addon",
    ...(buildTool === "cargo-zigbuild" ? ["--target", targetInfo.rustTarget] : []),
    ...profileArg(profile),
  ];

  const result = spawn("rustup", ["run", toolchain, "cargo", ...args], {
    cwd: options.workspaceRoot,
    stdio: "inherit",
    env: await withRustupPath(extraEnv),
  });

  if (result.error) {
    const installHint =
      buildTool === "cargo-zigbuild"
        ? "Install cargo-zigbuild with `cargo install cargo-zigbuild` and make sure Zig is on PATH."
        : "Retry the native build after confirming cargo is installed and the target toolchain is available.";
    throw new Error(`Failed to run ${buildTool}: ${result.error.message}. ${installHint}`);
  }

  if (result.status !== 0) {
    throw new Error(
      buildTool === "cargo-zigbuild"
        ? `cargo-zigbuild failed to build the requested native target. Install cargo-zigbuild with \`cargo install cargo-zigbuild\`, make sure Zig is on PATH, and ensure the Rust target is installed with \`rustup target add ${targetInfo.rustTarget}\`.`
        : "cargo build failed to build the requested native target.",
    );
  }

  const sourceArtifactPath = await resolveArtifactPath(
    options.workspaceRoot,
    options.target,
    profile,
    access,
  );

  return {
    targetInfo,
    profile,
    sourceArtifactPath,
    command: buildTool,
    args,
  };
}
