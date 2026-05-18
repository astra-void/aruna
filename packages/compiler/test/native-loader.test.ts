import fs from "node:fs";
import fsp from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  nativeArtifactName,
  nativeBuildOutputName,
  nativePackageName,
  nativeTargetInfo,
  resolveNativeTarget,
} from "../src/native-platform.ts";

type DlopenModule = {
  exports: unknown;
  filename?: string | undefined;
  paths?: string[] | undefined;
};

const mockRequire = vi.fn(() => {
  throw new Error("mock native load failure");
});

vi.mock("node:module", () => ({
  createRequire: () => mockRequire,
}));

describe("loadNativeCompiler", () => {
  let loadNativeCompiler: typeof import("../src/native.ts").loadNativeCompiler;

  beforeEach(async () => {
    vi.resetModules();
    mockRequire.mockReset();
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    ({ loadNativeCompiler } = await import("../src/native.ts"));
    mockRequire.mockImplementation(() => {
      throw new Error("mock native load failure");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes the staged package path, installed package path, and workspace outputs in failures", () => {
    const target = resolveNativeTarget();
    const rustTarget = nativeTargetInfo(target).rustTarget;
    const buildOutputName = nativeBuildOutputName(target);
    const expectedPackage = `${nativePackageName(target)}/${nativeArtifactName(target)}`;
    const stagedPackagePath = `.npm/compiler-${target}/${nativeArtifactName(target)}`;
    const installedPackagePath = `node_modules/${nativePackageName(target)}/${nativeArtifactName(target)}`;

    try {
      loadNativeCompiler();
      throw new Error("Expected native load to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain(
        `Aruna native compiler could not be loaded for ${process.platform}/${process.arch}.`,
      );
      expect(message).toContain(`Resolved native target: ${target}`);
      expect(message).toContain(`Expected native package: ${expectedPackage}`);
      expect(message).toContain(`Expected native artifact: ${nativeArtifactName(target)}`);
      expect(message).toContain("Attempted paths:");
      expect(message).toContain(`- ${stagedPackagePath}`);
      expect(message).toContain(`- ${installedPackagePath}`);
      expect(message).toContain(`- target/${rustTarget}/debug/${buildOutputName}`);
      expect(message).toContain(`- target/release/${buildOutputName}`);
      expect(message).toContain(`- target/debug/aruna_napi.node`);
      expect(message).toContain(`- target/release/aruna_napi.node`);
      expect(message).toContain(
        "Run pnpm build:native for local development, reinstall dependencies, or verify platform support.",
      );
      expect(message).toContain("There is no TypeScript analyzer fallback.");
    }
  });

  it("loads the staged native artifact before package resolution", () => {
    const target = resolveNativeTarget();
    const stagedPackagePath = `.npm/compiler-${target}/${nativeArtifactName(target)}`;
    const loadedCompiler = { checkProject: vi.fn(), inspectProject: vi.fn() };

    vi.spyOn(fs, "existsSync").mockImplementation((candidate: string) =>
      candidate.endsWith(stagedPackagePath),
    );
    mockRequire.mockImplementationOnce((specifier: string) => {
      expect(specifier).toContain(stagedPackagePath);
      return loadedCompiler;
    });

    const result = loadNativeCompiler();

    expect(result).toBe(loadedCompiler);
    expect(mockRequire).toHaveBeenCalledTimes(1);
  });

  it("falls back to the installed package when the staged artifact is missing", () => {
    const target = resolveNativeTarget();
    const expectedPackage = `${nativePackageName(target)}/${nativeArtifactName(target)}`;
    const stagedPackagePath = `.npm/compiler-${target}/${nativeArtifactName(target)}`;
    const loadedCompiler = { checkProject: vi.fn(), inspectProject: vi.fn() };

    mockRequire.mockImplementationOnce((specifier: string) => {
      expect(specifier).toBe(expectedPackage);
      return loadedCompiler;
    });

    const result = loadNativeCompiler();

    expect(result).toBe(loadedCompiler);
    expect(fs.existsSync).toHaveBeenCalledTimes(1);
    expect(fs.existsSync).toHaveBeenCalledWith(expect.stringContaining(stagedPackagePath));
    expect(mockRequire).toHaveBeenCalledTimes(1);
  });

  it("falls back to the installed target path before workspace build outputs", () => {
    const target = resolveNativeTarget();
    const buildOutputName = nativeBuildOutputName(target);
    const expectedPackage = `${nativePackageName(target)}/${nativeArtifactName(target)}`;
    const installedPackagePath = `node_modules/${nativePackageName(target)}/${nativeArtifactName(target)}`;
    const debugFallback = `target/debug/${buildOutputName}`;
    const loadedCompiler = { checkProject: vi.fn(), inspectProject: vi.fn() };

    mockRequire
      .mockImplementationOnce(() => {
        throw new Error("installed package missing");
      })
      .mockImplementationOnce((specifier: string) => {
        expect(specifier).toContain(installedPackagePath);
        return loadedCompiler;
      });

    vi.spyOn(fs, "existsSync").mockImplementation((candidate: string) =>
      candidate.endsWith(installedPackagePath),
    );

    const result = loadNativeCompiler();

    expect(result).toBe(loadedCompiler);
    expect(mockRequire.mock.calls[0]?.[0]).toBe(expectedPackage);
    expect(mockRequire.mock.calls[1]?.[0]).toContain(installedPackagePath);
    expect(mockRequire).toHaveBeenCalledTimes(2);
    expect(fs.existsSync).toHaveBeenCalledWith(expect.stringContaining(installedPackagePath));
    expect(fs.existsSync).not.toHaveBeenCalledWith(expect.stringContaining(debugFallback));
  });

  it("tries debug and then release workspace outputs when the staged package is absent", () => {
    const target = resolveNativeTarget();
    const buildOutputName = nativeBuildOutputName(target);
    const expectedPackage = `${nativePackageName(target)}/${nativeArtifactName(target)}`;
    const debugFallback = `target/debug/${buildOutputName}`;
    const loadedCompiler = { checkProject: vi.fn(), inspectProject: vi.fn() };

    mockRequire
      .mockImplementationOnce(() => {
        throw new Error("installed package missing");
      })
      .mockImplementationOnce(() => {
        throw new Error("installed target path missing");
      });

    vi.spyOn(fs, "existsSync").mockImplementation((candidate: string) => {
      return candidate.endsWith(debugFallback);
    });

    const dlopen = vi.spyOn(process, "dlopen");
    dlopen.mockImplementation((module: DlopenModule) => {
      module.exports = loadedCompiler;
    });

    const result = loadNativeCompiler();

    expect(result).toBe(loadedCompiler);
    expect(mockRequire.mock.calls[0]?.[0]).toBe(expectedPackage);
    expect(mockRequire).toHaveBeenCalledTimes(1);
    expect(dlopen).toHaveBeenCalledTimes(1);
    expect(dlopen.mock.calls[0]?.[1]).toContain(debugFallback);
  });

  it("does not contain an analyzer fallback path in the loader source", async () => {
    const source = await fsp.readFile(new URL("../src/native.ts", import.meta.url), "utf8");
    expect(source).not.toContain("analyzer.ts");
    expect(source).not.toContain("analyzer.js");
    expect(source).not.toContain("loadAnalyzer");
  });
});
