import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnCommand, spawnSyncCommand } from "./spawn.js";

// Where the Lune runner assets ship. `dist/cli/*.js` sits two levels below the
// package root at runtime and one level below in a flat build, so both shapes
// are probed — the same approach `findRobloxRuntimeSourceDir` takes for the
// vendored runtime.
export function findLuneRunnerDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../lune"),
    path.resolve(here, "../lune"),
    path.resolve(here, "lune"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "run.luau"))) {
      return candidate;
    }
  }
  return undefined;
}

export type LuneProbe =
  | { readonly kind: "found"; readonly bin: string; readonly version: string }
  | { readonly kind: "missing"; readonly reason: string };

// Lune is the Luau runtime the compiled specs execute in. It is not an npm
// package, so it is looked up on PATH rather than in node_modules.
export function probeLune(bin = "lune"): LuneProbe {
  const result = spawnSyncCommand(bin, ["--version"], { encoding: "utf8" });
  if (result.error || (result.status ?? 1) !== 0) {
    return {
      kind: "missing",
      reason:
        "lune was not found on PATH. Specs are compiled to Luau and run under Lune — " +
        "install it with `rokit add lune-org/lune` (or see https://lune-org.github.io) and retry.",
    };
  }
  return { kind: "found", bin, version: (result.stdout ?? "").trim() };
}

export type LuneRunOptions = {
  readonly luneBin: string;
  readonly runnerDir: string;
  // Compiled output root holding client/server/shared/test.
  readonly outRoot: string;
  // rbxtsc's runtime library, loaded instead of required out of a DataModel.
  readonly includeRoot: string;
  // Base name of the generated dir (e.g. ".aruna"), where the vendored runtime —
  // and with it the project's own copy of `aruna/testing` — lives.
  readonly generatedDirName: string;
  readonly nodeModules?: string | undefined;
  readonly filter?: string | undefined;
};

export function luneRunArgs(options: LuneRunOptions): string[] {
  // No `--` separator: Lune passes it through to the script, which would shift
  // every positional argument by one.
  return [
    "run",
    path.join(options.runnerDir, "run.luau"),
    options.outRoot,
    options.includeRoot,
    options.generatedDirName,
    options.nodeModules ?? "-",
    ...(options.filter !== undefined ? [options.filter] : []),
  ];
}

// Runs the compiled specs, streaming Lune's output straight through: the runner
// prints one line per test as it settles, and buffering that would turn a live
// suite into a wall of text at the end.
export async function runLuneSpecs(options: LuneRunOptions): Promise<number> {
  const child = spawnCommand(options.luneBin, luneRunArgs(options), { cwd: options.runnerDir });
  child.stdout.on("data", (chunk: Buffer) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  return await new Promise<number>((resolve) => {
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}
