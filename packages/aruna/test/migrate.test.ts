// `aruna migrate`, through the command module the CLI calls. The codemods'
// own cases (rewrites, idempotency, diff snapshots) are fixture tests in
// crates/aruna_migrate.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrateCommand } from "../src/cli/migrate.js";

const SOURCE = `export function failed(error: { name: string }): boolean {
  return error.name === "SchemaValidationError";
}
export const STORED = "SchemaValidationError";
`;

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
  roots = [];
});

async function project(): Promise<{ root: string; file: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-migrate-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "tsconfig.json"), "{}\n");
  const file = path.join(root, "src", "client", "errors.ts");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, SOURCE);
  // Generated output is never rewritten.
  const generated = path.join(root, "src", ".aruna", "shared", "stub.ts");
  await fs.mkdir(path.dirname(generated), { recursive: true });
  await fs.writeFile(generated, SOURCE);
  return { root, file };
}

describe("aruna migrate", () => {
  it("lists the codemods", () => {
    const result = runMigrateCommand({
      list: true,
      json: true,
      root: os.tmpdir(),
      colors: { enabled: false },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toContainEqual(
      expect.objectContaining({ name: "action-validation-error-name" }),
    );
  });

  it("prints a unified diff on --dry-run and writes nothing", async () => {
    const { root, file } = await project();
    const result = runMigrateCommand({
      name: "action-validation-error-name",
      dryRun: true,
      root,
      colors: { enabled: false },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--- a/src/client/errors.ts\n+++ b/src/client/errors.ts\n");
    expect(result.stdout).toContain('-  return error.name === "SchemaValidationError";\n');
    expect(result.stdout).toContain('+  return error.name === "ActionValidationError";\n');
    expect(result.stdout).toContain("1 file would change (dry run: nothing written)");
    expect(result.stdout).toContain("src/client/errors.ts:4:23");
    expect(await fs.readFile(file, "utf8")).toBe(SOURCE);
  });

  it("rewrites the files, reports what it left, and is idempotent", async () => {
    const { root, file } = await project();
    const first = runMigrateCommand({
      name: "action-validation-error-name",
      json: true,
      root,
      colors: { enabled: false },
    });
    const report = JSON.parse(first.stdout) as {
      changed: { file: string }[];
      unhandled: { file: string; line: number; column: number }[];
    };
    expect(report.changed.map((change) => change.file)).toEqual(["src/client/errors.ts"]);
    expect(report.unhandled).toEqual([
      expect.objectContaining({ file: "src/client/errors.ts", line: 4, column: 23 }),
    ]);
    expect(await fs.readFile(file, "utf8")).toBe(
      SOURCE.replace('=== "SchemaValidationError"', '=== "ActionValidationError"'),
    );
    expect(await fs.readFile(path.join(root, "src", ".aruna", "shared", "stub.ts"), "utf8")).toBe(
      SOURCE,
    );

    const second = runMigrateCommand({
      name: "action-validation-error-name",
      json: true,
      root,
      colors: { enabled: false },
    });
    expect((JSON.parse(second.stdout) as { changed: unknown[] }).changed).toEqual([]);
  });

  it("fails on an unknown codemod and on a missing name", () => {
    expect(
      runMigrateCommand({ name: "nope", root: os.tmpdir(), colors: { enabled: false } }),
    ).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("unknown codemod"),
    });
    expect(runMigrateCommand({ root: os.tmpdir(), colors: { enabled: false } }).status).toBe(1);
  });
});
