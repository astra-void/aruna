import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function assertPresent(absolutePath: string): Promise<void> {
  if (!(await exists(absolutePath))) {
    throw new Error(`Missing required path: ${absolutePath}`);
  }
}

async function assertMissing(absolutePath: string): Promise<void> {
  if (await exists(absolutePath)) {
    throw new Error(`Unexpected path present: ${absolutePath}`);
  }
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }

  if (await exists(root)) {
    await walk(root);
  }

  return files;
}

async function assertNoBadReferences(root: string): Promise<void> {
  const badFragments = ["tmp/", "rbxts-harness-", "out.raw"];
  const files = await walkFiles(root);

  for (const file of files) {
    if (!file.endsWith(".luau") && !file.endsWith(".json")) {
      continue;
    }

    const contents = await fs.readFile(file, "utf8");
    for (const fragment of badFragments) {
      if (contents.includes(fragment)) {
        throw new Error(`Unexpected reference ${fragment} in ${file}`);
      }
    }
  }
}

async function assertLayoutMetadata(absolutePath: string): Promise<void> {
  const raw = await fs.readFile(absolutePath, "utf8");
  const layout = JSON.parse(raw) as {
    version?: number;
    rootDir?: string;
    targets?: Array<{
      source?: string;
      kind?: string;
      target?: string;
      entry?: boolean;
    }>;
  };

  if (layout.version !== 1) {
    throw new Error(`Unexpected rbxts layout version: ${layout.version ?? "missing"}`);
  }

  if (layout.rootDir !== "src") {
    throw new Error(`Unexpected rbxts layout rootDir: ${layout.rootDir ?? "missing"}`);
  }

  if (!Array.isArray(layout.targets)) {
    throw new Error("rbxts layout targets must be an array");
  }

  const bySource = new Map(
    layout.targets.map((entry) => [
      entry.source ?? "",
      {
        kind: entry.kind,
        target: entry.target,
        entry: entry.entry,
      },
    ]),
  );

  const requiredTargets: Array<[string, string, boolean]> = [
    ["src/client.tsx", "client", true],
    ["src/server.ts", "server", true],
    ["src/app/bootstrap.ts", "shared", false],
    ["src/domains/shop/ui.tsx", "client", false],
    ["src/domains/shop/actions.ts", "server", false],
    ["src/.aruna/actions.client.generated.ts", "shared", false],
    ["src/.aruna/actions.server.generated.ts", "server", false],
  ];

  for (const [source, target, entry] of requiredTargets) {
    const record = bySource.get(source);
    if (!record) {
      throw new Error(`Missing rbxts layout target: ${source}`);
    }
    if (record.target !== target) {
      throw new Error(`Unexpected target for ${source}: ${record.target}`);
    }
    if (record.entry !== entry) {
      throw new Error(`Unexpected entry flag for ${source}: ${record.entry}`);
    }
  }
}

async function main(): Promise<void> {
  const src = path.join(projectRoot, "src");
  const out = path.join(projectRoot, "out");
  const include = path.join(projectRoot, "include");
  const generatedLayout = path.join(src, ".aruna", "rbxts-layout.json");

  await Promise.all([
    assertPresent(path.join(src, "client.tsx")),
    assertPresent(path.join(src, "server.ts")),
    assertPresent(path.join(src, "app", "bootstrap.ts")),
    assertPresent(path.join(src, "app", "providers.ts")),
    assertPresent(path.join(src, "domains", "shop", "actions.ts")),
    assertPresent(path.join(src, "domains", "shop", "schema.ts")),
    assertPresent(path.join(src, "domains", "shop", "ui.tsx")),
    assertPresent(path.join(src, "domains", "inventory", "actions.ts")),
    assertPresent(path.join(src, "domains", "waves", "actions.ts")),
    assertPresent(path.join(src, "shared", "constants.ts")),
    assertPresent(path.join(src, ".aruna")),
    assertPresent(path.join(src, ".aruna", "actions.client.generated.ts")),
    assertPresent(path.join(src, ".aruna", "actions.server.generated.ts")),
    assertPresent(path.join(src, ".aruna", "manifest.json")),
    assertPresent(path.join(src, ".aruna", "rbxts-layout.json")),
    assertMissing(path.join(src, "client", "main.client.tsx")),
    assertMissing(path.join(src, "server", "main.server.ts")),
    assertMissing(path.join(src, "client")),
    assertMissing(path.join(src, "server")),
    assertMissing(path.join(src, "shared", "app")),
    assertMissing(path.join(src, "shared", "domains")),
    assertMissing(path.join(src, "shared", ".aruna")),
    assertMissing(path.join(include, "aruna")),
    assertPresent(path.join(out, "client")),
    assertPresent(path.join(out, "server")),
    assertPresent(path.join(out, "shared")),
    assertPresent(path.join(out, "client", "main.client.luau")),
    assertPresent(path.join(out, "server", "main.server.luau")),
    assertPresent(path.join(out, "server", ".aruna", "actions.server.generated.luau")),
    assertPresent(path.join(out, "shared", "app", "bootstrap.luau")),
    assertPresent(path.join(out, "shared", "app", "providers.luau")),
    assertPresent(path.join(out, "shared", "constants.luau")),
    assertPresent(path.join(out, "shared", "ids.luau")),
    assertPresent(path.join(out, "shared", "result.luau")),
    assertPresent(path.join(out, "shared", ".aruna", "actions.client.generated.luau")),
    assertPresent(path.join(out, "shared", ".aruna", "manifest.json")),
    assertPresent(path.join(out, "shared", ".aruna", "rbxts-layout.json")),
    assertMissing(path.join(out, "client.luau")),
    assertMissing(path.join(out, "server.luau")),
    assertMissing(path.join(out, "shared.luau")),
    assertMissing(path.join(out, ".aruna")),
    assertMissing(path.join(out, "shared", "shared")),
    assertMissing(path.join(out, "shared", ".aruna", "actions.server.generated.luau")),
  ]);

  await assertLayoutMetadata(generatedLayout);
  await assertNoBadReferences(out);
}

void main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
