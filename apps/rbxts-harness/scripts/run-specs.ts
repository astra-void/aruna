// Runs the harness specs through the real `aruna test`.
//
// Lune is optional here, the way it is for apps/roblox-runtime-test: without it
// the specs are skipped with a clear notice so a checkout without the Roblox
// toolchain still has a green `pnpm test`. `aruna test` itself deliberately
// fails when Lune is missing — a consumer's suite must never report a pass it
// did not run — so the probe lives here rather than in the command.

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arunaCli = join(packageDir, "..", "..", "packages", "aruna", "dist", "cli.js");

const luneProbe = spawnSync("lune", ["--version"], { stdio: "ignore" });
if (luneProbe.status !== 0) {
  console.log(
    "\n⚠ Lune not found — skipped the harness specs.\n" +
      "  Install it with `rokit install` (see rokit.toml) to run them.",
  );
  process.exit(0);
}

const run = spawnSync(process.execPath, [arunaCli, "test"], {
  cwd: packageDir,
  stdio: "inherit",
});
process.exit(run.status ?? 1);
