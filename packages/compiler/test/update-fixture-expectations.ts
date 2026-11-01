// Rewrites fixtures/<name>/expected/*.json from the current compiler, for the
// fixtures whose output changed on purpose. Only files whose content changed
// are written, with keys sorted the way the committed files keep them, so a
// diff shows the change and nothing else.
//
//   pnpm --filter @arunajs/compiler exec tsx test/update-fixture-expectations.ts <fixture>...
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import os from "node:os";
import { fixtureCases } from "./fixture-cases.js";
import { buildProject, inspectProject } from "../src/index.ts";

const fixturesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

async function writeIfChanged(target: string, contents: string): Promise<void> {
  const current = await fs.readFile(target, "utf8").catch(() => undefined);
  if (current === contents) {
    return;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
  console.log(`updated ${path.relative(fixturesRoot, target)}`);
}

for (const name of process.argv.slice(2)) {
  const mode = fixtureCases.find((fixture) => fixture.name === name)?.mode ?? "inspect";
  const inputRoot = path.join(fixturesRoot, name, "input");
  let output;
  if (mode === "build") {
    // A build writes into the project, so it runs on a copy, as the test does.
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-fixture-update-"));
    await fs.cp(inputRoot, tempRoot, { recursive: true });
    output = await buildProject({ root: tempRoot });
    for (const file of output.generatedFiles ?? []) {
      await writeIfChanged(path.join(fixturesRoot, name, "expected", "generated", file.path), file.contents);
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  } else {
    output = await inspectProject({ root: inputRoot });
  }
  const expected: Record<string, unknown> = {
    "diagnostics.json": output.diagnostics,
    "manifest.json": output.manifest,
    "modules.json": output.manifest.modules,
    "graph.json": output.manifest.imports,
  };
  for (const [file, value] of Object.entries(expected)) {
    const target = path.join(fixturesRoot, name, "expected", file);
    const current = JSON.parse(await fs.readFile(target, "utf8"));
    if (isDeepStrictEqual(current, JSON.parse(JSON.stringify(value)))) {
      continue;
    }
    await fs.writeFile(target, `${JSON.stringify(sortKeys(value), null, 2)}\n`);
    console.log(`updated ${name}/expected/${file}`);
  }
}
