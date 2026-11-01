// `pnpm verify:incremental-build` — the build cache never changes what a build
// produces.
//
// Copies a project (apps/rbxts-harness by default) to a temp dir, builds it
// once, then applies a sequence of edits. After each edit it builds with the
// incremental rbxtsc cache and again with `--no-cache`, and fails unless the
// two `out/` trees are byte-identical. It prints both timings per edit.
//
// Flags: --project <dir> (default apps/rbxts-harness), --keep (keep the copy).
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const projectFlag = argv.indexOf("--project");
const sourceProject = path.resolve(
  projectFlag >= 0 && argv[projectFlag + 1] !== undefined ? argv[projectFlag + 1]! : path.join(repoRoot, "apps", "rbxts-harness"),
);
const keep = argv.includes("--keep");
const aruna = path.join(repoRoot, "packages", "aruna", "bin", "aruna.js");

type Edit = {
  readonly name: string;
  readonly apply: (root: string) => void;
};

function append(file: string, text: string): (root: string) => void {
  return (root) => fs.appendFileSync(path.join(root, file), text);
}

function findSource(root: string, predicate: (relative: string, text: string) => boolean): string {
  const walk = (dir: string): string | undefined => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) continue;
        const found = walk(full);
        if (found !== undefined) return found;
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
        const relative = path.relative(root, full);
        if (predicate(relative, fs.readFileSync(full, "utf8"))) return relative;
      }
    }
    return undefined;
  };
  const found = walk(path.join(root, "src"));
  if (found === undefined) throw new Error("no source file matches the edit");
  return found;
}

function hashTree(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else hashes[path.relative(root, full)] = crypto.createHash("sha1").update(fs.readFileSync(full)).digest("hex");
    }
  };
  if (fs.existsSync(root)) walk(root);
  return hashes;
}

function build(root: string, extra: string[]): number {
  const started = performance.now();
  let stdout: string;
  try {
    stdout = execFileSync("node", [aruna, "build", "--json", ...extra], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
  } catch (error) {
    // A failed build exits 1 with its report on stdout.
    stdout = (error as { stdout?: string }).stdout ?? "{}";
  }
  const result = JSON.parse(stdout) as {
    ok: boolean;
    diagnostics?: ReadonlyArray<{ code: string; severity: string; message: string }>;
    rbxtsc?: { status?: number; stdout?: string; stderr?: string };
  };
  if (!result.ok || result.rbxtsc?.status !== 0) {
    const errors = (result.diagnostics ?? []).filter((diagnostic) => diagnostic.severity === "error");
    throw new Error(
      `build failed:\n${errors.map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`).join("\n")}\n${result.rbxtsc?.stdout ?? ""}${result.rbxtsc?.stderr ?? ""}`,
    );
  }
  return Math.round(performance.now() - started);
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "aruna-incremental-"));
// A project inside this repo keeps its place relative to the root, so a
// tsconfig that extends `../../tsconfig.base.json` still finds it.
const relative = path.relative(repoRoot, sourceProject);
const insideRepo = !relative.startsWith("..") && !path.isAbsolute(relative);
const project = insideRepo ? path.join(workDir, relative) : path.join(workDir, "project");
if (insideRepo) {
  fs.mkdirSync(path.dirname(project), { recursive: true });
  for (const entry of fs.readdirSync(repoRoot)) {
    if (/^tsconfig.*\.json$/.test(entry)) {
      fs.copyFileSync(path.join(repoRoot, entry), path.join(workDir, entry));
    }
  }
}
fs.cpSync(sourceProject, project, {
  recursive: true,
  filter: (source) => !/[\\/](out|include|node_modules)$/.test(source) && !source.includes(`${path.sep}.aruna`),
});
// The project's dependencies, linked rather than copied.
fs.symlinkSync(fs.realpathSync(path.join(sourceProject, "node_modules")), path.join(project, "node_modules"), "dir");

const edits: Edit[] = [
  { name: "body edit in an action module", apply: (root) => append(findSource(root, (file) => file.endsWith("actions.ts")), "\nexport const __verifyBody = 1;\n")(root) },
  { name: "shared module edit", apply: (root) => append(findSource(root, (file) => /shared|model|schema/.test(file)), "\nexport const __verifyShared = 2;\n")(root) },
  {
    name: "new module",
    apply: (root) => fs.writeFileSync(path.join(root, "src", "shared", "__verify-new.ts"), "export const verifyNew = 3;\n"),
  },
  { name: "deleted module", apply: (root) => fs.rmSync(path.join(root, "src", "shared", "__verify-new.ts")) },
  { name: "client edit", apply: (root) => append(findSource(root, (file) => /client/.test(file)), "\nexport const __verifyClient = 4;\n")(root) },
];

let failures = 0;
try {
  fs.mkdirSync(path.join(project, "src", "shared"), { recursive: true });
  console.log(`project: ${sourceProject}`);
  console.log(`cold build: ${build(project, [])}ms`);
  console.log(`no-op rebuild: ${build(project, [])}ms`);
  for (const edit of edits) {
    edit.apply(project);
    const cached = build(project, []);
    const cachedTree = hashTree(path.join(project, "out"));
    const fresh = build(project, ["--no-cache"]);
    const freshTree = hashTree(path.join(project, "out"));
    const differing = [...new Set([...Object.keys(cachedTree), ...Object.keys(freshTree)])].filter(
      (file) => cachedTree[file] !== freshTree[file],
    );
    console.log(`${edit.name}: cached ${cached}ms, fresh ${fresh}ms, ${Object.keys(freshTree).length} files, ${differing.length === 0 ? "identical" : `DIFFERENT: ${differing.join(", ")}`}`);
    if (differing.length > 0) failures += 1;
    // Warm the cache again for the next edit.
    build(project, []);
  }
} finally {
  if (keep) {
    console.log(`kept ${workDir}`);
  } else {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
if (failures > 0) {
  console.error(`${failures} edit(s) built differently with the cache`);
  process.exit(1);
}
console.log("the incremental build produced exactly what a fresh build did");
