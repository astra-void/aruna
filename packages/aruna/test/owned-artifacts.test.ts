import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  OWNED_MANIFEST_FILE,
  collectLayoutDesyncDiagnostics,
  detectLegacyArtifacts,
  readOwnedManifest,
  reconcileOwnedArtifacts,
} from "../src/cli/owned-artifacts.js";

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aruna-owned-"));
}

function write(root: string, files: Record<string, string>): void {
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents, "utf8");
  }
}

function exists(absolutePath: string): boolean {
  return fs.existsSync(absolutePath);
}

function minimalConfig(generatedDir = "src/.aruna"): string {
  return `import { defineConfig } from "aruna";\n\nexport default defineConfig({\n  compiler: {\n    generatedDir: "${generatedDir}",\n    manifest: "${generatedDir}/manifest.json",\n  },\n  conventions: {\n    client: ["src/client.ts"],\n    server: ["src/server.ts"],\n    shared: ["src/shared/**"]\n  },\n});\n`;
}

const CURRENT_GENERATED = [
  "shared/actions.client.generated.ts",
  "server/actions.server.generated.ts",
  "shared/signals.generated.ts",
  "manifest.json",
];

describe("owned-artifacts: reconcile / prune", () => {
  it("prunes flat legacy generated files on the first split-tree build", async () => {
    const root = makeTempRoot();
    const generatedDir = path.join(root, "src/.aruna");
    write(root, {
      // Old flat layout left behind by a pre-split-tree build.
      "src/.aruna/actions.client.generated.ts": "// old client stub\n",
      "src/.aruna/actions.server.generated.ts": "// old server stub\n",
      "src/.aruna/signals.generated.ts": "// old signals\n",
      // Current split-tree output.
      "src/.aruna/shared/actions.client.generated.ts": "// new client stub\n",
      "src/.aruna/server/actions.server.generated.ts": "// new server stub\n",
      "src/.aruna/shared/signals.generated.ts": "// new signals\n",
      "src/.aruna/manifest.json": "{}\n",
    });

    const { pruned } = await reconcileOwnedArtifacts({
      generatedDirAbs: generatedDir,
      current: { generated: CURRENT_GENERATED, runtime: [] },
    });

    expect(pruned).toEqual([
      "actions.client.generated.ts",
      "actions.server.generated.ts",
      "signals.generated.ts",
    ]);
    expect(exists(path.join(generatedDir, "actions.client.generated.ts"))).toBe(false);
    expect(exists(path.join(generatedDir, "shared/actions.client.generated.ts"))).toBe(true);
  });

  it("prunes the flat legacy runtime/ directory but never shared/runtime/", async () => {
    const root = makeTempRoot();
    const generatedDir = path.join(root, "src/.aruna");
    write(root, {
      "src/.aruna/runtime/client.ts": "// old vendored runtime\n",
      "src/.aruna/runtime/server.ts": "// old vendored runtime\n",
      "src/.aruna/shared/runtime/client.ts": "// new vendored runtime\n",
    });

    const { pruned } = await reconcileOwnedArtifacts({
      generatedDirAbs: generatedDir,
      current: {
        generated: CURRENT_GENERATED,
        runtime: ["shared/runtime/client.ts", "shared/runtime/server.ts"],
      },
    });

    expect(pruned).toContain("runtime");
    expect(exists(path.join(generatedDir, "runtime"))).toBe(false);
    expect(exists(path.join(generatedDir, "shared/runtime/client.ts"))).toBe(true);
  });

  it("prunes previously-owned files that the current build no longer emits", async () => {
    const root = makeTempRoot();
    const generatedDir = path.join(root, "src/.aruna");
    // First build owns a signals file.
    write(root, {
      "src/.aruna/shared/signals.generated.ts": "// signals\n",
      "src/.aruna/shared/actions.client.generated.ts": "// client\n",
    });
    await reconcileOwnedArtifacts({
      generatedDirAbs: generatedDir,
      current: {
        generated: ["shared/signals.generated.ts", "shared/actions.client.generated.ts"],
        runtime: [],
      },
    });

    // Second build drops signals (project removed all defineSignal calls).
    const { pruned } = await reconcileOwnedArtifacts({
      generatedDirAbs: generatedDir,
      current: { generated: ["shared/actions.client.generated.ts"], runtime: [] },
    });

    expect(pruned).toEqual(["shared/signals.generated.ts"]);
    expect(exists(path.join(generatedDir, "shared/signals.generated.ts"))).toBe(false);
    // The now-empty subtree is cleaned up too.
    expect(exists(path.join(generatedDir, "shared/actions.client.generated.ts"))).toBe(true);
  });

  it("never deletes files it does not own", async () => {
    const root = makeTempRoot();
    const generatedDir = path.join(root, "src/.aruna");
    write(root, {
      "src/.aruna/shared/actions.client.generated.ts": "// client\n",
      // A hand-written file the user dropped in the generated dir (unusual, but
      // it must never be pruned — only owned/legacy paths are).
      "src/.aruna/notes.txt": "keep me\n",
    });

    const { pruned } = await reconcileOwnedArtifacts({
      generatedDirAbs: generatedDir,
      current: { generated: ["shared/actions.client.generated.ts"], runtime: [] },
    });

    expect(pruned).toEqual([]);
    expect(exists(path.join(generatedDir, "notes.txt"))).toBe(true);
  });

  it("preserves the vendored runtime across a --no-emit-runtime build", async () => {
    const root = makeTempRoot();
    const generatedDir = path.join(root, "src/.aruna");
    write(root, {
      "src/.aruna/shared/runtime/client.ts": "// vendored\n",
      "src/.aruna/shared/actions.client.generated.ts": "// client\n",
    });
    await reconcileOwnedArtifacts({
      generatedDirAbs: generatedDir,
      current: {
        generated: ["shared/actions.client.generated.ts"],
        runtime: ["shared/runtime/client.ts"],
      },
    });

    // Rebuild with runtime omitted: runtime must be carried forward, not pruned.
    const { pruned, manifest } = await reconcileOwnedArtifacts({
      generatedDirAbs: generatedDir,
      current: { generated: ["shared/actions.client.generated.ts"], runtime: undefined },
    });

    expect(pruned).toEqual([]);
    expect(manifest.runtime).toEqual(["shared/runtime/client.ts"]);
    expect(exists(path.join(generatedDir, "shared/runtime/client.ts"))).toBe(true);
  });

  it("writes the owned-file ledger", async () => {
    const root = makeTempRoot();
    const generatedDir = path.join(root, "src/.aruna");
    await reconcileOwnedArtifacts({
      generatedDirAbs: generatedDir,
      current: { generated: CURRENT_GENERATED, runtime: ["shared/runtime/client.ts"] },
    });

    expect(exists(path.join(generatedDir, OWNED_MANIFEST_FILE))).toBe(true);
    const manifest = await readOwnedManifest(generatedDir);
    expect(manifest?.layout).toBe("split-tree");
    expect(manifest?.runtime).toEqual(["shared/runtime/client.ts"]);
  });

  it("detectLegacyArtifacts only flags flat layout paths that exist", async () => {
    const root = makeTempRoot();
    const generatedDir = path.join(root, "src/.aruna");
    write(root, {
      "src/.aruna/actions.client.generated.ts": "// old\n",
      "src/.aruna/runtime/client.ts": "// old\n",
      "src/.aruna/shared/actions.client.generated.ts": "// new\n",
    });

    const legacy = await detectLegacyArtifacts(generatedDir);
    expect(legacy.sort()).toEqual(["actions.client.generated.ts", "runtime"]);
  });
});

describe("owned-artifacts: layout desync diagnostics", () => {
  it("reports a stale generated artifact (aruna::110)", async () => {
    const root = makeTempRoot();
    write(root, {
      "aruna.config.ts": minimalConfig(),
      "tsconfig.json": `{\n  "compilerOptions": { "module": "ESNext", "baseUrl": "." }\n}\n`,
      // A flat legacy artifact left on disk.
      "src/.aruna/actions.client.generated.ts": "// stale\n",
    });

    const diagnostics = await collectLayoutDesyncDiagnostics({ projectRoot: root });
    const stale = diagnostics.find((diagnostic) => diagnostic.code === "aruna::110");
    expect(stale).toBeDefined();
    expect(stale?.severity).toBe("warning");
    expect(stale?.file).toBe("src/.aruna/actions.client.generated.ts");
  });

  it("reports a tsconfig alias that points at a stale emit path (aruna::111)", async () => {
    const root = makeTempRoot();
    write(root, {
      "aruna.config.ts": minimalConfig(),
      // Aliases still point at the OLD flat layout.
      "tsconfig.json": `{\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": {\n      "$aruna/actions/client": ["src/.aruna/actions.client.generated.ts"],\n      "aruna/client": ["src/.aruna/runtime/client.ts"]\n    }\n  }\n}\n`,
    });

    const diagnostics = await collectLayoutDesyncDiagnostics({ projectRoot: root });
    const desync = diagnostics.find((diagnostic) => diagnostic.code === "aruna::111");
    expect(desync).toBeDefined();
    expect(desync?.details).toContain("$aruna/actions/client");
    expect(desync?.details).toContain("aruna/client");
  });

  it("is silent when the layout is in sync", async () => {
    const root = makeTempRoot();
    write(root, {
      "aruna.config.ts": minimalConfig(),
      "tsconfig.json": `{\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": {\n      "$aruna/actions/client": ["src/.aruna/shared/actions.client.generated.ts"],\n      "aruna/client": ["src/.aruna/shared/runtime/client.ts"]\n    }\n  }\n}\n`,
    });

    const diagnostics = await collectLayoutDesyncDiagnostics({ projectRoot: root });
    expect(diagnostics).toEqual([]);
  });

  it("does not flag a merely missing alias as a desync", async () => {
    const root = makeTempRoot();
    write(root, {
      "aruna.config.ts": minimalConfig(),
      "tsconfig.json": `{\n  "compilerOptions": { "baseUrl": ".", "paths": {} }\n}\n`,
    });

    const diagnostics = await collectLayoutDesyncDiagnostics({ projectRoot: root });
    expect(diagnostics.filter((diagnostic) => diagnostic.code === "aruna::111")).toEqual([]);
  });
});
