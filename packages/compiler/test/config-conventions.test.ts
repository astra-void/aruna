import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectConfig } from "../src/config.js";

// The conventions section is the part of aruna.config.ts real projects touch
// most, and it used to make them restate every built-in glob to add one of
// their own. These cover the extend semantics and its escape hatch.
describe("loadProjectConfig conventions", () => {
  const tempDirs: string[] = [];

  function projectWithConfig(configSource: string | undefined): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aruna-config-conventions-"));
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

  it("classifies signals as shared by default", () => {
    const loaded = loadProjectConfig(projectWithConfig(undefined));
    // Structural, not stylistic: the generated signal registry lives in the
    // shared partition and imports every definition from its declaring file.
    expect(loaded.config.conventions.shared).toContain("**/signals.ts");
  });

  it("adds user globs to the built-in set instead of replacing it", () => {
    const loaded = loadProjectConfig(
      projectWithConfig(
        `import { defineConfig } from "aruna";
export default defineConfig({
  conventions: { shared: ["**/policy.ts"] },
});
`,
      ),
    );

    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.config.conventions.shared).toContain("**/policy.ts");
    // The defaults the project never mentioned survive.
    expect(loaded.config.conventions.shared).toContain("**/schema.ts");
    expect(loaded.config.conventions.shared).toContain("**/model.ts");
    // Kinds the project said nothing about are untouched.
    expect(loaded.config.conventions.server).toContain("**/actions.ts");
    // The project's own globs are also reported on their own, because they
    // outrank the defaults during classification.
    expect(loaded.config.conventionOverrides).toEqual({
      client: [],
      server: [],
      shared: ["**/policy.ts"],
    });
  });

  it("replaces the built-in set when defaults are turned off", () => {
    const loaded = loadProjectConfig(
      projectWithConfig(
        `import { defineConfig } from "aruna";
export default defineConfig({
  conventions: {
    defaults: false,
    client: ["src/ui/**"],
    server: ["src/api/**"],
  },
});
`,
      ),
    );

    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.config.conventions.client).toEqual(["src/ui/**"]);
    expect(loaded.config.conventions.server).toEqual(["src/api/**"]);
    // A kind left out under `defaults: false` means "nothing matches", not
    // "fall back to the defaults I just opted out of".
    expect(loaded.config.conventions.shared).toEqual([]);
  });

  it("does not duplicate a glob the defaults already carry", () => {
    const loaded = loadProjectConfig(
      projectWithConfig(
        `import { defineConfig } from "aruna";
export default defineConfig({
  conventions: { shared: ["**/schema.ts"] },
});
`,
      ),
    );

    expect(loaded.config.conventions.shared.filter((glob) => glob === "**/schema.ts")).toHaveLength(
      1,
    );
  });

  it("rejects a non-boolean defaults flag", () => {
    const loaded = loadProjectConfig(
      projectWithConfig(
        `import { defineConfig } from "aruna";
export default defineConfig({
  conventions: { defaults: "no" },
});
`,
      ),
    );

    expect(loaded.diagnostics[0]?.code).toBe("aruna::100");
    expect(loaded.diagnostics[0]?.details).toContain("conventions.defaults must be a boolean");
  });
});
