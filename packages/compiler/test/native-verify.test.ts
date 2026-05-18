import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stageNativePackage } from "../scripts/stage-native-package.ts";
import { verifyNativePackage } from "../scripts/verify-native-target.ts";

describe("native verification helper", () => {
  it("verifies the staged native package for the current host target", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-native-verify-"));
    const sourceArtifactPath = path.join(workspaceRoot, "aruna_napi.node");
    await fs.writeFile(sourceArtifactPath, "native-binary");

    const staged = await stageNativePackage({
      workspaceRoot,
      version: "0.1.0",
      target: "darwin-arm64",
      sourceArtifactPath,
    });

    const result = await verifyNativePackage(workspaceRoot, "darwin-arm64");

    expect(result.packageDirectory).toBe(staged.packageDirectory);
    expect(result.packageJsonPath).toBe(staged.packageJsonPath);
    expect(result.artifactPath).toBe(staged.artifactPath);
  });

  it("fails clearly when the staged native package is missing", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-native-verify-missing-"));

    await expect(verifyNativePackage(workspaceRoot, "darwin-arm64")).rejects.toThrow();
  });
});
