import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export type NativeCompiler = {
  checkProject: (input: unknown) => unknown;
  inspectProject: (input: unknown) => unknown;
};

const NATIVE_LOAD_ERROR_MESSAGE =
  "Aruna native compiler could not be loaded.\nRun the native build, verify platform support, or reinstall the package.";

let cachedCompiler: NativeCompiler | null = null;

function workspaceRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function targetRoot(): string {
  const configured = process.env["CARGO_TARGET_DIR"];
  if (configured) {
    return path.resolve(workspaceRoot(), configured);
  }
  return path.join(workspaceRoot(), "target");
}

function candidatePaths(): string[] {
  const artifactName = "aruna_napi.node";
  const targetDir = targetRoot();
  return [path.join(targetDir, "debug", artifactName), path.join(targetDir, "release", artifactName)];
}

function validateNativeCompiler(value: unknown): asserts value is NativeCompiler {
  if (typeof value !== "object" || value === null) {
    throw new Error(NATIVE_LOAD_ERROR_MESSAGE);
  }
  const candidate = value as Partial<NativeCompiler>;
  if (typeof candidate.checkProject !== "function" || typeof candidate.inspectProject !== "function") {
    throw new Error(NATIVE_LOAD_ERROR_MESSAGE);
  }
}

export function loadNativeCompiler(): NativeCompiler {
  if (cachedCompiler) {
    return cachedCompiler;
  }

  const require = createRequire(import.meta.url);
  let lastError: unknown;

  for (const candidatePath of candidatePaths()) {
    if (!fs.existsSync(candidatePath)) {
      continue;
    }

    try {
      const loaded = require(candidatePath);
      validateNativeCompiler(loaded);
      cachedCompiler = loaded;
      return loaded;
    } catch (error) {
      lastError = error;
    }
  }

  const error = new Error(NATIVE_LOAD_ERROR_MESSAGE);
  if (lastError !== undefined) {
    (error as Error & { cause?: unknown }).cause = lastError;
  }
  throw error;
}
