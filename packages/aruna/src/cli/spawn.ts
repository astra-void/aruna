import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import path from "node:path";

// Windows cannot execute a `.cmd`/`.bat` shim as a process image. Node used to
// paper over this, but since the CVE-2024-27980 fix (18.20.2 / 20.12.2 / 21.7.3)
// spawning one directly fails with EINVAL — which is how a perfectly healthy
// `node_modules/.bin/rbxtsc.cmd` ends up reported as "failed to launch rbxtsc".
// The shim has to go through a command interpreter instead.
//
// We build the `cmd.exe /d /s /c` invocation ourselves rather than passing
// `shell: true`, because Node's shell mode joins argv with spaces and quotes
// nothing: a project under `C:\Users\First Last\game` would then be split into
// two arguments. `/s` makes cmd strip exactly the outer quote pair and treat the
// rest verbatim, so each token carries its own quoting.

const CMD_SHIM_EXTENSIONS = new Set([".cmd", ".bat"]);

export type CommandPlan = {
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
};

// True when `command` names a Windows batch shim that needs an interpreter.
export function needsCmdInterpreter(command: string, platform: string = process.platform): boolean {
  return platform === "win32" && CMD_SHIM_EXTENSIONS.has(path.extname(command).toLowerCase());
}

function quoteForCmd(token: string): string {
  if (token.length > 0 && !/[\s"^&|<>()]/.test(token)) {
    return token;
  }
  return `"${token.replace(/"/g, '""')}"`;
}

// Rewrites a (command, args) pair into one Node can actually spawn on the
// current platform. Everything except a Windows batch shim passes through
// untouched. `platform` is injectable so the Windows path stays testable from
// any host.
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

// spawnSync with the Windows shim handling applied.
export function spawnSyncCommand(
  command: string,
  args: readonly string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, "windowsVerbatimArguments">,
): SpawnSyncReturns<string> {
  const plan = commandPlan(command, args);
  return spawnSync(plan.command, [...plan.args], {
    ...options,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
  });
}
