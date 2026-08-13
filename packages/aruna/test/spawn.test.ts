import { describe, expect, it } from "vitest";
import { commandPlan, needsCmdInterpreter } from "../src/cli/spawn.ts";

// These assert the win32 branch from any host: the bug they cover (Node refusing
// to spawn a .cmd shim with EINVAL) only reproduces on Windows, so the logic is
// platform-injectable rather than platform-gated.
describe("commandPlan", () => {
  it("passes a posix binary through untouched", () => {
    const plan = commandPlan("/repo/node_modules/.bin/rbxtsc", ["--project", "/repo"], "linux");
    expect(plan).toEqual({
      command: "/repo/node_modules/.bin/rbxtsc",
      args: ["--project", "/repo"],
      windowsVerbatimArguments: false,
    });
  });

  it("routes a windows .cmd shim through the command interpreter", () => {
    const bin = "C:\\Workspace\\draw-a-tower\\node_modules\\.bin\\rbxtsc.cmd";
    const plan = commandPlan(bin, ["--project", "C:\\Workspace\\draw-a-tower"], "win32");
    expect(plan.command).toBe(process.env["ComSpec"] ?? "cmd.exe");
    expect(plan.args).toEqual([
      "/d",
      "/s",
      "/c",
      `"${bin} --project C:\\Workspace\\draw-a-tower"`,
    ]);
    expect(plan.windowsVerbatimArguments).toBe(true);
  });

  it("quotes windows paths containing spaces so they stay one argument", () => {
    const bin = "C:\\Users\\First Last\\game\\node_modules\\.bin\\rbxtsc.cmd";
    const plan = commandPlan(bin, ["--project", "C:\\Users\\First Last\\game"], "win32");
    expect(plan.args[3]).toBe(`""${bin}" --project "C:\\Users\\First Last\\game""`);
  });

  it("treats .bat like .cmd and leaves .exe alone", () => {
    expect(needsCmdInterpreter("C:\\bin\\rbxtsc.BAT", "win32")).toBe(true);
    expect(needsCmdInterpreter("C:\\bin\\rbxtsc.exe", "win32")).toBe(false);
    expect(needsCmdInterpreter("/usr/bin/rbxtsc.cmd", "linux")).toBe(false);
  });
});
