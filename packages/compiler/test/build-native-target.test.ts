import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { nativeBuildOutputName, nativeTargetInfo } from "../src/native-platform.ts";
import {
  findNativeBuildArtifact,
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
    const buildNativeArtifact = vi.fn().mockResolvedValue({
      targetInfo: nativeTargetInfo(hostTarget),
      profile: "debug",
      sourceArtifactPath: findNativeBuildArtifact(),
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

    const result = await runBuildNativeTarget({
      buildNativeArtifact,
      stageNativePackage,
      stageCompilerPackage,
      readVersion,
    });

    expect(result.hostTarget).toBe(hostTarget);
    expect(result.version).toBe("0.1.0");
    expect(result.sourceArtifactPath).toBe(findNativeBuildArtifact());
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
        sourceArtifactPath: findNativeBuildArtifact(),
        version: "0.1.0",
      }),
    );
    expect(stageCompilerPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        version: "0.1.0",
        nativeTargets: [hostTarget],
      }),
    );
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
