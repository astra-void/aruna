import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildProject, inspectProject } from "../src/index.ts";

type Snapshot = {
  diagnostics: unknown;
  manifest: unknown;
  modules: unknown;
  graph: unknown;
  generated?: Array<{ path: string; contents: string }>;
};

const fixtureCases = [
  { name: "valid-client-imports-shared", mode: "inspect" },
  { name: "invalid-client-imports-server", mode: "inspect" },
  { name: "invalid-server-imports-client", mode: "inspect" },
  { name: "invalid-shared-imports-client", mode: "inspect" },
  { name: "invalid-shared-imports-server", mode: "inspect" },
  { name: "feature-local-layout", mode: "inspect" },
  { name: "unknown-module-kind", mode: "inspect" },
  { name: "unresolved-import", mode: "inspect" },
  { name: "missing-tsconfig", mode: "inspect" },
  { name: "invalid-config", mode: "inspect" },
  { name: "invalid-tsconfig", mode: "inspect" },
  { name: "tsconfig-path-alias", mode: "inspect" },
  { name: "ambiguous-convention-match", mode: "inspect" },
  { name: "parse-failed", mode: "inspect" },
  { name: "action-basic", mode: "inspect" },
  { name: "duplicate-action-id", mode: "inspect" },
  { name: "action-missing-run", mode: "inspect" },
  { name: "client-imports-action-source", mode: "inspect" },
  { name: "action-generated-output", mode: "build" },
] as const;

const fixturesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures",
);

async function readSnapshot(fixtureName: string): Promise<Snapshot> {
  const expectedRoot = path.join(fixturesRoot, fixtureName, "expected");
  const [diagnostics, manifest, modules, graph, generated] = await Promise.all([
    fs.readFile(path.join(expectedRoot, "diagnostics.json"), "utf8"),
    fs.readFile(path.join(expectedRoot, "manifest.json"), "utf8"),
    fs.readFile(path.join(expectedRoot, "modules.json"), "utf8"),
    fs.readFile(path.join(expectedRoot, "graph.json"), "utf8"),
    fs
      .stat(path.join(expectedRoot, "generated"))
      .then(() => readGeneratedSnapshot(path.join(expectedRoot, "generated")))
      .catch(() => undefined),
  ]);

  return {
    diagnostics: JSON.parse(diagnostics),
    manifest: JSON.parse(manifest),
    modules: JSON.parse(modules),
    graph: JSON.parse(graph),
    generated,
  };
}

async function readGeneratedSnapshot(generatedRoot: string): Promise<Array<{ path: string; contents: string }>> {
  const entries: Array<{ path: string; contents: string }> = [];

  async function walk(directory: string): Promise<void> {
    const children = await fs.readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const childPath = path.join(directory, child.name);
      if (child.isDirectory()) {
        await walk(childPath);
      } else if (child.isFile()) {
        entries.push({
          path: path.relative(generatedRoot, childPath).split(path.sep).join("/"),
          contents: await fs.readFile(childPath, "utf8"),
        });
      }
    }
  }

  await walk(generatedRoot);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

async function copyFixtureInput(sourceRoot: string): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-fixture-"));
  await fs.cp(sourceRoot, tempRoot, { recursive: true });
  return tempRoot;
}

describe.each(fixtureCases)("$name", ({ name, mode }) => {
  it("matches the stored snapshots", async () => {
    const inputRoot = path.join(fixturesRoot, name, "input");
    const snapshot = await readSnapshot(name);

    if (mode === "build") {
      const tempRoot = await copyFixtureInput(inputRoot);
      const output = await buildProject({ root: tempRoot });

      expect(output.diagnostics).toEqual(snapshot.diagnostics);
      expect(output.manifest).toEqual(snapshot.manifest);
      expect(output.manifest.modules).toEqual(snapshot.modules);
      expect(output.manifest.imports).toEqual(snapshot.graph);
      expect(output.generatedFiles).toEqual(snapshot.generated);
      expect(
        (await readGeneratedSnapshot(path.join(tempRoot, "src/.aruna"))).map((entry) => ({
          ...entry,
          path: path.posix.join("src/.aruna", entry.path),
        })),
      ).toEqual(snapshot.generated);
    } else {
      const output = await inspectProject({ root: inputRoot });
      expect(output.diagnostics).toEqual(snapshot.diagnostics);
      expect(output.manifest).toEqual(snapshot.manifest);
      expect(output.manifest.modules).toEqual(snapshot.modules);
      expect(output.manifest.imports).toEqual(snapshot.graph);
      expect(output.generatedFiles).toBeUndefined();
    }
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
