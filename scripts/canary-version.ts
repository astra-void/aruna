// Sets every publishable package to the canary version for this build:
// `<major>.<minor>.<patch + 1>-canary.<sha7>.<run>`. A canary sorts above the
// release it was built after and below the next one, and every job of one
// workflow run derives the same version from the commit and run number, so the
// native packages built in parallel match the ones the publish job stages.
//
// Usage: tsx scripts/canary-version.ts [--sha <sha>] [--run <number>]
// (defaults: GITHUB_SHA, GITHUB_RUN_NUMBER). Prints the version.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLISHED_PACKAGES = ["compiler", "core", "aruna", "create-aruna-app"] as const;

export function canaryVersion(releaseVersion: string, sha: string, run: string | number): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(releaseVersion);
  if (match === null) {
    throw new Error(`Expected a release version like 1.2.3, got ${releaseVersion}.`);
  }
  const shortSha = sha.slice(0, 7).toLowerCase();
  if (!/^[0-9a-f]{7}$/.test(shortSha)) {
    throw new Error(`Expected a commit sha, got ${sha}.`);
  }
  if (!/^\d+$/.test(String(run))) {
    throw new Error(`Expected a run number, got ${run}.`);
  }
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}-canary.${shortSha}.${run}`;
}

// Replaces the top-level "version" value in a package.json's text, leaving the
// rest of the file — key order, formatting — as it was.
export function withVersion(packageJsonText: string, version: string): string {
  const updated = packageJsonText.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`);
  if (updated === packageJsonText && !packageJsonText.includes(`"version": "${version}"`)) {
    throw new Error("package.json has no version field to replace.");
  }
  return updated;
}

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sha = argument("--sha") ?? process.env.GITHUB_SHA;
  const run = argument("--run") ?? process.env.GITHUB_RUN_NUMBER;
  if (sha === undefined || run === undefined) {
    throw new Error(
      "Pass --sha and --run, or run under GitHub Actions (GITHUB_SHA, GITHUB_RUN_NUMBER).",
    );
  }

  const manifests = PUBLISHED_PACKAGES.map((name) =>
    path.join(repoRoot, "packages", name, "package.json"),
  );
  const releaseVersion = (JSON.parse(fs.readFileSync(manifests[0], "utf8")) as { version: string })
    .version;
  const version = canaryVersion(releaseVersion, sha, run);
  for (const manifest of manifests) {
    fs.writeFileSync(manifest, withVersion(fs.readFileSync(manifest, "utf8"), version));
  }
  console.log(version);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
