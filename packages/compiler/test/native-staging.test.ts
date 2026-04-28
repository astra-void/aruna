import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  stagedCompilerPackageDirectory,
  stagedNativePackageArtifactPath,
  stagedNativePackageDirectory,
  SUPPORTED_NATIVE_TARGETS,
} from "../scripts/native-targets.ts";
import { stageCompilerPackage } from "../scripts/stage-compiler-package.ts";
import { stageNativePackage } from "../scripts/stage-native-package.ts";
import { nativePackageName } from "../src/native-platform.ts";

describe("native staging helpers", () => {
  it("generates target-qualified staging paths", () => {
    const workspaceRoot = "/tmp/aruna";
    expect(stagedNativePackageDirectory(workspaceRoot, "darwin-arm64")).toBe("/tmp/aruna/.npm/compiler-darwin-arm64");
    expect(stagedNativePackageArtifactPath(workspaceRoot, "darwin-arm64")).toBe(
      "/tmp/aruna/.npm/compiler-darwin-arm64/compiler.darwin-arm64.node",
    );
    expect(stagedCompilerPackageDirectory(workspaceRoot)).toBe("/tmp/aruna/.npm/compiler");
  });

  it("stages a native package with a target-qualified artifact filename", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-native-"));
    const sourceArtifactPath = path.join(workspaceRoot, "aruna_napi.so");
    await fs.writeFile(sourceArtifactPath, "native-binary");

    const staged = await stageNativePackage({
      workspaceRoot,
      version: "0.1.0",
      target: "darwin-arm64",
      sourceArtifactPath,
    });

    expect(staged.packageDirectory).toBe(path.join(workspaceRoot, ".npm", "compiler-darwin-arm64"));
    expect(staged.artifactPath).toBe(path.join(workspaceRoot, ".npm", "compiler-darwin-arm64", "compiler.darwin-arm64.node"));

    expect(await fs.readFile(staged.artifactPath, "utf8")).toBe("native-binary");

    const packageJson = JSON.parse(await fs.readFile(staged.packageJsonPath, "utf8")) as {
      name: string;
      version: string;
      main: string;
      files: string[];
    };
    expect(packageJson).toEqual({
      name: "@arunajs/compiler-darwin-arm64",
      version: "0.1.0",
      main: "./compiler.darwin-arm64.node",
      files: ["compiler.darwin-arm64.node"],
    });
  });

  it("stages the compiler manifest with real semver optional dependencies", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-compiler-"));
    const staged = await stageCompilerPackage({
      workspaceRoot,
      version: "0.1.0",
    });

    expect(staged.packageDirectory).toBe(path.join(workspaceRoot, ".npm", "compiler"));

    const packageJson = JSON.parse(await fs.readFile(staged.packageJsonPath, "utf8")) as {
      name: string;
      version: string;
      optionalDependencies: Record<string, string>;
    };

    expect(packageJson.name).toBe("@arunajs/compiler");
    expect(packageJson.version).toBe("0.1.0");
    expect(Object.keys(packageJson.optionalDependencies)).toEqual(SUPPORTED_NATIVE_TARGETS.map(nativePackageName));
    expect(Object.values(packageJson.optionalDependencies)).toEqual(Array(SUPPORTED_NATIVE_TARGETS.length).fill("0.1.0"));
  });
});
