import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildFixtureCases } from "./fixture-cases.js";

const fixturesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures",
);

async function readGeneratedSnapshot(generatedRoot: string): Promise<Array<{ path: string }>> {
  const entries: Array<{ path: string }> = [];

  async function walk(directory: string): Promise<void> {
    const children = await fs.readdir(directory, { withFileTypes: true });

    for (const child of children) {
      const childPath = path.join(directory, child.name);

      if (child.isDirectory()) {
        await walk(childPath);
        continue;
      }

      if (child.isFile()) {
        entries.push({
          path: path.relative(generatedRoot, childPath).split(path.sep).join("/"),
        });
      }
    }
  }

  await walk(generatedRoot);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

describe.each(buildFixtureCases)("$name generated snapshots", ({ name }) => {
  it("keeps expected/generated populated", async () => {
    const generatedRoot = path.join(fixturesRoot, name, "expected", "generated");
    const stat = await fs.stat(generatedRoot).catch(() => undefined);

    expect(stat, `Build fixture "${name}" is missing expected/generated snapshots.`).toBeDefined();

    const generated = await readGeneratedSnapshot(generatedRoot);
    const generatedPaths = generated.map((entry) => entry.path);

    expect(
      generatedPaths,
      `Build fixture "${name}" is missing the client generated snapshot.`,
    ).toContain("src/.aruna/actions.client.generated.ts");
    expect(
      generatedPaths,
      `Build fixture "${name}" is missing the server generated snapshot.`,
    ).toContain("src/.aruna/actions.server.generated.ts");
  });
});
