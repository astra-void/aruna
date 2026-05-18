export * from "./cli/cli.js";

import path from "node:path";
import { fileURLToPath } from "node:url";
import { main, resolveColorMode } from "./cli/cli.js";
import { formatError } from "./cli/theme.js";

const isDirectExecution =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(
      `${formatError(message, resolveColorMode({}, process.env, Boolean(process.stderr.isTTY)))}\n`,
    );
    process.exitCode = 3;
  });
}
