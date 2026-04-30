import { describe, expect, it } from "vitest";
import {
  nativeArtifactName,
  nativePackageName,
  nativeTargetInfo,
  resolveNativeTarget,
} from "../src/native-platform.ts";

describe("native target helpers", () => {
  it.each([
    [{ platform: "darwin", arch: "arm64" }, "darwin-arm64"],
    [{ platform: "darwin", arch: "x64" }, "darwin-x64"],
    [{ platform: "win32", arch: "x64" }, "win32-x64-msvc"],
    [{ platform: "win32", arch: "arm64" }, "win32-arm64-msvc"],
    [{ platform: "linux", arch: "x64", libc: "gnu" }, "linux-x64-gnu"],
    [{ platform: "linux", arch: "arm64", libc: "gnu" }, "linux-arm64-gnu"],
    [{ platform: "linux", arch: "x64", libc: "musl" }, "linux-x64-musl"],
    [{ platform: "linux", arch: "arm64", libc: "musl" }, "linux-arm64-musl"],
  ])("resolves %# to %s", (runtime, expected) => {
    expect(
      resolveNativeTarget(
        runtime as {
          platform: NodeJS.Platform;
          arch: NodeJS.Architecture;
          libc?: "gnu" | "musl";
        },
      ),
    ).toBe(expected);
  });

  it.each([
    [
      "darwin-arm64",
      "@arunajs/compiler-darwin-arm64",
      "compiler.darwin-arm64.node",
      "aarch64-apple-darwin",
      "cargo",
    ],
    [
      "darwin-x64",
      "@arunajs/compiler-darwin-x64",
      "compiler.darwin-x64.node",
      "x86_64-apple-darwin",
      "cargo",
    ],
    [
      "win32-x64-msvc",
      "@arunajs/compiler-win32-x64-msvc",
      "compiler.win32-x64-msvc.node",
      "x86_64-pc-windows-msvc",
      "cargo",
    ],
    [
      "win32-arm64-msvc",
      "@arunajs/compiler-win32-arm64-msvc",
      "compiler.win32-arm64-msvc.node",
      "aarch64-pc-windows-msvc",
      "cargo",
    ],
    [
      "linux-x64-gnu",
      "@arunajs/compiler-linux-x64-gnu",
      "compiler.linux-x64-gnu.node",
      "x86_64-unknown-linux-gnu",
      "cargo-zigbuild",
    ],
    [
      "linux-arm64-gnu",
      "@arunajs/compiler-linux-arm64-gnu",
      "compiler.linux-arm64-gnu.node",
      "aarch64-unknown-linux-gnu",
      "cargo-zigbuild",
    ],
    [
      "linux-x64-musl",
      "@arunajs/compiler-linux-x64-musl",
      "compiler.linux-x64-musl.node",
      "x86_64-unknown-linux-musl",
      "cargo-zigbuild",
    ],
    [
      "linux-arm64-musl",
      "@arunajs/compiler-linux-arm64-musl",
      "compiler.linux-arm64-musl.node",
      "aarch64-unknown-linux-musl",
      "cargo-zigbuild",
    ],
  ])(
    "maps %s to package, artifact, rust target, and build tool",
    (target, expectedPackage, expectedArtifact, expectedRustTarget, expectedBuildTool) => {
      const info = nativeTargetInfo(target);
      expect(nativePackageName(target)).toBe(expectedPackage);
      expect(nativeArtifactName(target)).toBe(expectedArtifact);
      expect(info.rustTarget).toBe(expectedRustTarget);
      expect(info.buildTool).toBe(expectedBuildTool);
    },
  );

  it.each([
    ["darwin-arm64", "darwin"],
    ["darwin-x64", "darwin"],
    ["win32-x64-msvc", "win32"],
    ["win32-arm64-msvc", "win32"],
    ["linux-x64-gnu", "linux"],
    ["linux-arm64-gnu", "linux"],
    ["linux-x64-musl", "linux"],
    ["linux-arm64-musl", "linux"],
  ])("maps %s to os families", (target, expectedOs) => {
    expect(nativeTargetInfo(target).os).toBe(expectedOs);
  });

  it("throws a useful error for unsupported arches", () => {
    expect(() =>
      resolveNativeTarget({ platform: "linux", arch: "s390x" as NodeJS.Architecture, libc: "gnu" }),
    ).toThrow(/linux\/s390x/);
  });

  it("throws a useful error for unsupported platforms", () => {
    expect(() =>
      resolveNativeTarget({
        platform: "freebsd" as NodeJS.Platform,
        arch: "x64" as NodeJS.Architecture,
      }),
    ).toThrow(/freebsd\/x64/);
  });
});
