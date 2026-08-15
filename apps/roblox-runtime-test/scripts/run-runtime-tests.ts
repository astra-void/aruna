// Orchestrates the roblox-ts-native runtime execution tests:
//   1. copy packages/aruna/roblox/*.ts into src/runtime
//   2. compile to Luau with rbxtsc
//   3. execute the compiled runtime under Lune against the spec suite
//
// Lune is optional: when it is not installed the runtime is still compiled
// (proving it builds) and the execution step is skipped with a clear notice so
// CI without the Roblox toolchain stays green.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, "..");
const repoRoot = resolve(packageDir, "..", "..");

const runtimeSource = join(repoRoot, "packages", "aruna", "roblox");
const compiledSource = join(packageDir, "src", "runtime");
const compiledOutput = join(packageDir, "out", "runtime");
const promisePath = join(packageDir, "node_modules", "roblox-ts", "include", "Promise.lua");
// Spawn rbxtsc's entry point with the running Node rather than the `.bin` shim:
// on Windows the extensionless shim is a shell script (ENOENT) and its `.cmd`
// sibling cannot be spawned without a shell (EINVAL since Node 20.12).
const rbxtscEntry = join(
  dirname(createRequire(import.meta.url).resolve("roblox-ts/package.json")),
  "out",
  "CLI",
  "cli.js",
);
const runScript = join(packageDir, "lune", "run.luau");

const keepArtifacts = process.argv.includes("--keep");

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function step(message: string): void {
  console.log(`• ${message}`);
}

// 1. Stage the runtime source as the rbxts project input.
step("Staging native runtime sources");
rmSync(compiledSource, { recursive: true, force: true });
rmSync(join(packageDir, "out"), { recursive: true, force: true });
mkdirSync(compiledSource, { recursive: true });
for (const entry of readdirSync(runtimeSource)) {
  if (entry.endsWith(".ts")) {
    cpSync(join(runtimeSource, entry), join(compiledSource, entry));
  }
}

// 2. Compile to Luau.
step("Compiling runtime to Luau with rbxtsc");
const compile = spawnSync(process.execPath, [rbxtscEntry, "--project", "tsconfig.json"], {
  cwd: packageDir,
  stdio: "inherit",
});
if (compile.status !== 0) {
  fail("rbxtsc failed to compile the native runtime");
}
if (!existsSync(join(compiledOutput, "server-runtime.luau"))) {
  fail("expected compiled runtime output is missing");
}

// 3. Run the compiled runtime under Lune (optional).
const luneProbe = spawnSync("lune", ["--version"], { cwd: packageDir, stdio: "ignore" });
if (luneProbe.status !== 0) {
  console.log(
    "\n⚠ Lune not found — compiled the runtime but skipped execution tests.\n" +
      "  Install it with `rokit install` (see rokit.toml) to run the suite.",
  );
  if (!keepArtifacts) {
    rmSync(compiledSource, { recursive: true, force: true });
  }
  process.exit(0);
}

step("Executing runtime under Lune");
const run = spawnSync("lune", ["run", runScript, compiledOutput, promisePath], {
  cwd: packageDir,
  stdio: "inherit",
});

if (!keepArtifacts) {
  rmSync(compiledSource, { recursive: true, force: true });
}

if (run.status !== 0) {
  fail("runtime execution tests failed");
}
console.log("\n✓ Native runtime execution tests passed");
