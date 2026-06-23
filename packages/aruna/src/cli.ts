#!/usr/bin/env node
export * from "./cli/cli.js";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main, resolveColorMode } from "./cli/cli.js";
import { formatError } from "./cli/theme.js";

function resolveRealPath(absolutePath: string): string {
  try {
    return fs.realpathSync.native(absolutePath);
  } catch {
    return path.resolve(absolutePath);
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolveRealPath(process.argv[1]) === resolveRealPath(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(
      `${formatError(message, resolveColorMode({}, process.env, Boolean(process.stderr.isTTY)))}\n`,
    );
    process.exitCode = 3;
  });
}
