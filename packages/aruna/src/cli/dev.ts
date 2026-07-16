import fs from "node:fs";
import path from "node:path";

// The Rojo project file `aruna dev` serves. Kept in sync with the scaffold in
// init.ts and the partition contract in rojo-layout.ts.
export const ROJO_PROJECT_FILE = "default.project.json";

export type RojoServePlan =
  | { readonly mode: "spawn"; readonly args: readonly string[] }
  | { readonly mode: "skip"; readonly reason: string };

// Decides whether `aruna dev` should spawn a `rojo serve` child and with what
// arguments. Pure so the decision table is unit-testable; the caller supplies
// the file-existence probe result.
export function resolveRojoServePlan(options: {
  // Resolved from config `dev.rojo` and the CLI `--no-rojo` override.
  readonly rojoEnabled: boolean;
  // CLI `--rojo-port` beats config `dev.rojo.port`.
  readonly port: number | undefined;
  readonly projectFileExists: boolean;
}): RojoServePlan {
  if (!options.rojoEnabled) {
    return { mode: "skip", reason: "disabled (dev.rojo: false or --no-rojo)" };
  }
  if (!options.projectFileExists) {
    return {
      mode: "skip",
      reason: `no ${ROJO_PROJECT_FILE} in the project root — run \`aruna init\` to scaffold one`,
    };
  }
  return {
    mode: "spawn",
    args: [
      "serve",
      ROJO_PROJECT_FILE,
      ...(options.port !== undefined ? ["--port", String(options.port)] : []),
    ],
  };
}

export function rojoProjectFileExists(projectRoot: string): boolean {
  return fs.existsSync(path.join(projectRoot, ROJO_PROJECT_FILE));
}

// Buffers a child process's output stream and forwards it line-by-line with a
// prefix, so rojo's output stays distinguishable from the build's inside the
// single `aruna dev` terminal. Partial lines are held until their newline (or
// flush) so a chunk boundary mid-line never splits the prefix.
export function createLinePrefixer(
  prefix: string,
  write: (line: string) => void,
): { readonly push: (chunk: string) => void; readonly flush: () => void } {
  let pending = "";
  return {
    push(chunk) {
      pending += chunk;
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline === -1) {
          return;
        }
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        write(`${prefix}${line}`);
      }
    },
    flush() {
      if (pending.length > 0) {
        write(`${prefix}${pending}`);
        pending = "";
      }
    },
  };
}
