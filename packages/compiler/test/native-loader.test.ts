import fs from "node:fs";
import fsp from "node:fs/promises";
import { vi, describe, expect, it, beforeEach, afterEach } from "vitest";
import { nativeArtifactName, nativePackageName, resolveNativeTarget } from "../src/native-platform.ts";

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
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    ({ loadNativeCompiler } = await import("../src/native.ts"));
    mockRequire.mockImplementation(() => {
      throw new Error("mock native load failure");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes the expected package and local fallback paths in the failure message", () => {
    const target = resolveNativeTarget();
    const expectedPackage = `${nativePackageName(target)}/${nativeArtifactName(target)}`;
    const localFallback = `.npm/compiler-${target}/${nativeArtifactName(target)}`;

    try {
      loadNativeCompiler();
      throw new Error("Expected native load to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain(`Aruna native compiler could not be loaded for ${process.platform}/${process.arch}.`);
      expect(message).toContain(`Resolved native target: ${target}`);
      expect(message).toContain(`Expected native package: ${expectedPackage}`);
      expect(message).toContain(`Expected native artifact: ${nativeArtifactName(target)}`);
      expect(message).toContain("Searched:");
      expect(message).toContain(`- ${expectedPackage}`);
      expect(message).toContain(`- ${localFallback}`);
      expect(message).toContain("- target/debug/aruna_napi.node");
      expect(message).toContain("- target/release/aruna_napi.node");
      expect(message).toContain(
        "Run pnpm build:native for local development, reinstall dependencies, or verify platform support.",
      );
      expect(message).toContain("There is no TypeScript analyzer fallback.");
    }
  });

  it("does not contain an analyzer fallback path in the loader source", async () => {
    const source = await fsp.readFile(new URL("../src/native.ts", import.meta.url), "utf8");
    expect(source).not.toContain("analyzer.ts");
    expect(source).not.toContain("analyzer.js");
    expect(source).not.toContain("loadAnalyzer");
  });
});
