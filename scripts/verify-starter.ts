// `pnpm verify:starter` — a fresh starter project works end to end.
//
// Writes the files `create-aruna-app` writes, then runs the steps it runs and
// the ones its README tells a new user to run: `aruna init`, `aruna add domain
// shop --with ui,resource`, `aruna build` (to Luau), `aruna test` (the
// scaffolded spec under Lune), and `aruna check`. Each must succeed.
//
// It uses this checkout's packages (built first) and the dependencies already
// installed for apps/rbxts-harness (roblox-ts, @rbxts/types), linked in, so it
// needs no registry. Lune must be on PATH (rokit). Flags: --keep.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(__dirname, "..");
const keep = process.argv.includes("--keep");
const aruna = path.join(repoRoot, "packages", "aruna", "bin", "aruna.js");
const dependencies = path.join(repoRoot, "apps", "rbxts-harness", "node_modules");

type ScaffoldModule = {
  planScaffoldFiles: (appName: string, version: string) => Array<{ name: string; contents: string }>;
};

function step(label: string, args: string[], cwd: string): string {
  process.stdout.write(`• ${label}\n`);
  try {
    return execFileSync("node", [aruna, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    throw new Error(`${label} failed:\n${failure.stdout ?? ""}${failure.stderr ?? ""}`);
  }
}

async function main(): Promise<void> {
  const scaffoldModule = path.join(repoRoot, "packages", "create-aruna-app", "dist", "scaffold.js");
  if (!fs.existsSync(scaffoldModule) || !fs.existsSync(path.join(repoRoot, "packages", "aruna", "dist", "cli.js"))) {
    throw new Error("build the workspace first (pnpm build)");
  }
  const { planScaffoldFiles } = (await import(pathToFileURL(scaffoldModule).href)) as ScaffoldModule;
  const version = (JSON.parse(fs.readFileSync(path.join(repoRoot, "packages", "aruna", "package.json"), "utf8")) as {
    version: string;
  }).version;

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "aruna-starter-"));
  const project = path.join(workDir, "starter-game");
  fs.mkdirSync(project);
  try {
    for (const file of planScaffoldFiles("starter-game", version)) {
      fs.mkdirSync(path.dirname(path.join(project, file.name)), { recursive: true });
      fs.writeFileSync(path.join(project, file.name), file.contents);
    }
    fs.symlinkSync(fs.realpathSync(dependencies), path.join(project, "node_modules"), "dir");

    step("aruna init", ["init"], project);
    step("aruna add domain shop --with ui,resource", ["add", "domain", "shop", "--with", "ui,resource"], project);
    const built = step("aruna build", ["build"], project);
    if (!built.includes("rbxtsc compiled the project to Luau")) {
      throw new Error(`aruna build did not compile to Luau:\n${built}`);
    }
    const tested = step("aruna test", ["test"], project);
    if (!/2 passed, 0 failed/.test(tested)) {
      throw new Error(`the scaffolded spec did not pass:\n${tested}`);
    }
    step("aruna check", ["check"], project);
    for (const generated of [
      "src/.aruna/shared/signals.generated.ts",
      "src/.aruna/shared/resources.client.generated.ts",
      "out/server",
      "out/client",
    ]) {
      if (!fs.existsSync(path.join(project, generated))) {
        throw new Error(`expected ${generated} after the build`);
      }
    }
    process.stdout.write("✓ the starter scaffolds, builds to Luau, passes its spec, and checks clean\n");
  } finally {
    if (keep) {
      process.stdout.write(`kept ${project}\n`);
    } else {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
