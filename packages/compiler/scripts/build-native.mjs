import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(packageRoot, "../..");
const profile = process.env.ARUNA_NATIVE_PROFILE === "release" ? "release" : "debug";
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(workspaceRoot, process.env.CARGO_TARGET_DIR)
  : path.join(workspaceRoot, "target");

const sourceName =
  process.platform === "win32"
    ? "aruna_napi.dll"
    : process.platform === "darwin"
      ? "libaruna_napi.dylib"
      : "libaruna_napi.so";
const sourcePath = path.join(targetDir, profile, sourceName);
const outputPath = path.join(targetDir, profile, "aruna_napi.node");

const buildArgs = ["build", "--manifest-path", path.join(workspaceRoot, "crates", "aruna_napi", "Cargo.toml"), "--features", "napi-addon"];
if (profile === "release") {
  buildArgs.push("--release");
}

const build = spawnSync("cargo", buildArgs, {
  cwd: workspaceRoot,
  stdio: "inherit",
  env: process.env,
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

if (!fs.existsSync(sourcePath)) {
  throw new Error(`Native build completed, but artifact was not found at ${sourcePath}`);
}

fs.copyFileSync(sourcePath, outputPath);
