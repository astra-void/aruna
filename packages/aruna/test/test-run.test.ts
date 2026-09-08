// `aruna test` mechanics: locating the shipped Lune assets and building the
// command line that runs them. The compile-and-execute path itself is covered by
// apps/rbxts-harness, whose `pnpm test` runs its specs through this command.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findLuneRunnerDir, luneRunArgs } from "../src/cli/test-run.js";

describe("findLuneRunnerDir", () => {
  it("finds the runner assets that ship with the package", () => {
    const dir = findLuneRunnerDir();
    expect(dir).toBeDefined();
    // The three files the runner is made of; a partial copy would fail at run
    // time inside Lune, where the error is far harder to read.
    for (const asset of ["run.luau", "loader.luau", "fakes.luau"]) {
      expect(fs.existsSync(path.join(dir as string, asset))).toBe(true);
    }
  });

  it("is listed in the package files so it survives publishing", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { files: string[] };
    expect(packageJson.files).toContain("lune");
  });
});

describe("luneRunArgs", () => {
  it("passes the runner its positional arguments without a -- separator", () => {
    // Lune forwards `--` to the script, which would shift every argument by one.
    const args = luneRunArgs({
      luneBin: "lune",
      runnerDir: "/pkg/lune",
      outRoot: "/tmp/stage/out",
      includeRoot: "/tmp/stage/include",
      generatedDirName: ".aruna",
      nodeModules: "/project/node_modules",
    });

    expect(args).toEqual([
      "run",
      path.join("/pkg/lune", "run.luau"),
      "/tmp/stage/out",
      "/tmp/stage/include",
      ".aruna",
      "/project/node_modules",
    ]);
  });

  it("marks an absent node_modules and appends an optional filter", () => {
    const args = luneRunArgs({
      luneBin: "lune",
      runnerDir: "/pkg/lune",
      outRoot: "/out",
      includeRoot: "/include",
      generatedDirName: ".aruna",
      filter: "shop",
    });

    expect(args.slice(-2)).toEqual(["-", "shop"]);
  });
});
