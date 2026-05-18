import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { nativeBuildOutputName, nativeTargetInfo } from "../src/native-platform.ts";
import {
  hostBuildOutputName,
  readRequestedTarget,
  resolveHostNativeTarget,
  runBuildNativeTarget,
} from "../scripts/build-native-target-core.ts";

describe("build-native-target core", () => {
  const originalArgv = process.argv.slice();
  const originalRequestedTarget = process.env.ARUNA_NATIVE_TARGET;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.argv = ["node", "vitest"];
    delete process.env.ARUNA_NATIVE_TARGET;
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (originalRequestedTarget === undefined) {
      delete process.env.ARUNA_NATIVE_TARGET;
    } else {
      process.env.ARUNA_NATIVE_TARGET = originalRequestedTarget;
    }
    vi.restoreAllMocks();
  });

  it("keeps native staging on the current host target", async () => {
    const hostTarget = resolveHostNativeTarget();
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-native-build-core-"));
    const sourceArtifactPath = path.join(
      workspaceRoot,
      "target",
      "debug",
      nativeBuildOutputName(hostTarget),
    );
    await fs.mkdir(path.dirname(sourceArtifactPath), { recursive: true });
    await fs.writeFile(sourceArtifactPath, "native-binary");
    const buildNativeArtifact = vi.fn().mockResolvedValue({
      targetInfo: nativeTargetInfo(hostTarget),
      profile: "debug",
      sourceArtifactPath,
      command: "cargo",
      args: [],
    });
    const stageNativePackage = vi.fn().mockResolvedValue({
      packageDirectory: "/tmp/native/package",
      packageJsonPath: "/tmp/native/package/package.json",
      artifactPath: "/tmp/native/package/artifact.node",
    });
    const stageCompilerPackage = vi.fn().mockResolvedValue({
      packageDirectory: "/tmp/compiler/package",
      packageJsonPath: "/tmp/compiler/package.json",
    });
    const readVersion = vi.fn().mockResolvedValue("0.1.0");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const result = await runBuildNativeTarget({
      buildNativeArtifact,
      stageNativePackage,
      stageCompilerPackage,
      readVersion,
    });

    expect(result.hostTarget).toBe(hostTarget);
    expect(result.version).toBe("0.1.0");
    expect(result.sourceArtifactPath).toBe(sourceArtifactPath);
    expect(buildNativeArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        target: hostTarget,
        hostTarget,
        profile: "debug",
        manifestPath: expect.stringContaining("crates/aruna_napi/Cargo.toml"),
      }),
    );
    expect(stageNativePackage).toHaveBeenCalledWith(
      expect.objectContaining({
        target: hostTarget,
        sourceArtifactPath,
        version: "0.1.0",
      }),
    );
    expect(stageCompilerPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        version: "0.1.0",
        nativeTargets: [hostTarget],
        allowMissingDist: true,
      }),
    );
    expect(info).toHaveBeenCalledWith("Staged wrapper package: /tmp/compiler/package");
    expect(result.compilerPackageDirectory).toBe("/tmp/compiler/package");
  });

  it("skips wrapper staging when compiler dist is missing", async () => {
    const hostTarget = resolveHostNativeTarget();
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-native-build-core-skip-"));
    const sourceArtifactPath = path.join(
      workspaceRoot,
      "target",
      "debug",
      nativeBuildOutputName(hostTarget),
    );
    await fs.mkdir(path.dirname(sourceArtifactPath), { recursive: true });
    await fs.writeFile(sourceArtifactPath, "native-binary");
    const buildNativeArtifact = vi.fn().mockResolvedValue({
      targetInfo: nativeTargetInfo(hostTarget),
      profile: "debug",
      sourceArtifactPath,
      command: "cargo",
      args: [],
    });
    const stageNativePackage = vi.fn().mockResolvedValue({
      packageDirectory: "/tmp/native/package",
      packageJsonPath: "/tmp/native/package/package.json",
      artifactPath: "/tmp/native/package/artifact.node",
    });
    const stageCompilerPackage = vi.fn().mockResolvedValue(null);
    const readVersion = vi.fn().mockResolvedValue("0.1.0");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const result = await runBuildNativeTarget({
      buildNativeArtifact,
      stageNativePackage,
      stageCompilerPackage,
      readVersion,
    });

    expect(stageNativePackage).toHaveBeenCalledTimes(1);
    expect(stageCompilerPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        version: "0.1.0",
        nativeTargets: [hostTarget],
        allowMissingDist: true,
      }),
    );
    expect(info).toHaveBeenCalledWith(
      "Skipped wrapper package staging because packages/compiler/dist does not exist. Run pnpm build before release packaging.",
    );
    expect(result.compilerPackageDirectory).toBeNull();
  });

  it("refuses to fake a cross-target native build", async () => {
    const hostTarget = resolveHostNativeTarget();
    const requestedTarget = hostTarget === "darwin-arm64" ? "darwin-x64" : "darwin-arm64";
    process.env.ARUNA_NATIVE_TARGET = requestedTarget;

    await expect(
      runBuildNativeTarget({
        readVersion: vi.fn().mockResolvedValue("0.1.0"),
      }),
    ).rejects.toThrow(
      `Explicit native target "${requestedTarget}" does not match the current host target "${hostTarget}".`,
    );
  });

  it("rejects unsupported explicit native targets", () => {
    process.env.ARUNA_NATIVE_TARGET = "fake-platform";

    expect(() => readRequestedTarget()).toThrow(
      'Unsupported explicit native target "fake-platform".',
    );
  });

  it("stops before staging when the native build output is missing", async () => {
    const buildNativeArtifact = vi.fn().mockRejectedValue(new Error("missing native build output"));
    const stageNativePackage = vi.fn();
    const stageCompilerPackage = vi.fn();

    await expect(
      runBuildNativeTarget({
        buildNativeArtifact,
        stageNativePackage,
        stageCompilerPackage,
        readVersion: vi.fn().mockResolvedValue("0.1.0"),
      }),
    ).rejects.toThrow("missing native build output");

    expect(stageNativePackage).not.toHaveBeenCalled();
    expect(stageCompilerPackage).not.toHaveBeenCalled();
  });

  it("uses the platform-specific native build output name", () => {
    expect(hostBuildOutputName()).toBe(nativeBuildOutputName(resolveHostNativeTarget()));
  });
});
