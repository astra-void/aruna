import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectConfig } from "../src/config.js";
import { inspectProject } from "../src/index.ts";

const fixturesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

// The domain-to-domain boundary is the one rule aimed at a project's own
// taxonomy rather than at the client/server split, so both halves of its
// contract matter: which directories count as domains, and how loudly a
// violation is reported.
describe("loadProjectConfig domains", () => {
  const tempDirs: string[] = [];

  function projectWithConfig(configSource: string | undefined): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aruna-config-domains-"));
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

  it("defaults to the recommended domain root and a warning severity", () => {
    const loaded = loadProjectConfig(projectWithConfig(undefined));

    expect(loaded.config.domains.roots).toEqual(["src/domains/*"]);
    expect(loaded.config.strict.domainBoundary).toBe("warning");
  });

  it("derives the default domain root from a custom source root", () => {
    const loaded = loadProjectConfig(
      projectWithConfig(
        `import { defineConfig } from "aruna";
export default defineConfig({ root: "game" });
`,
      ),
    );

    expect(loaded.config.domains.roots).toEqual(["game/domains/*"]);
  });

  it("adds project roots to the built-in one instead of replacing it", () => {
    const loaded = loadProjectConfig(
      projectWithConfig(
        `import { defineConfig } from "aruna";
export default defineConfig({
  domains: { roots: ["src/features/*"] },
});
`,
      ),
    );

    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.config.domains.roots).toEqual(["src/domains/*", "src/features/*"]);
  });

  it("rejects a non-string-array roots list", () => {
    const loaded = loadProjectConfig(
      projectWithConfig(
        `import { defineConfig } from "aruna";
export default defineConfig({
  domains: { roots: "src/features/*" },
});
`,
      ),
    );

    expect(loaded.diagnostics[0]?.code).toBe("aruna::100");
    expect(loaded.diagnostics[0]?.details).toContain("domains.roots must be an array of strings");
  });

  it("rejects an unknown severity for the boundary", () => {
    const loaded = loadProjectConfig(
      projectWithConfig(
        `import { defineConfig } from "aruna";
export default defineConfig({
  strict: { domainBoundary: "loud" },
});
`,
      ),
    );

    expect(loaded.diagnostics[0]?.code).toBe("aruna::100");
    expect(loaded.diagnostics[0]?.details).toContain(
      'strict.domainBoundary must be one of "off", "warning", or "error"',
    );
  });
});

describe("domain boundary severity", () => {
  const inputRoot = path.join(fixturesRoot, "cross-domain-private-import", "input");

  it("raises cross-domain imports to errors when configured", async () => {
    const output = await inspectProject({
      root: inputRoot,
      config: { strict: { domainBoundary: "error" } },
    });

    const domainDiagnostics = output.diagnostics.filter(
      (diagnostic) => diagnostic.code === "aruna::304",
    );
    expect(domainDiagnostics).toHaveLength(2);
    expect(domainDiagnostics.every((diagnostic) => diagnostic.severity === "error")).toBe(true);
    expect(output.ok).toBe(false);
  });

  it("stops reporting them when the boundary is turned off", async () => {
    const output = await inspectProject({
      root: inputRoot,
      config: { strict: { domainBoundary: "off" } },
    });

    expect(output.diagnostics).toEqual([]);
    expect(output.ok).toBe(true);
  });
});

// The strict options other than domainBoundary, and the ignore list, through
// the same config path a project uses.
describe("strict options and diagnostics.ignore", () => {
  const rawRemoteRoot = path.join(fixturesRoot, "raw-remote-usage", "input");
  const unresolvedRoot = path.join(fixturesRoot, "unresolved-import", "input");

  it("raises raw remote use to an error when configured", async () => {
    const output = await inspectProject({
      root: rawRemoteRoot,
      config: { strict: { rawRemoteUsage: "error" } },
    });

    expect(output.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "aruna::507",
      "aruna::507",
      "aruna::507",
      "aruna::507",
    ]);
    expect(output.diagnostics.every((diagnostic) => diagnostic.severity === "error")).toBe(true);
    expect(output.ok).toBe(false);
  });

  it("applies strict.unresolvedImports to aruna::105", async () => {
    const asError = await inspectProject({
      root: unresolvedRoot,
      config: { strict: { unresolvedImports: "error" } },
    });
    expect(asError.diagnostics.map((diagnostic) => diagnostic.severity)).toEqual(["error"]);
    expect(asError.ok).toBe(false);

    const off = await inspectProject({
      root: unresolvedRoot,
      config: { strict: { unresolvedImports: "off" } },
    });
    expect(off.diagnostics).toEqual([]);
  });

  it("passes strict.sharedSafety through to the shared-safety checks", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aruna-config-shared-safety-"));
    try {
      fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
      fs.mkdirSync(path.join(dir, "src/shared"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "src/shared/save.ts"),
        'export const store = game.GetService("DataStoreService");\n',
      );

      const on = await inspectProject({ root: dir });
      expect(on.config.strict.sharedSafety).toBe(true);
      expect(on.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["aruna::308"]);
      expect(on.ok).toBe(false);

      const off = await inspectProject({ root: dir, config: { strict: { sharedSafety: false } } });
      expect(off.diagnostics).toEqual([]);
      expect(off.ok).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops diagnostics listed in diagnostics.ignore, by code or by name", async () => {
    const byCode = await inspectProject({
      root: unresolvedRoot,
      config: { diagnostics: { ignore: ["aruna::105"] } },
    });
    expect(byCode.diagnostics).toEqual([]);

    const byName = await inspectProject({
      root: rawRemoteRoot,
      config: { diagnostics: { ignore: ["raw-remote-usage"] } },
    });
    expect(byName.diagnostics).toEqual([]);
  });

  it("rejects a diagnostics.ignore that is not a list of strings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aruna-config-ignore-"));
    try {
      fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
      fs.writeFileSync(
        path.join(dir, "aruna.config.ts"),
        `import { defineConfig } from "aruna";
export default defineConfig({ diagnostics: { ignore: "raw-remote-usage" } });
`,
      );
      const loaded = loadProjectConfig(dir);
      expect(loaded.diagnostics[0]?.code).toBe("aruna::100");
      expect(loaded.diagnostics[0]?.details).toContain(
        "diagnostics.ignore must be an array of strings",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
