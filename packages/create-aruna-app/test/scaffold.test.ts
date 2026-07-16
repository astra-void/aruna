import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PINNED_TOOLCHAIN,
  POST_INSTALL_ARUNA_STEPS,
  detectPackageManager,
  installCommand,
  planScaffoldFiles,
  scaffoldProject,
  validateAppName,
} from "../src/scaffold.js";

describe("detectPackageManager", () => {
  it("reads the invoking package manager from the user agent", () => {
    expect(detectPackageManager("pnpm/9.0.0 npm/? node/v22")).toBe("pnpm");
    expect(detectPackageManager("yarn/4.1.0 npm/? node/v22")).toBe("yarn");
    expect(detectPackageManager("bun/1.1.0 npm/? node/v22")).toBe("bun");
    expect(detectPackageManager("npm/10.5.0 node/v22")).toBe("npm");
    expect(detectPackageManager(undefined)).toBe("npm");
  });
});

describe("installCommand", () => {
  it("uses bare `yarn` and `<pm> install` otherwise", () => {
    expect(installCommand("yarn")).toEqual({ command: "yarn", args: [] });
    expect(installCommand("pnpm")).toEqual({ command: "pnpm", args: ["install"] });
    expect(installCommand("npm")).toEqual({ command: "npm", args: ["install"] });
  });
});

describe("validateAppName", () => {
  it("accepts npm-safe names and rejects the rest", () => {
    expect(validateAppName("my-game")).toBeUndefined();
    expect(validateAppName("game2")).toBeUndefined();
    expect(validateAppName("My Game")).toBeDefined();
    expect(validateAppName("-lead")).toBeDefined();
    expect(validateAppName("")).toBeDefined();
  });
});

describe("planScaffoldFiles", () => {
  const files = planScaffoldFiles("my-game", "0.1.3");
  const byName = new Map(files.map((file) => [file.name, file.contents]));

  it("plans the framework-owned base files", () => {
    expect([...byName.keys()]).toEqual([
      "package.json",
      "aruna.config.ts",
      ".gitignore",
      "rokit.toml",
      ".vscode/settings.json",
      "README.md",
    ]);
  });

  it("pins the aruna dependency to the lockstep version and ships the toolchain matrix", () => {
    const manifest = JSON.parse(byName.get("package.json") as string);
    expect(manifest.name).toBe("my-game");
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies).toEqual({ "@arunajs/aruna": "^0.1.3" });
    expect(manifest.devDependencies).toEqual(PINNED_TOOLCHAIN);
    expect(manifest.scripts.dev).toBe("aruna dev");
    // The roblox-ts ↔ typescript pairing is the classic rbxts trap; the matrix
    // must pin typescript exactly, matching what roblox-ts itself pins.
    expect(PINNED_TOOLCHAIN["typescript"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("defaults the starter to generated entries", () => {
    expect(byName.get("aruna.config.ts")).toContain('entries: "generated"');
  });

  it("manages rojo through rokit for the dev loop", () => {
    expect(byName.get("rokit.toml")).toContain("rojo = ");
  });
});

describe("POST_INSTALL_ARUNA_STEPS", () => {
  it("completes the project via the aruna CLI: init, example domain, build", () => {
    expect(POST_INSTALL_ARUNA_STEPS.map((step) => step.args[0])).toEqual([
      "init",
      "add",
      "build",
    ]);
  });
});

describe("scaffoldProject", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the plan into a fresh directory", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "create-aruna-"));
    tempDirs.push(parent);
    const appDirectory = path.join(parent, "my-game");

    const result = scaffoldProject({ appDirectory, appName: "my-game", arunaVersion: "0.1.3" });

    expect(result.created).toContain("package.json");
    expect(fs.existsSync(path.join(appDirectory, ".vscode/settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(appDirectory, "README.md"))).toBe(true);
  });

  it("refuses a non-empty target directory", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "create-aruna-"));
    tempDirs.push(parent);
    const appDirectory = path.join(parent, "occupied");
    fs.mkdirSync(appDirectory);
    fs.writeFileSync(path.join(appDirectory, "keep.txt"), "");

    expect(() =>
      scaffoldProject({ appDirectory, appName: "occupied", arunaVersion: "0.1.3" }),
    ).toThrow(/not empty/);
  });

  it("tolerates an existing .git directory (git init before scaffold)", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "create-aruna-"));
    tempDirs.push(parent);
    const appDirectory = path.join(parent, "with-git");
    fs.mkdirSync(path.join(appDirectory, ".git"), { recursive: true });

    const result = scaffoldProject({ appDirectory, appName: "with-git", arunaVersion: "0.1.3" });
    expect(result.created).toContain("package.json");
  });
});
