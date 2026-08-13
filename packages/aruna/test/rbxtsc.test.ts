import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findRbxtscBin, rbxtscOk, runRbxtsc } from "../src/cli/rbxtsc.ts";

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aruna-rbxtsc-"));
}

// Writes a fake rbxtsc into <root>/node_modules/.bin that records its argv and
// cwd, then exits with the requested status. Lets us exercise the real spawn
// path without installing roblox-ts. Skipped on win32 (the resolver looks for a
// rbxtsc.cmd shim there, which this shebang script cannot stand in for).
function installFakeRbxtsc(root: string, exitCode: number): string {
  const binDir = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  const logPath = path.join(root, "rbxtsc.log");
  const binPath = path.join(binDir, "rbxtsc");
  fs.writeFileSync(
    binPath,
    `#!/usr/bin/env node\n` +
      `const fs = require("node:fs");\n` +
      `fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n` +
      `process.stdout.write("fake rbxtsc ran\\n");\n` +
      `process.exit(${exitCode});\n`,
    "utf8",
  );
  fs.chmodSync(binPath, 0o755);
  return logPath;
}

describe("rbxtsc runner", () => {
  it("skips gracefully when no rbxtsc binary is resolvable", () => {
    const root = makeTempRoot();
    try {
      expect(findRbxtscBin(root)).toBeUndefined();
      const result = runRbxtsc({ projectRoot: root });
      expect(result.kind).toBe("skipped");
      if (result.kind === "skipped") {
        expect(result.reason).toContain("--no-emit-luau");
      }
      expect(rbxtscOk(result)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "finds the project-local binary and runs it against the project root",
    () => {
      const root = makeTempRoot();
      try {
        const logPath = installFakeRbxtsc(root, 0);
        expect(findRbxtscBin(root)).toBe(path.join(root, "node_modules", ".bin", "rbxtsc"));

        const result = runRbxtsc({ projectRoot: root });
        expect(result.kind).toBe("ran");
        if (result.kind === "ran") {
          expect(result.status).toBe(0);
          expect(result.stdout).toContain("fake rbxtsc ran");
        }
        expect(rbxtscOk(result)).toBe(true);

        const log = JSON.parse(fs.readFileSync(logPath, "utf8")) as {
          argv: string[];
          cwd: string;
        };
        expect(log.argv).toEqual(["--project", root]);
        expect(fs.realpathSync(log.cwd)).toBe(fs.realpathSync(root));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "treats a nonzero rbxtsc exit as a Luau compile failure",
    () => {
      const root = makeTempRoot();
      try {
        installFakeRbxtsc(root, 1);
        const result = runRbxtsc({ projectRoot: root });
        expect(result.kind).toBe("ran");
        if (result.kind === "ran") {
          expect(result.status).toBe(1);
        }
        expect(rbxtscOk(result)).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  // Windows has no extensionless shim to run (the one npm writes there is a
  // POSIX shell script), so the resolver must pick the .cmd shim next to it.
  it("resolves the windows shim rather than the posix entry", () => {
    const root = makeTempRoot();
    try {
      const binDir = path.join(root, "node_modules", ".bin");
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, "rbxtsc"), "#!/bin/sh\n", "utf8");
      expect(findRbxtscBin(root, "win32")).toBeUndefined();

      fs.writeFileSync(path.join(binDir, "rbxtsc.cmd"), "@echo off\n", "utf8");
      expect(findRbxtscBin(root, "win32")).toBe(path.join(binDir, "rbxtsc.cmd"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("walks up parent directories to find the binary", () => {
    const root = makeTempRoot();
    try {
      installFakeRbxtsc(root, 0);
      const nested = path.join(root, "packages", "game", "src");
      fs.mkdirSync(nested, { recursive: true });
      expect(findRbxtscBin(nested)).toBe(path.join(root, "node_modules", ".bin", "rbxtsc"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
