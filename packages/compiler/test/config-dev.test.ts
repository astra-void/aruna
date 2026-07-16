import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectConfig, normalizeDevConfig } from "../src/config.js";

describe("normalizeDevConfig", () => {
  it("defaults to rojo enabled with no port", () => {
    expect(normalizeDevConfig(undefined)).toEqual({ rojo: true, rojoPort: undefined });
    expect(normalizeDevConfig({})).toEqual({ rojo: true, rojoPort: undefined });
  });

  it("keeps an explicit true and an explicit false", () => {
    expect(normalizeDevConfig({ rojo: true })).toEqual({ rojo: true, rojoPort: undefined });
    expect(normalizeDevConfig({ rojo: false })).toEqual({ rojo: false, rojoPort: undefined });
  });

  it("treats { port } as enabled with that port", () => {
    expect(normalizeDevConfig({ rojo: { port: 34873 } })).toEqual({
      rojo: true,
      rojoPort: 34873,
    });
    expect(normalizeDevConfig({ rojo: {} })).toEqual({ rojo: true, rojoPort: undefined });
  });
});

describe("loadProjectConfig dev section", () => {
  const tempDirs: string[] = [];

  function projectWithConfig(configSource: string | undefined): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aruna-config-dev-"));
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

  it("defaults dev to rojo enabled when the config has no dev section", () => {
    const root = projectWithConfig("export default { root: 'src' };\n");
    const loaded = loadProjectConfig(root);
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.dev).toEqual({ rojo: true, rojoPort: undefined });
  });

  it("parses dev.rojo booleans and port objects", () => {
    const disabled = loadProjectConfig(
      projectWithConfig("export default { dev: { rojo: false } };\n"),
    );
    expect(disabled.diagnostics).toEqual([]);
    expect(disabled.dev).toEqual({ rojo: false, rojoPort: undefined });

    const withPort = loadProjectConfig(
      projectWithConfig("export default { dev: { rojo: { port: 40000 } } };\n"),
    );
    expect(withPort.diagnostics).toEqual([]);
    expect(withPort.dev).toEqual({ rojo: true, rojoPort: 40000 });
  });

  it("rejects malformed dev sections with an aruna::100 diagnostic", () => {
    for (const source of [
      "export default { dev: { rojo: 'yes' } };\n",
      "export default { dev: { rojo: { port: -1 } } };\n",
      "export default { dev: { serve: true } };\n",
    ]) {
      const loaded = loadProjectConfig(projectWithConfig(source));
      expect(loaded.diagnostics.map((diagnostic) => diagnostic.code)).toContain("aruna::100");
    }
  });

  it("does not leak dev into the compiler contract", () => {
    const root = projectWithConfig("export default { dev: { rojo: false } };\n");
    const loaded = loadProjectConfig(root);
    expect("dev" in loaded.config).toBe(false);
  });
});
