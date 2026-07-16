#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import pc from "picocolors";
import {
  POST_INSTALL_ARUNA_STEPS,
  detectPackageManager,
  installCommand,
  localArunaBin,
  scaffoldProject,
  validateAppName,
  type PackageManager,
} from "./scaffold.js";

// create-aruna-app is versioned in lockstep with @arunajs/aruna, so its own version
// is the one the scaffolded dependency should track.
function createArunaAppVersion(): string {
  const packageJsonPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../package.json",
  );
  const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: string };
  if (typeof manifest.version !== "string") {
    throw new Error("create-aruna-app package.json is missing a version");
  }
  return manifest.version;
}

function run(command: string, args: readonly string[], cwd: string): boolean {
  const result = spawnSync(command, [...args], { cwd, stdio: "inherit" });
  return result.status === 0;
}

function printNextSteps(appName: string, pm: PackageManager, fromStep: number): void {
  const lines = [`  cd ${appName}`];
  if (fromStep === 0) {
    lines.push(`  ${installCommand(pm).command} ${installCommand(pm).args.join(" ")}`.trimEnd());
  }
  for (const step of POST_INSTALL_ARUNA_STEPS.slice(Math.max(fromStep - 1, 0))) {
    lines.push(`  npx aruna ${step.args.join(" ")}   # ${step.description}`);
  }
  lines.push(`  ${pm === "npm" ? "npm run" : pm} dev`);
  process.stdout.write(`\nnext steps\n${lines.join("\n")}\n`);
}

export async function main(): Promise<number> {
  const program = new Command();
  program
    .name("create-aruna-app")
    .description("scaffold a new Aruna + roblox-ts project")
    .argument("<directory>", "directory to create the project in")
    .option("--no-install", "skip dependency install and the post-install aruna steps")
    .option("--pm <pm>", "package manager to install with (npm|pnpm|yarn|bun)");

  program.parse(process.argv);
  const directory = program.args[0] as string;
  const options = program.opts<{ install: boolean; pm?: string }>();

  const appDirectory = path.resolve(process.cwd(), directory);
  const appName = path.basename(appDirectory);
  const nameError = validateAppName(appName);
  if (nameError !== undefined) {
    process.stderr.write(`${pc.red(nameError)}\n`);
    return 1;
  }

  let pm: PackageManager;
  if (options.pm !== undefined) {
    if (!["npm", "pnpm", "yarn", "bun"].includes(options.pm)) {
      process.stderr.write(`${pc.red(`unsupported package manager "${options.pm}"`)}\n`);
      return 1;
    }
    pm = options.pm as PackageManager;
  } else {
    pm = detectPackageManager(process.env["npm_config_user_agent"]);
  }

  let result;
  try {
    result = scaffoldProject({ appDirectory, appName, arunaVersion: createArunaAppVersion() });
  } catch (error) {
    process.stderr.write(`${pc.red(error instanceof Error ? error.message : String(error))}\n`);
    return 1;
  }

  process.stdout.write(`create-aruna-app ${appName}\n\ncreated\n`);
  for (const file of result.created) {
    process.stdout.write(`  + ${file}\n`);
  }

  if (!options.install) {
    printNextSteps(directory, pm, 0);
    return 0;
  }

  const install = installCommand(pm);
  process.stdout.write(`\ninstalling with ${pm}…\n`);
  if (!run(install.command, install.args, appDirectory)) {
    process.stderr.write(`${pc.red(`${pm} install failed`)}\n`);
    printNextSteps(directory, pm, 0);
    return 1;
  }

  const arunaBin = localArunaBin(appDirectory);
  if (!fs.existsSync(arunaBin)) {
    process.stderr.write(
      `${pc.red("the aruna bin was not installed — is @arunajs/aruna reachable from your registry?")}\n`,
    );
    printNextSteps(directory, pm, 1);
    return 1;
  }

  for (const [index, step] of POST_INSTALL_ARUNA_STEPS.entries()) {
    process.stdout.write(`\naruna ${step.args.join(" ")} — ${step.description}\n`);
    if (!run(arunaBin, step.args, appDirectory)) {
      process.stderr.write(`${pc.red(`aruna ${step.args.join(" ")} failed`)}\n`);
      printNextSteps(directory, pm, index + 1);
      return 1;
    }
  }

  process.stdout.write(`\n${pc.green("done")} — the project builds green.\n`);
  printNextSteps(directory, pm, POST_INSTALL_ARUNA_STEPS.length + 1);
  return 0;
}

process.exitCode = await main();
