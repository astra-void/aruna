import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  it("keeps .npm ignored at the repository root", async () => {
    const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const gitignore = await fs.readFile(path.join(workspaceRoot, ".gitignore"), "utf8");
    expect(gitignore).toContain(".npm");
  });

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
    expect(staged.packageJsonPath).toBe(path.join(workspaceRoot, ".npm", "compiler-darwin-arm64", "package.json"));
    expect(staged.artifactPath).toBe(path.join(workspaceRoot, ".npm", "compiler-darwin-arm64", "compiler.darwin-arm64.node"));

    expect(await fs.readFile(staged.artifactPath, "utf8")).toBe("native-binary");

    const packageJson = JSON.parse(await fs.readFile(staged.packageJsonPath, "utf8")) as {
      name: string;
      version: string;
      main: string;
      files: string[];
    };
    const packageJsonText = await fs.readFile(staged.packageJsonPath, "utf8");
    expect(packageJson).toEqual({
      name: "@arunajs/compiler-darwin-arm64",
      version: "0.1.0",
      main: "./compiler.darwin-arm64.node",
      files: ["compiler.darwin-arm64.node"],
    });
    expect(packageJsonText).not.toContain("workspace:*");
  });

  it("stages the compiler manifest with real semver optional dependencies", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-compiler-"));
    await fs.mkdir(path.join(workspaceRoot, "packages", "compiler", "dist"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "packages", "compiler", "package.json"),
      JSON.stringify(
        {
          name: "@arunajs/compiler",
          version: "0.1.0",
          type: "module",
          main: "./dist/index.js",
          module: "./dist/index.js",
          types: "./dist/index.d.ts",
          exports: {
            ".": {
              types: "./dist/index.d.ts",
              import: "./dist/index.js",
            },
          },
          files: ["dist"],
          dependencies: {
            "@arunajs/core": "workspace:*",
            typescript: "^5.8.3",
          },
        },
        null,
        2,
      ),
    );
    await fs.writeFile(path.join(workspaceRoot, "packages", "compiler", "dist", "index.js"), "export {};\n");
    await fs.writeFile(path.join(workspaceRoot, "packages", "compiler", "dist", "index.d.ts"), "export {};\n");
    const staged = await stageCompilerPackage({
      workspaceRoot,
      version: "0.1.0",
      nativeTargets: SUPPORTED_NATIVE_TARGETS,
    });

    expect(staged.packageDirectory).toBe(path.join(workspaceRoot, ".npm", "compiler"));
    expect(staged.packageJsonPath).toBe(path.join(workspaceRoot, ".npm", "compiler", "package.json"));
    expect(await fs.readFile(path.join(workspaceRoot, ".npm", "compiler", "dist", "index.js"), "utf8")).toBe(
      "export {};\n",
    );

    const packageJson = JSON.parse(await fs.readFile(staged.packageJsonPath, "utf8")) as {
      name: string;
      version: string;
      optionalDependencies: Record<string, string>;
      dependencies: Record<string, string>;
    };
    const packageJsonText = await fs.readFile(staged.packageJsonPath, "utf8");

    expect(packageJson.name).toBe("@arunajs/compiler");
    expect(packageJson.version).toBe("0.1.0");
    expect(Object.keys(packageJson.optionalDependencies)).toEqual(SUPPORTED_NATIVE_TARGETS.map(nativePackageName));
    expect(Object.values(packageJson.optionalDependencies)).toEqual(Array(SUPPORTED_NATIVE_TARGETS.length).fill("0.1.0"));
    expect(packageJson.dependencies["@arunajs/core"]).toBe("0.1.0");
    expect(packageJsonText).not.toContain("workspace:*");
  });
});
