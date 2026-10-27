// The package root is the one entry that runs under Node: config and compiler.
// The runtime's own behavior is covered by the native specs under
// apps/roblox-runtime-test (see src/test/public-exports.spec.ts there).
import { describe, expect, it } from "vitest";
import * as root from "../dist/index.js";

describe("public exports", () => {
  it("returns defineConfig objects unchanged", () => {
    const config = {
      compiler: {
        generatedDir: "src/.aruna",
      },
    } as const;

    expect(root.defineConfig(config)).toBe(config);
  });

  it("exports only config and compiler values from the root", () => {
    expect(Object.keys(root).sort()).toEqual([
      "buildProject",
      "checkProject",
      "defineConfig",
      "inspectProject",
    ]);
  });
});
