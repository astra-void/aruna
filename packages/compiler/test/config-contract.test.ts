import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectConfig } from "../src/config.js";

// The store compatibility gate reads two settings: where the committed contract
// snapshot lives, and how loudly an incompatible store change is reported. The
// comparison itself runs in the CLI; the loader only has to carry them, with
// the gate's defaults.
describe("loadProjectConfig contract gate", () => {
  const tempDirs: string[] = [];

  function projectWithConfig(configSource: string | undefined): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aruna-config-contract-"));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
    if (configSource !== undefined) {
      fs.writeFileSync(path.join(dir, "aruna.config.ts"), configSource);
    }
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to aruna.contract.json and an error severity", () => {
    const loaded = loadProjectConfig(projectWithConfig(undefined));

    expect(loaded.config.contract.snapshot).toBe("aruna.contract.json");
    expect(loaded.config.strict.storeCompatibility).toBe("error");
  });

  it("reads a custom snapshot path and severity", () => {
    const loaded = loadProjectConfig(
      projectWithConfig(
        `import { defineConfig } from "aruna";
export default defineConfig({
  contract: { snapshot: "contracts/shipped.json" },
  strict: { storeCompatibility: "warning" },
});
`,
      ),
    );

    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.config.contract.snapshot).toBe("contracts/shipped.json");
    expect(loaded.config.strict.storeCompatibility).toBe("warning");
  });

  it("rejects an empty snapshot path, an unknown field, and an unknown severity", () => {
    const loaded = loadProjectConfig(
      projectWithConfig(
        `import { defineConfig } from "aruna";
export default defineConfig({
  contract: { snapshot: "", baseline: "x" },
  strict: { storeCompatibility: "loud" },
});
`,
      ),
    );

    expect(loaded.diagnostics[0]?.code).toBe("aruna::100");
    const details = loaded.diagnostics[0]?.details ?? "";
    expect(details).toContain("contract.snapshot must be a non-empty string");
    expect(details).toContain("Unsupported contract.baseline field.");
    expect(details).toContain(
      'strict.storeCompatibility must be one of "off", "warning", or "error"',
    );
  });
});
