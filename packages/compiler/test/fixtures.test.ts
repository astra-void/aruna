import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inspectProject } from "../src/index.ts";

type Snapshot = {
  diagnostics: unknown;
  manifest: unknown;
  modules: unknown;
  graph: unknown;
};

const fixtureNames = [
  "valid-client-imports-shared",
  "invalid-client-imports-server",
  "invalid-server-imports-client",
  "invalid-shared-imports-client",
  "invalid-shared-imports-server",
  "feature-local-layout",
  "unknown-module-kind",
  "unresolved-import",
  "missing-tsconfig",
  "invalid-config",
  "invalid-tsconfig",
  "tsconfig-path-alias",
  "ambiguous-convention-match",
  "parse-failed",
] as const;

const fixturesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures",
);

async function readSnapshot(fixtureName: string): Promise<Snapshot> {
  const expectedRoot = path.join(fixturesRoot, fixtureName, "expected");
  const [diagnostics, manifest, modules, graph] = await Promise.all([
    fs.readFile(path.join(expectedRoot, "diagnostics.json"), "utf8"),
    fs.readFile(path.join(expectedRoot, "manifest.json"), "utf8"),
    fs.readFile(path.join(expectedRoot, "modules.json"), "utf8"),
    fs.readFile(path.join(expectedRoot, "graph.json"), "utf8"),
  ]);

  return {
    diagnostics: JSON.parse(diagnostics),
    manifest: JSON.parse(manifest),
    modules: JSON.parse(modules),
    graph: JSON.parse(graph),
  };
}

describe.each(fixtureNames)("%s", (fixtureName) => {
  it("matches the stored snapshots", async () => {
    const inputRoot = path.join(fixturesRoot, fixtureName, "input");
    const snapshot = await readSnapshot(fixtureName);
    const output = await inspectProject({ root: inputRoot });

    expect(output.diagnostics).toEqual(snapshot.diagnostics);
    expect(output.manifest).toEqual(snapshot.manifest);
    expect(output.manifest.modules).toEqual(snapshot.modules);
    expect(output.manifest.imports).toEqual(snapshot.graph);
  });
});

describe("config diagnostics", () => {
  it("treats warnings as errors in the summary", async () => {
    const inputRoot = path.join(fixturesRoot, "missing-tsconfig", "input");
    const output = await inspectProject({ root: inputRoot, warningsAsErrors: true });

    expect(output.diagnostics).toHaveLength(1);
    expect(output.diagnostics[0]?.code).toBe("aruna::102");
    expect(output.diagnostics[0]?.severity).toBe("warning");
    expect(output.summary.errors).toBe(1);
    expect(output.summary.warnings).toBe(0);
    expect(output.ok).toBe(false);
  });

  it("reports malformed tsconfig files with aruna::103", async () => {
    const inputRoot = path.join(fixturesRoot, "invalid-tsconfig", "input");
    const output = await inspectProject({ root: inputRoot });

    expect(output.diagnostics).toHaveLength(1);
    expect(output.diagnostics[0]?.code).toBe("aruna::103");
    expect(output.diagnostics[0]?.name).toBe("invalid-tsconfig");
    expect(output.diagnostics[0]?.severity).toBe("error");
    expect(output.diagnostics.some((diagnostic) => diagnostic.code === "aruna::900")).toBe(false);
    expect(output.summary.errors).toBe(1);
    expect(output.ok).toBe(false);
  });
});
