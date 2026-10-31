// Orchestrates the roblox-ts-native runtime execution tests:
//   1. build a throwaway rbxts project in a temp directory: packages/aruna/roblox
//      staged where a consumer's vendored runtime lives
//      (src/shared/aruna/runtime), and the TypeScript specs from src/test
//   2. compile it to Luau with rbxtsc
//   3. execute under Lune: the Luau specs in lune/specs against the compiled
//      runtime, then the TypeScript specs through the runner `aruna test` ships
//      (packages/aruna/lune), the same way a game project's specs run
//
// Every run builds in its own directory, so runs never collide and nothing is
// written into this package.
//
// Flags:
//   --keep            keep the temp project and print its path
//   --spec <text>     only stage TypeScript specs whose file name contains <text>
//                     (repeatable); the Luau specs still run unless --ts-only
//   --ts-only         skip the Luau specs
//
// Lune is optional locally: without it the runtime and specs are still compiled
// (proving they build) and execution is skipped with a loud notice. Under CI
// (`CI` set) a missing Lune fails the run — the runtime's behavioral coverage
// lives here, so a skip there would report a pass for tests that never ran.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, "..");
const repoRoot = resolve(packageDir, "..", "..");

const runtimeSource = join(repoRoot, "packages", "aruna", "roblox");
const specSource = join(packageDir, "src", "test");
// The directory name stands in for a consumer's generatedDir: the shipped runner
// finds `aruna/testing` at ReplicatedStorage.TS.<generatedDir>.runtime.testing.
const GENERATED_DIR = "aruna";
const RUNTIME_SUBPATHS = ["server", "client", "roblox", "schema", "testing"] as const;
// Spawn rbxtsc's entry point with the running Node rather than the `.bin` shim:
// on Windows the extensionless shim is a shell script (ENOENT) and its `.cmd`
// sibling cannot be spawned without a shell (EINVAL since Node 20.12).
const rbxtscEntry = join(
  dirname(createRequire(import.meta.url).resolve("roblox-ts/package.json")),
  "out",
  "CLI",
  "cli.js",
);
const promisePath = join(packageDir, "node_modules", "roblox-ts", "include", "Promise.lua");
const runScript = join(packageDir, "lune", "run.luau");
const specRunScript = join(repoRoot, "packages", "aruna", "lune", "run.luau");
const conformanceTable = join(packageDir, "conformance", "dispatch.json");

const argv = process.argv.slice(2);
const keepArtifacts = argv.includes("--keep");
const tsOnly = argv.includes("--ts-only");
const specFilters: string[] = [];
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--spec" && argv[index + 1] !== undefined) {
    specFilters.push(argv[index + 1]);
    index += 1;
  }
}
const requireLune =
  process.env.CI !== undefined && process.env.CI !== "" && process.env.CI !== "false";

const workDir = mkdtempSync(join(tmpdir(), "aruna-runtime-test-"));
const stagedRuntime = join(workDir, "src", "shared", GENERATED_DIR, "runtime");
const stagedSpecs = join(workDir, "src", "test");
const outRoot = join(workDir, "out");
const compiledRuntime = join(outRoot, "shared", GENERATED_DIR, "runtime");
const includeRoot = join(workDir, "include");

function cleanUp(): void {
  if (keepArtifacts) {
    console.log(`\n(kept the temp project at ${workDir})`);
  } else {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function fail(message: string): never {
  cleanUp();
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function step(message: string): void {
  console.log(`• ${message}`);
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function toPosix(value: string): string {
  return value.split("\\").join("/");
}

// 1. Build the throwaway project.
step("Staging the native runtime and specs");
mkdirSync(stagedRuntime, { recursive: true });
for (const entry of readdirSync(runtimeSource)) {
  if (entry.endsWith(".ts")) {
    cpSync(join(runtimeSource, entry), join(stagedRuntime, entry));
  }
}
mkdirSync(stagedSpecs, { recursive: true });
let stagedSpecCount = 0;
if (existsSync(specSource)) {
  for (const entry of readdirSync(specSource)) {
    if (!entry.endsWith(".ts")) {
      continue;
    }
    const isSpec = entry.endsWith(".spec.ts");
    if (isSpec && specFilters.length > 0 && !specFilters.some((filter) => entry.includes(filter))) {
      continue;
    }
    cpSync(join(specSource, entry), join(stagedSpecs, entry));
    if (isSpec) {
      stagedSpecCount += 1;
    }
  }
}
if (specFilters.length > 0 && stagedSpecCount === 0) {
  fail(`no TypeScript spec matches ${specFilters.map((filter) => `"${filter}"`).join(", ")}`);
}
// rbxtsc resolves @rbxts packages through node_modules, and the Rojo tree below
// mounts them; a link avoids copying the whole directory per run.
symlinkSync(
  join(packageDir, "node_modules"),
  join(workDir, "node_modules"),
  process.platform === "win32" ? "junction" : "dir",
);

// rbxtsc refuses a project without one.
writeJson(join(workDir, "package.json"), { name: "aruna-runtime-test-project", private: true });

// "./"-relative, as TypeScript requires of path targets without a baseUrl.
const paths: Record<string, string[]> = {};
for (const subpath of RUNTIME_SUBPATHS) {
  paths[`aruna/${subpath}`] = [
    `./${toPosix(relative(workDir, join(stagedRuntime, `${subpath}.ts`)))}`,
  ];
}
paths["aruna/internal/*"] = [`./${toPosix(relative(workDir, stagedRuntime))}/*`];
writeJson(join(workDir, "tsconfig.json"), {
  extends: toPosix(join(repoRoot, "tsconfig.base.json")),
  compilerOptions: {
    module: "CommonJS",
    moduleDetection: "force",
    moduleResolution: "Node",
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    noLib: true,
    outDir: "out",
    rootDir: "src",
    jsx: "preserve",
    verbatimModuleSyntax: false,
    typeRoots: ["./node_modules", "./node_modules/@rbxts"],
    types: ["@rbxts/types", "@rbxts/compiler-types"],
    paths,
  },
  include: ["src/**/*.ts"],
});
// The same mounts `aruna test` compiles a project against: shared code under
// ReplicatedStorage.TS, specs under ServerScriptService.ArunaTests.
writeJson(join(workDir, "default.project.json"), {
  name: "aruna-roblox-runtime-test",
  globIgnorePaths: ["**/package.json", "**/tsconfig.json"],
  tree: {
    $className: "DataModel",
    ReplicatedStorage: {
      $className: "ReplicatedStorage",
      rbxts_include: {
        $path: "include",
        node_modules: {
          $className: "Folder",
          "@rbxts": { $path: "node_modules/@rbxts" },
        },
      },
      TS: { $path: "out/shared" },
    },
    ServerScriptService: {
      $className: "ServerScriptService",
      ArunaTests: { $path: "out/test" },
    },
  },
});

// 2. Compile to Luau.
step("Compiling the runtime and specs to Luau with rbxtsc");
const compile = spawnSync(process.execPath, [rbxtscEntry, "--project", "tsconfig.json"], {
  cwd: workDir,
  stdio: "inherit",
});
if (compile.status !== 0) {
  fail("rbxtsc failed to compile the native runtime or its specs");
}
if (!existsSync(join(compiledRuntime, "server-runtime.luau"))) {
  fail("expected compiled runtime output is missing");
}

// 3. Run the compiled runtime under Lune.
// Lune runs from this package, not the temp project: rokit resolves the pinned
// version from the repo's rokit.toml, which the temp directory is outside of.
const luneProbe = spawnSync("lune", ["--version"], { cwd: packageDir, stdio: "ignore" });
if (luneProbe.status !== 0) {
  if (requireLune) {
    fail("Lune is not installed, and CI requires the runtime execution tests to run");
  }
  cleanUp();
  console.log(
    "\n⚠ Lune not found — compiled the runtime but SKIPPED every execution test.\n" +
      "  Nothing about runtime behavior was checked. Install it with `rokit install`\n" +
      "  (see rokit.toml) to run the suite.",
  );
  process.exit(0);
}

let luauStatus: number | null = 0;
if (!tsOnly) {
  step("Executing the Luau specs under Lune");
  luauStatus = spawnSync(
    "lune",
    ["run", runScript, compiledRuntime, promisePath, conformanceTable],
    { cwd: packageDir, stdio: "inherit" },
  ).status;
}

step("Executing the TypeScript specs under Lune (the `aruna test` runner)");
// One Lune process per spec file, each over an out/ tree holding only that spec
// and the shared helpers. Specs stay isolated from each other's leftover state,
// and no single run grows the call stack past what Luau allows: the runner's
// `runTests` chains every case onto one promise, and a long stretch of
// synchronous cases nests deeper with each one (a follow-up; see
// docs/runtime-consolidation.md).
const compiledSpecs = join(outRoot, "test");
const specModules = readdirSync(compiledSpecs).filter((entry) => entry.endsWith(".spec.luau"));
const helperModules = readdirSync(compiledSpecs).filter(
  (entry) => entry.endsWith(".luau") && !entry.endsWith(".spec.luau"),
);
const failedSpecs: string[] = [];
let specStatus: number | null = 0;
for (const spec of specModules.sort()) {
  const specOut = join(workDir, "spec-runs", spec.replace(/\.luau$/, ""));
  mkdirSync(join(specOut, "test"), { recursive: true });
  cpSync(join(outRoot, "shared"), join(specOut, "shared"), { recursive: true });
  for (const entry of [spec, ...helperModules]) {
    cpSync(join(compiledSpecs, entry), join(specOut, "test", entry));
  }
  console.log(`\n${spec.replace(/\.luau$/, "")}`);
  // No `--` separator: Lune hands it to the script verbatim and shifts every
  // argument by one.
  const status = spawnSync(
    "lune",
    ["run", specRunScript, specOut, includeRoot, GENERATED_DIR, join(workDir, "node_modules")],
    { cwd: packageDir, stdio: "inherit" },
  ).status;
  if (status !== 0) {
    failedSpecs.push(spec);
    specStatus = status;
  }
}
if (failedSpecs.length > 0) {
  console.error(`\nFailed spec files: ${failedSpecs.join(", ")}`);
}

if (luauStatus !== 0) {
  fail("Luau runtime specs failed");
}
if (specStatus !== 0) {
  fail("TypeScript runtime specs failed");
}
cleanUp();
console.log("\n✓ Native runtime execution tests passed");
