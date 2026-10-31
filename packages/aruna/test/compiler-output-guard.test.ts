// Byte-for-byte regression guard over everything the compiler produces.
//
// Every fixture under fixtures/ is copied to a temp directory and run through
// the CLI in-process: each `inspect` subcommand, `check`, `build`, and — where
// the fixture commits a contract snapshot — `contract diff`, all with --json.
// The exact stdout of each command, its exit code, and every file `build`
// writes under the generated dir are concatenated into one golden file per
// fixture (test/__golden__/compiler-output/<fixture>.golden) and compared as
// bytes, not as parsed JSON: key order, number formatting, and whitespace all
// count. Refactoring the compiler must leave every golden untouched.
//
// Regenerate deliberately, after a reviewed output change, with
// ARUNA_UPDATE_GOLDEN=1 pnpm --filter aruna exec vitest run test/compiler-output-guard.test.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli/cli.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(here, "../../../fixtures");
const goldenRoot = path.join(here, "__golden__", "compiler-output");
const update = process.env.ARUNA_UPDATE_GOLDEN === "1";

const INSPECT_COMMANDS = ["actions", "signals", "stores", "contract", "modules", "graph"] as const;

type CommandRun = { readonly stdout: string; readonly stderr: string; readonly exitCode: number };

// Runs the CLI in-process with stdout/stderr captured. In-process rather than a
// child per command: 40 fixtures × 9 commands of Node startup would make the
// guard too slow to keep.
async function runCli(args: readonly string[]): Promise<CommandRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalArgv = process.argv;
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  process.argv = ["node", "aruna", ...args];
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    const exitCode = await main();
    return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode };
  } finally {
    process.argv = originalArgv;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    process.exitCode = undefined;
  }
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }
  await walk(root);
  return files.sort();
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(
    () => true,
    () => false,
  );
}

let tempRoot: string;

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-output-guard-"));
});

afterAll(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

// Every spelling of the temp project path a command can print — absolute,
// symlink-resolved (macOS /var → /private/var), and relative to the cwd, each
// also as --json escapes it — becomes `<root>`, so the golden does not depend on
// where the run happened.
function normalizer(root: string, realRoot: string): (text: string) => string {
  const spellings = [
    realRoot,
    root,
    path.relative(process.cwd(), realRoot),
    path.relative(process.cwd(), root),
  ]
    .filter((spelling) => spelling.length > 0)
    .flatMap((spelling) => [spelling, spelling.split(path.sep).join("/")])
    // --json doubles a Windows path's backslashes.
    .flatMap((spelling) => [spelling, JSON.stringify(spelling).slice(1, -1)])
    .sort((left, right) => right.length - left.length);
  return (text) => {
    let normalized = text;
    for (const spelling of spellings) {
      normalized = normalized.split(spelling).join("<root>");
    }
    if (path.sep === "\\") {
      // Below the root a Windows path keeps its own separators, which --json
      // escapes (the compiler prints `<root>\\src/.aruna/manifest.json`). Write
      // them as "/", as every other platform prints them.
      normalized = normalized.replace(/<root>[^\s"]*/g, (match) => match.split("\\\\").join("/"));
    }
    return normalized;
  };
}

async function captureFixture(fixture: string): Promise<string> {
  const root = path.join(tempRoot, fixture);
  await fs.cp(path.join(fixturesRoot, fixture, "input"), root, { recursive: true });
  const realRoot = await fs.realpath(root);
  const normalize = normalizer(root, realRoot);
  const sections: string[] = [];

  const record = (label: string, run: CommandRun) => {
    sections.push(`=== ${label} (exit ${run.exitCode})\n${normalize(run.stdout)}`);
  };

  for (const command of INSPECT_COMMANDS) {
    record(`inspect ${command}`, await runCli(["inspect", command, "--json", "--project", root]));
  }
  record("check", await runCli(["check", "--json", "--project", root]));
  if (await exists(path.join(root, "aruna.contract.json"))) {
    record(
      "contract diff",
      await runCli([
        "contract",
        "diff",
        "--json",
        "--project",
        root,
        "--baseline",
        path.join(root, "aruna.contract.json"),
      ]),
    );
  }

  const before = new Set(await listFiles(root));
  record(
    "build",
    await runCli(["build", "--json", "--no-emit-luau", "--no-emit-runtime", "--project", root]),
  );
  for (const file of await listFiles(root)) {
    if (before.has(file)) {
      continue;
    }
    const relative = path.relative(root, file).split(path.sep).join("/");
    sections.push(`=== file ${relative}\n${normalize(await fs.readFile(file, "utf8"))}`);
  }

  return `${sections.join("\n")}\n`;
}

const fixtures = (await fs.readdir(fixturesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("compiler output guard", () => {
  it("covers every fixture", () => {
    expect(fixtures.length).toBeGreaterThan(30);
  });

  for (const fixture of fixtures) {
    it(`reproduces ${fixture} byte for byte`, async () => {
      const actual = await captureFixture(fixture);
      const goldenPath = path.join(goldenRoot, `${fixture}.golden`);
      if (update) {
        await fs.mkdir(goldenRoot, { recursive: true });
        await fs.writeFile(goldenPath, actual);
        return;
      }
      const expected = await fs.readFile(goldenPath, "utf8").catch(() => {
        throw new Error(
          `Missing golden ${path.relative(process.cwd(), goldenPath)}; run with ARUNA_UPDATE_GOLDEN=1 to create it.`,
        );
      });
      // Compared as strings, so a key-order or whitespace change fails here.
      expect(actual === expected, `${fixture} output changed`).toBe(true);
      expect(actual).toBe(expected);
    });
  }
});
