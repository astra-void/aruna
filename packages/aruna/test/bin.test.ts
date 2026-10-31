// The `aruna` command has to be a file the repository checks in. A package
// manager links a workspace package's bin only when the file exists at install
// time, and dist/ is build output: with the bin pointing into dist/, a fresh
// checkout had no `aruna` command, and the rbxts harness's `aruna build` failed
// in CI with "aruna: not found".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
  bin: Record<string, string>;
  files: string[];
};
const binPath = packageJson.bin["aruna"] ?? "";

describe("the aruna bin", () => {
  it("is a checked-in file outside dist/, and ships", () => {
    const relative = path.posix.normalize(binPath);
    expect(relative.startsWith("dist/")).toBe(false);
    expect(fs.existsSync(path.join(packageRoot, relative))).toBe(true);
    expect(packageJson.files).toContain(relative.split("/")[0]);
  });

  it("runs the built CLI", () => {
    const result = spawnSync(process.execPath, [path.join(packageRoot, binPath), "--help"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Usage: aruna /);
  });
});
