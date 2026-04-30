import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildNativeArtifact,
  detectToolAvailability,
  resolveNativeArtifactCandidates,
  selectNativeBuildTool,
  type NativeBuildToolSelection,
  type ToolAvailability,
  type ZigPolicy,
} from "../scripts/native-build.ts";
import type { NativeTarget } from "../src/native-platform.ts";

describe("native build tool selection", () => {
  const hostTarget = "darwin-arm64" as NativeTarget;
  const linuxTarget = "linux-x64-gnu" as NativeTarget;
  const zigBuildHome =
    process.platform === "darwin"
      ? "/private/tmp/aruna-zigbuild-home"
      : path.join(os.tmpdir(), "aruna-zigbuild-home");

  function select(
    target: NativeTarget,
    policy: ZigPolicy,
    tools: ToolAvailability,
    allowMissingTools = false,
  ): NativeBuildToolSelection {
    return selectNativeBuildTool({
      target,
      hostTarget,
      policy,
      tools,
      allowMissingTools,
    });
  }

  it("uses cargo for the host target with auto", () => {
    expect(
      select(hostTarget, "auto", {
        cargo: true,
        cargoZigbuild: false,
        zig: false,
      }),
    ).toBe("cargo");
  });

  it("selects cargo-zigbuild for Linux cross targets with auto when available", () => {
    expect(
      select(linuxTarget, "auto", {
        cargo: true,
        cargoZigbuild: true,
        zig: true,
      }),
    ).toBe("cargo-zigbuild");
  });

  it("fails when auto selects a Linux cross target but cargo-zigbuild is missing", () => {
    expect(() =>
      select(linuxTarget, "auto", {
        cargo: true,
        cargoZigbuild: false,
        zig: true,
      }),
    ).toThrow("cargo-zigbuild");
  });

  it("skips a Linux cross target when cargo-zigbuild is missing and allow-missing-tools is set", () => {
    const selection = select(
      linuxTarget,
      "auto",
      {
        cargo: true,
        cargoZigbuild: false,
        zig: true,
      },
      true,
    );

    expect(selection).toMatchObject({
      skip: true,
    });
    expect(selection).toHaveProperty("reason");
  });

  it("fails when zig is required but unavailable", () => {
    expect(() =>
      select(linuxTarget, "always", {
        cargo: true,
        cargoZigbuild: true,
        zig: false,
      }),
    ).toThrow("zig");
  });

  it("fails when zig is forbidden for a Linux cross target", () => {
    expect(() =>
      select(linuxTarget, "never", {
        cargo: true,
        cargoZigbuild: true,
        zig: true,
      }),
    ).toThrow("--zig never");
  });

  it("detects cargo, cargo-zigbuild, and zig via version commands", () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      if (command === "cargo-zigbuild" && args[0] === "--version") {
        return { status: 0, error: undefined };
      }

      if (
        (command === "cargo" && args[0] === "--version") ||
        (command === "zig" && args[0] === "version")
      ) {
        return { status: 0, error: undefined };
      }

      return { status: 1, error: new Error("unexpected command") };
    });

    expect(detectToolAvailability(spawnSync as unknown as typeof spawnSync)).toEqual({
      cargo: true,
      cargoZigbuild: true,
      zig: true,
    });
    expect(spawnSync).toHaveBeenNthCalledWith(1, "cargo", ["--version"], expect.any(Object));
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
      "cargo-zigbuild",
      ["--version"],
      expect.any(Object),
    );
    expect(spawnSync).toHaveBeenNthCalledWith(3, "zig", ["version"], expect.any(Object));
  });

  it("installs the Rust target before running cargo-zigbuild", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-native-build-"));
    const artifactPath = path.join(
      workspaceRoot,
      "target",
      "x86_64-unknown-linux-gnu",
      "release",
      "libaruna_napi.so",
    );
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, "artifact");
    const cargoPath = "/Users/returnf4lse/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo";
    const rustcPath = "/Users/returnf4lse/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc";

    const spawnSync = vi.fn((command: string, args: string[], _options: { cwd: string }) => {
      if (command === "rustup" && args[0] === "show" && args[1] === "active-toolchain") {
        return { status: 0, error: undefined, stdout: "stable-aarch64-apple-darwin (default)\n" };
      }

      if (command === "rustup" && args[0] === "which" && args[1] === "cargo") {
        return { status: 0, error: undefined, stdout: `${cargoPath}\n` };
      }

      if (command === "rustup" && args[0] === "which" && args[1] === "rustc") {
        return { status: 0, error: undefined, stdout: `${rustcPath}\n` };
      }

      if (
        command === "rustup" &&
        args[0] === "target" &&
        args[1] === "add" &&
        args[2] === "x86_64-unknown-linux-gnu"
      ) {
        return { status: 0, error: undefined };
      }

      if (
        command === "rustup" &&
        args[0] === "run" &&
        args[2] === "cargo" &&
        args[3] === "zigbuild"
      ) {
        return { status: 0, error: undefined };
      }

      return { status: 0, error: undefined };
    });

    const result = await buildNativeArtifact({
      workspaceRoot,
      target: "linux-x64-gnu",
      hostTarget: "darwin-arm64",
      profile: "release",
      buildTool: "cargo-zigbuild",
      spawnSync: spawnSync as unknown as typeof import("node:child_process").spawnSync,
      access: fs.access,
    });

    expect(result.command).toBe("cargo-zigbuild");
    expect(spawnSync).toHaveBeenNthCalledWith(
      1,
      "rustup",
      ["show", "active-toolchain"],
      expect.any(Object),
    );
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
      "rustup",
      ["which", "cargo", "--toolchain", "stable-aarch64-apple-darwin"],
      expect.any(Object),
    );
    expect(spawnSync).toHaveBeenNthCalledWith(
      3,
      "rustup",
      ["which", "rustc", "--toolchain", "stable-aarch64-apple-darwin"],
      expect.any(Object),
    );
    expect(spawnSync).toHaveBeenNthCalledWith(
      4,
      "rustup",
      ["target", "add", "--toolchain", "stable-aarch64-apple-darwin", "x86_64-unknown-linux-gnu"],
      expect.objectContaining({
        cwd: workspaceRoot,
        stdio: "inherit",
        env: expect.objectContaining({
          PATH: expect.stringMatching(
            new RegExp(
              `^${path.join(os.homedir(), ".cargo", "bin").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
            ),
          ),
        }),
      }),
    );
    expect(spawnSync).toHaveBeenNthCalledWith(
      5,
      "rustup",
      [
        "run",
        "stable-aarch64-apple-darwin",
        "cargo",
        "zigbuild",
        "--manifest-path",
        path.join(workspaceRoot, "crates", "aruna_napi", "Cargo.toml"),
        "--package",
        "aruna_napi",
        "--features",
        "napi-addon",
        "--target",
        "x86_64-unknown-linux-gnu",
        "--release",
      ],
      expect.objectContaining({
        cwd: workspaceRoot,
        stdio: "inherit",
        env: expect.objectContaining({
          CARGO: cargoPath,
          CARGO_HOME: path.join(os.homedir(), ".cargo"),
          HOME: zigBuildHome,
          RUSTUP_HOME: path.join(os.homedir(), ".rustup"),
          RUSTC: rustcPath,
          PATH: expect.stringMatching(
            new RegExp(
              `^${path.join(os.homedir(), ".cargo", "bin").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
            ),
          ),
        }),
      }),
    );
  });

  it("includes generic release output paths for host-native cargo builds", () => {
    const candidates = resolveNativeArtifactCandidates("/tmp/aruna", "darwin-arm64", "release");
    expect(candidates).toContain("/tmp/aruna/target/release/libaruna_napi.dylib");
    expect(candidates).toContain("/tmp/aruna/target/release/aruna_napi.node");
  });
});
