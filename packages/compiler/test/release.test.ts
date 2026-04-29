import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  canBuildTargetOnHost,
  parseTargetList,
  prepareRelease,
  publishPreparedRelease,
  packPreparedRelease,
  resolveTargetsForMode,
} from "../../../scripts/release.ts";
import {
  nativePackageName,
  nativeTargetInfo,
  resolveNativeTarget,
  SUPPORTED_NATIVE_TARGETS,
  type NativeTarget,
} from "../src/native-platform.ts";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function cleanReleaseArtifacts(): Promise<void> {
  await fsp.rm(path.join(workspaceRoot, ".npm"), { recursive: true, force: true });
  await fsp.rm(path.join(workspaceRoot, ".npm-pack"), { recursive: true, force: true });
}

async function createNativeArtifact(target: string): Promise<string> {
  const artifactRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "aruna-release-artifact-"));
  const artifactPath = path.join(artifactRoot, `${target}.node`);
  await fsp.writeFile(artifactPath, `artifact:${target}`);
  return artifactPath;
}

async function stageCompilerPackageStub({
  workspaceRoot,
  version,
  nativeTargets,
}: {
  workspaceRoot: string;
  version: string;
  nativeTargets: readonly NativeTarget[];
}): Promise<{ packageDirectory: string; packageJsonPath: string }> {
  const packageDirectory = path.join(workspaceRoot, ".npm", "compiler");
  const distDirectory = path.join(packageDirectory, "dist");
  const packageJsonPath = path.join(packageDirectory, "package.json");
  await fsp.mkdir(distDirectory, { recursive: true });
  await fsp.writeFile(path.join(distDirectory, "index.js"), "export {};\n");
  await fsp.writeFile(path.join(distDirectory, "index.d.ts"), "export {};\n");
  await fsp.writeFile(
    packageJsonPath,
    JSON.stringify(
      {
        name: "@arunajs/compiler",
        version,
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
          "@arunajs/core": version,
          typescript: "^5.8.3",
        },
        optionalDependencies: Object.fromEntries(nativeTargets.map((target) => [nativePackageName(target), version])),
      },
      null,
      2,
    ),
  );
  return { packageDirectory, packageJsonPath };
}

describe("release orchestrator", () => {
  const hostTarget = resolveNativeTarget();

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanReleaseArtifacts();
  });

  afterEach(async () => {
    await cleanReleaseArtifacts();
    vi.restoreAllMocks();
  });

  it("selects the current host target in local mode", () => {
    expect(resolveTargetsForMode("local", hostTarget, [])).toEqual([hostTarget]);
    expect(parseTargetList("linux-x64-gnu, linux-arm64-gnu")).toEqual(["linux-x64-gnu", "linux-arm64-gnu"]);
  });

  it("parses cross mode targets and rejects missing or unsupported target lists", () => {
    expect(() => resolveTargetsForMode("cross", hostTarget, [])).toThrow("Cross mode requires --targets.");

    const unsupportedTarget = hostTarget === "darwin-arm64" || hostTarget === "darwin-x64" ? "win32-x64-msvc" : "darwin-arm64";
    expect(canBuildTargetOnHost(hostTarget, "linux-x64-gnu")).toBe(true);
    expect(canBuildTargetOnHost(hostTarget, "linux-x64-musl")).toBe(false);
    expect(canBuildTargetOnHost(hostTarget, unsupportedTarget as NativeTarget)).toBe(false);
    expect(() => resolveTargetsForMode("cross", hostTarget, [unsupportedTarget as NativeTarget])).toThrow(
      /Unsupported cross target\(s\)/,
    );
  });

  it("maps Linux targets to cargo-zigbuild and real rust triples", () => {
    const linuxTargets = ["linux-x64-gnu", "linux-arm64-gnu", "linux-x64-musl", "linux-arm64-musl"] as const;
    for (const target of linuxTargets) {
      const info = nativeTargetInfo(target);
      expect(info.rustTarget).toMatch(/unknown-linux-(gnu|musl)$/);
      expect(info.buildTool).toBe("cargo-zigbuild");
    }
  });

  it("stages local mode with host-only optional dependencies and no workspace protocols", async () => {
    const buildNativeArtifact = vi.fn(async (options: { target: NativeTarget; [key: string]: unknown }) => {
      const sourceArtifactPath = await createNativeArtifact(options.target);
      return {
        targetInfo: nativeTargetInfo(options.target),
        profile: "release",
        sourceArtifactPath,
        command: "cargo",
        args: [],
      };
    });
    const spawnSync = vi.fn(() => ({ status: 0, error: undefined }));

    const prepared = await prepareRelease(
      { mode: "local" },
      {
        spawnSync,
        buildNativeArtifact,
        stageCompilerPackage: stageCompilerPackageStub,
      },
    );

    expect(prepared.nativeTargets).toEqual([hostTarget]);
    expect(prepared.skippedTargets).toEqual([]);
    expect(buildNativeArtifact).toHaveBeenCalledTimes(1);
    expect(buildNativeArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        target: hostTarget,
        hostTarget,
        profile: "release",
      }),
    );

    const compilerPackageJson = JSON.parse(
      await fsp.readFile(path.join(workspaceRoot, ".npm", "compiler", "package.json"), "utf8"),
    ) as {
      optionalDependencies: Record<string, string>;
    };
    expect(compilerPackageJson.optionalDependencies).toEqual({
      [nativePackageName(hostTarget)]: "0.1.0",
    });

    const stagedPackageJsons = await Promise.all(
      [path.join(workspaceRoot, ".npm", `compiler-${hostTarget}`, "package.json"), path.join(workspaceRoot, ".npm", "compiler", "package.json")].map(
        async (packageJsonPath) => fsp.readFile(packageJsonPath, "utf8"),
      ),
    );
    for (const packageJsonText of stagedPackageJsons) {
      expect(packageJsonText).not.toContain("workspace:*");
    }
  });

  it("includes all host-buildable targets in full mode", () => {
    expect(resolveTargetsForMode("full", hostTarget, [])).toEqual(
      SUPPORTED_NATIVE_TARGETS.filter((target) => canBuildTargetOnHost(hostTarget, target)),
    );
  });

  it("skips missing cross-target tools without staging fake packages when allowed", async () => {
    const buildNativeArtifact = vi.fn();
    const stageNativePackage = vi.fn();
    const spawnSync = vi.fn(() => ({ status: 0, error: undefined }));
    const prepared = await prepareRelease(
      {
        mode: "cross",
        targets: "linux-x64-gnu",
        allowMissingTools: true,
      },
      {
        spawnSync,
        buildNativeArtifact,
        stageNativePackage,
        stageCompilerPackage: stageCompilerPackageStub,
        toolAvailability: {
          cargo: true,
          cargoZigbuild: false,
          zig: false,
        },
      },
    );

    expect(prepared.nativeTargets).toEqual([]);
    expect(prepared.skippedTargets).toHaveLength(1);
    expect(prepared.skippedTargets[0]).toMatchObject({
      target: "linux-x64-gnu",
    });
    expect(buildNativeArtifact).not.toHaveBeenCalled();
    expect(stageNativePackage).not.toHaveBeenCalled();

    const compilerPackageJson = JSON.parse(
      await fsp.readFile(path.join(workspaceRoot, ".npm", "compiler", "package.json"), "utf8"),
    ) as {
      optionalDependencies: Record<string, string>;
    };
    expect(compilerPackageJson.optionalDependencies).toEqual({});

    await expect(fsp.access(path.join(workspaceRoot, ".npm", "compiler-linux-x64-gnu"))).rejects.toThrow();
    const rootEntries = (await fsp.readdir(path.join(workspaceRoot, ".npm"))).filter((entry) => !entry.startsWith("."));
    expect(rootEntries).toEqual(["compiler"]);
  });

  it("stages cross mode targets with target-qualified artifacts", async () => {
    const targets = ["linux-x64-gnu", "linux-arm64-gnu"] as const;
    const buildNativeArtifact = vi.fn(async (options: { target: NativeTarget; [key: string]: unknown }) => {
      const sourceArtifactPath = await createNativeArtifact(options.target);
      return {
        targetInfo: nativeTargetInfo(options.target),
        profile: "release",
        sourceArtifactPath,
        command: "cargo-zigbuild",
        args: [],
      };
    });
    const spawnSync = vi.fn(() => ({ status: 0, error: undefined }));

    const prepared = await prepareRelease(
      { mode: "cross", targets: targets.join(",") },
      {
        spawnSync,
        buildNativeArtifact,
        stageCompilerPackage: stageCompilerPackageStub,
      },
    );

    expect(prepared.nativeTargets).toEqual([...targets]);
    expect(buildNativeArtifact).toHaveBeenCalledTimes(targets.length);
    expect(buildNativeArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: "release",
      }),
    );

    for (const target of targets) {
      const artifactPath = path.join(workspaceRoot, ".npm", `compiler-${target}`, `compiler.${target}.node`);
      expect(await fsp.readFile(artifactPath, "utf8")).toBe(`artifact:${target}`);
    }
    const compilerPackageJson = JSON.parse(
      await fsp.readFile(path.join(workspaceRoot, ".npm", "compiler", "package.json"), "utf8"),
    ) as {
      optionalDependencies: Record<string, string>;
    };
    expect(compilerPackageJson.optionalDependencies).toEqual({
      [nativePackageName("linux-x64-gnu")]: "0.1.0",
      [nativePackageName("linux-arm64-gnu")]: "0.1.0",
    });
  });

  it("fails full mode when a required target cannot be staged", async () => {
    const buildNativeArtifact = vi.fn(async (options: { target: NativeTarget; [key: string]: unknown }) => {
      if (options.target === "linux-arm64-gnu") {
        throw new Error("missing native build output");
      }
      const sourceArtifactPath = await createNativeArtifact(options.target);
      return {
        targetInfo: nativeTargetInfo(options.target),
        profile: "release",
        sourceArtifactPath,
        command: "cargo-zigbuild",
        args: [],
      };
    });

    await expect(
      prepareRelease(
        { mode: "full" },
        {
          spawnSync: vi.fn(() => ({ status: 0, error: undefined })),
          buildNativeArtifact,
          stageCompilerPackage: stageCompilerPackageStub,
        },
      ),
    ).rejects.toThrow();
  });

  it("packs native packages before the compiler package", async () => {
    const packDestination = path.join(workspaceRoot, ".npm-pack");
    const buildNativeArtifact = vi.fn(async (options: { target: NativeTarget; [key: string]: unknown }) => {
      const sourceArtifactPath = await createNativeArtifact(options.target);
      return {
        targetInfo: nativeTargetInfo(options.target),
        profile: "release",
        sourceArtifactPath,
        command: "cargo",
        args: [],
      };
    });
    const spawnCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const spawnSync = vi.fn((command: string, args: string[], options: { cwd: string }) => {
      spawnCalls.push({ command, args, cwd: options.cwd });
      if (args.includes("pack")) {
        const destinationIndex = args.indexOf("--pack-destination");
        const destination = destinationIndex >= 0 ? args[destinationIndex + 1] : packDestination;
        const tarballName = `${path.basename(options.cwd)}.tgz`;
        fs.writeFileSync(path.join(destination, tarballName), "tarball");
      }
      return { status: 0, error: undefined };
    });

    await packPreparedRelease(
      { mode: "local" },
      {
        spawnSync,
        buildNativeArtifact,
        stageCompilerPackage: stageCompilerPackageStub,
      },
    );

    const packCalls = spawnCalls.filter((entry) => entry.args.includes("pack"));
    expect(packCalls[0]?.cwd).toBe(path.join(workspaceRoot, ".npm", `compiler-${hostTarget}`));
    expect(packCalls[packCalls.length - 1]?.cwd).toBe(path.join(workspaceRoot, ".npm", "compiler"));
    expect(await fsp.readdir(packDestination)).toContain("compiler.tgz");
  });

  it("publishes from staged packages only during dry-run", async () => {
    const buildNativeArtifact = vi.fn(async (options: { target: NativeTarget; [key: string]: unknown }) => {
      const sourceArtifactPath = await createNativeArtifact(options.target);
      return {
        targetInfo: nativeTargetInfo(options.target),
        profile: "release",
        sourceArtifactPath,
        command: "cargo",
        args: [],
      };
    });
    const spawnCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const spawnSync = vi.fn((command: string, args: string[], options: { cwd: string }) => {
      spawnCalls.push({ command, args, cwd: options.cwd });
      return { status: 0, error: undefined };
    });

    await publishPreparedRelease(
      { mode: "local", dryRun: true, tag: "next" },
      {
        spawnSync,
        buildNativeArtifact,
        stageCompilerPackage: stageCompilerPackageStub,
      },
    );

    expect(spawnCalls.some((entry) => entry.args.includes("whoami"))).toBe(false);
    const publishCalls = spawnCalls.filter((entry) => entry.args.includes("publish"));
    expect(publishCalls.length).toBeGreaterThan(0);
    for (const entry of publishCalls) {
      expect(entry.args.join(" ")).toContain(".npm/");
      expect(entry.args.join(" ")).not.toContain("packages/");
      expect(entry.args).toContain("--dry-run");
      expect(entry.args).toContain("--tag");
      expect(entry.args).toContain("next");
    }
  });
});
