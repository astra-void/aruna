import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import path from "node:path";

// Windows cannot execute a `.cmd`/`.bat` shim as a process image, and Node's
// PATH lookup only ever appends `.exe`. So both of the things this CLI spawns
// fail there: `node_modules/.bin/aruna.cmd` fails with EINVAL (Node refuses
// batch shims since the CVE-2024-27980 fix in 18.20.2 / 20.12.2 / 21.7.3), and
// a bare `npm`/`pnpm` fails with ENOENT because only `npm.cmd` exists. Routing
// through cmd.exe fixes both: it runs batch files and resolves PATHEXT itself.
//
// We build the `cmd.exe /d /s /c` invocation ourselves rather than passing
// `shell: true`, because Node's shell mode joins argv with spaces and quotes
// nothing — a project under `C:\Users\First Last\game` would be split in two.
// `/s` makes cmd strip exactly the outer quote pair and take the rest verbatim,
// so each token carries its own quoting.

const CMD_SHIM_EXTENSIONS = new Set([".cmd", ".bat"]);

function needsCmdInterpreter(command: string, platform: string): boolean {
  if (platform !== "win32") {
    return false;
  }
  // A bare command name (no directory part) is resolved from PATH, where the
  // package managers only exist as batch shims.
  const isBareName = path.basename(command) === command;
  return isBareName || CMD_SHIM_EXTENSIONS.has(path.extname(command).toLowerCase());
}

function quoteForCmd(token: string): string {
  if (token.length > 0 && !/[\s"^&|<>()]/.test(token)) {
    return token;
  }
  return `"${token.replace(/"/g, '""')}"`;
}

export type CommandPlan = {
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
};

// Rewrites a (command, args) pair into one Node can actually spawn on the given
// platform. Everything but the Windows cases above passes through untouched.
export function commandPlan(
  command: string,
  args: readonly string[],
  platform: string = process.platform,
): CommandPlan {
  if (!needsCmdInterpreter(command, platform)) {
    return { command, args: [...args], windowsVerbatimArguments: false };
  }
  const line = [command, ...args].map(quoteForCmd).join(" ");
  return {
    command: process.env["ComSpec"] ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

// spawnSync with the Windows handling applied.
export function spawnSyncCommand(
  command: string,
  args: readonly string[],
  options: Omit<SpawnSyncOptions, "windowsVerbatimArguments">,
): ReturnType<typeof spawnSync> {
  const plan = commandPlan(command, args);
  return spawnSync(plan.command, [...plan.args], {
    ...options,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
  });
}
