import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type RbxtscResult =
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "ran"; readonly status: number; readonly stdout: string; readonly stderr: string };

// Resolves the rbxtsc binary the consumer installed by walking up from the
// project root looking for node_modules/.bin/rbxtsc. We deliberately use the
// project-local roblox-ts rather than a PATH lookup so the Luau compile matches
// the roblox-ts version the consumer pinned.
export function findRbxtscBin(startDir: string): string | undefined {
  const binName = process.platform === "win32" ? "rbxtsc.cmd" : "rbxtsc";
  let current = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(current, "node_modules", ".bin", binName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

// Compiles the project to Luau by driving the consumer's pinned rbxtsc. A
// missing binary is a graceful skip (the stub generation still succeeded), not
// a build failure — callers that require Luau should treat a nonzero `status`
// from a "ran" result as the failure signal.
export function runRbxtsc(options: {
  readonly projectRoot: string;
  readonly bin?: string | undefined;
}): RbxtscResult {
  const bin = options.bin ?? findRbxtscBin(options.projectRoot);
  if (bin === undefined) {
    return {
      kind: "skipped",
      reason:
        "rbxtsc not found in node_modules/.bin — install roblox-ts to emit Luau, or pass --no-emit-luau to skip this step",
    };
  }

  const result = spawnSync(bin, ["--project", options.projectRoot], {
    cwd: options.projectRoot,
    encoding: "utf8",
  });

  if (result.error) {
    return { kind: "skipped", reason: `failed to launch rbxtsc: ${result.error.message}` };
  }

  return {
    kind: "ran",
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// True when the result does not represent a Luau compile failure: a skip leaves
// the build green, and a clean rbxtsc exit (status 0) succeeds.
export function rbxtscOk(result: RbxtscResult): boolean {
  return result.kind === "skipped" || result.status === 0;
}
