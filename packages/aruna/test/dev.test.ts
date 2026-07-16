import { describe, expect, it } from "vitest";
import { createLinePrefixer, resolveRojoServePlan } from "../src/cli/dev.js";

describe("resolveRojoServePlan", () => {
  it("spawns rojo serve against the project file by default", () => {
    const plan = resolveRojoServePlan({
      rojoEnabled: true,
      port: undefined,
      projectFileExists: true,
    });
    expect(plan).toEqual({ mode: "spawn", args: ["serve", "default.project.json"] });
  });

  it("passes an explicit port through to rojo", () => {
    const plan = resolveRojoServePlan({
      rojoEnabled: true,
      port: 34873,
      projectFileExists: true,
    });
    expect(plan).toEqual({
      mode: "spawn",
      args: ["serve", "default.project.json", "--port", "34873"],
    });
  });

  it("skips when rojo is disabled, even if the project file exists", () => {
    const plan = resolveRojoServePlan({
      rojoEnabled: false,
      port: 34873,
      projectFileExists: true,
    });
    expect(plan.mode).toBe("skip");
  });

  it("skips with a scaffold hint when there is no default.project.json", () => {
    const plan = resolveRojoServePlan({
      rojoEnabled: true,
      port: undefined,
      projectFileExists: false,
    });
    expect(plan.mode).toBe("skip");
    if (plan.mode === "skip") {
      expect(plan.reason).toContain("default.project.json");
      expect(plan.reason).toContain("aruna init");
    }
  });
});

describe("createLinePrefixer", () => {
  it("prefixes every complete line", () => {
    const lines: string[] = [];
    const prefixer = createLinePrefixer("rojo │ ", (line) => lines.push(line));
    prefixer.push("serving on port 34872\nconnected\n");
    expect(lines).toEqual(["rojo │ serving on port 34872", "rojo │ connected"]);
  });

  it("holds a partial line across chunk boundaries", () => {
    const lines: string[] = [];
    const prefixer = createLinePrefixer("> ", (line) => lines.push(line));
    prefixer.push("hel");
    expect(lines).toEqual([]);
    prefixer.push("lo\nwor");
    expect(lines).toEqual(["> hello"]);
    prefixer.flush();
    expect(lines).toEqual(["> hello", "> wor"]);
  });

  it("strips carriage returns from CRLF output", () => {
    const lines: string[] = [];
    const prefixer = createLinePrefixer("> ", (line) => lines.push(line));
    prefixer.push("one\r\ntwo\r\n");
    expect(lines).toEqual(["> one", "> two"]);
  });

  it("flush is a no-op with nothing pending", () => {
    const lines: string[] = [];
    const prefixer = createLinePrefixer("> ", (line) => lines.push(line));
    prefixer.push("done\n");
    prefixer.flush();
    expect(lines).toEqual(["> done"]);
  });
});
