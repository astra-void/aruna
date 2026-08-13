import { describe, expect, it } from "vitest";
import { commandPlan } from "../src/spawn.ts";

// Asserted from any host: on Windows Node refuses to spawn the `aruna.cmd` shim
// (EINVAL) and never finds a bare `npm` (only `npm.cmd` exists), so the plan is
// platform-injectable rather than platform-gated.
describe("commandPlan", () => {
  it("passes posix commands through untouched", () => {
    expect(commandPlan("npm", ["install"], "darwin")).toEqual({
      command: "npm",
      args: ["install"],
      windowsVerbatimArguments: false,
    });
  });

  it("resolves a bare package manager through the command interpreter on windows", () => {
    const plan = commandPlan("pnpm", ["install"], "win32");
    expect(plan.command).toBe(process.env["ComSpec"] ?? "cmd.exe");
    expect(plan.args).toEqual(["/d", "/s", "/c", '"pnpm install"']);
    expect(plan.windowsVerbatimArguments).toBe(true);
  });

  it("quotes a shim path containing spaces so it stays one argument", () => {
    const bin = "C:\\Users\\First Last\\my-game\\node_modules\\.bin\\aruna.cmd";
    const plan = commandPlan(bin, ["build"], "win32");
    expect(plan.args[3]).toBe(`""${bin}" build"`);
  });
});
