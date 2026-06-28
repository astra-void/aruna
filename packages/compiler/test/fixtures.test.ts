import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixtureCases, type FixtureCase } from "./fixture-cases.js";
import { buildProject, inspectProject } from "../src/index.ts";

type Snapshot = {
  diagnostics: unknown;
  manifest: unknown;
  modules: unknown;
  graph: unknown;
  generated?: Array<{ path: string; contents: string }>;
};

const fixturesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures",
);

async function readSnapshot(fixtureName: string, mode: FixtureCase["mode"]): Promise<Snapshot> {
  const expectedRoot = path.join(fixturesRoot, fixtureName, "expected");
  const generatedRoot = path.join(expectedRoot, "generated");
  const [diagnostics, manifest, modules, graph] = await Promise.all([
    fs.readFile(path.join(expectedRoot, "diagnostics.json"), "utf8"),
    fs.readFile(path.join(expectedRoot, "manifest.json"), "utf8"),
    fs.readFile(path.join(expectedRoot, "modules.json"), "utf8"),
    fs.readFile(path.join(expectedRoot, "graph.json"), "utf8"),
  ]);

  let generated: Array<{ path: string; contents: string }> | undefined;
  if (mode === "build") {
    try {
      await fs.stat(generatedRoot);
      generated = await readGeneratedSnapshot(generatedRoot);
    } catch {
      throw new Error(`Build fixture "${fixtureName}" is missing expected/generated snapshots.`);
    }
  } else {
    generated = await fs
      .stat(generatedRoot)
      .then(() => readGeneratedSnapshot(generatedRoot))
      .catch(() => undefined);
  }

  return {
    diagnostics: JSON.parse(diagnostics),
    manifest: JSON.parse(manifest),
    modules: JSON.parse(modules),
    graph: JSON.parse(graph),
    generated,
  };
}

async function readGeneratedSnapshot(
  generatedRoot: string,
): Promise<Array<{ path: string; contents: string }>> {
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
    const snapshot = await readSnapshot(name, mode);

    if (mode === "build") {
      const tempRoot = await copyFixtureInput(inputRoot);
      const output = await buildProject({ root: tempRoot });

      expect(output.diagnostics).toEqual(snapshot.diagnostics);
      expect(output.manifest).toEqual(snapshot.manifest);
      expect(output.manifest.modules).toEqual(snapshot.modules);
      expect(output.manifest.imports).toEqual(snapshot.graph);
      // `snapshot.generated` is sorted by path (readGeneratedSnapshot), whereas
      // `output.generatedFiles` is in codegen emission order. Compare as sets by
      // sorting both — the split-tree layout makes emission order and path order
      // diverge (e.g. shared/ stubs emit before the manifest at the base).
      const sortByPath = <T extends { path: string }>(files: readonly T[]): T[] =>
        [...files].sort((left, right) => left.path.localeCompare(right.path));
      expect(sortByPath(output.generatedFiles ?? [])).toEqual(snapshot.generated);
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
