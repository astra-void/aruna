import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  OWNED_MANIFEST_FILE,
  collectLayoutDesyncDiagnostics,
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
      // it must never be pruned — only owned paths are).
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

  it("prunes the tsconfig fragment older builds generated", async () => {
    const root = makeTempRoot();
    const generatedDir = path.join(root, "src/.aruna");
    write(root, {
      "src/.aruna/tsconfig.aruna.json": "{}\n",
      "src/.aruna/shared/actions.client.generated.ts": "// client\n",
    });
    // The ledger an older build left: it owned the fragment.
    await reconcileOwnedArtifacts({
      generatedDirAbs: generatedDir,
      current: {
        generated: ["tsconfig.aruna.json", "shared/actions.client.generated.ts"],
        runtime: [],
      },
    });

    const { pruned } = await reconcileOwnedArtifacts({
      generatedDirAbs: generatedDir,
      current: { generated: ["shared/actions.client.generated.ts"], runtime: [] },
    });

    expect(pruned).toEqual(["tsconfig.aruna.json"]);
    expect(exists(path.join(generatedDir, "tsconfig.aruna.json"))).toBe(false);
  });
});

describe("owned-artifacts: layout desync diagnostics", () => {
  it("reports a tsconfig alias that points at a stale emit path (aruna::111)", async () => {
    const root = makeTempRoot();
    write(root, {
      "aruna.config.ts": minimalConfig(),
      // Aliases point at paths the current layout does not emit.
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

  it("is silent for the relative aliases the upkeep writes, with no baseUrl", async () => {
    const root = makeTempRoot();
    write(root, {
      "aruna.config.ts": minimalConfig(),
      "tsconfig.json": `{\n  "compilerOptions": {\n    "paths": {\n      "$aruna/actions/client": ["./src/.aruna/shared/actions.client.generated.ts"],\n      "aruna/client": ["./src/.aruna/shared/runtime/client.ts"]\n    }\n  }\n}\n`,
    });

    const diagnostics = await collectLayoutDesyncDiagnostics({ projectRoot: root });
    expect(diagnostics).toEqual([]);
  });

  it("resolves an inherited alias against the config that declares it", async () => {
    const root = makeTempRoot();
    write(root, {
      "aruna.config.ts": minimalConfig(),
      // Without a baseUrl, TypeScript resolves these against config/, so they
      // reach the generated files.
      "config/tsconfig.base.json": `{\n  "compilerOptions": {\n    "paths": {\n      "$aruna/actions/client": ["../src/.aruna/shared/actions.client.generated.ts"],\n      "$aruna/signals": ["./src/.aruna/shared/signals.generated.ts"]\n    }\n  }\n}\n`,
      "tsconfig.json": `{ "extends": "./config/tsconfig.base.json" }\n`,
    });

    const diagnostics = await collectLayoutDesyncDiagnostics({ projectRoot: root });
    // Only $aruna/signals misses: from config/ it points at config/src/.aruna.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.details).toBe(
      "$aruna/signals -> ./src/.aruna/shared/signals.generated.ts (in config/tsconfig.base.json; " +
        "expected ./src/.aruna/shared/signals.generated.ts in tsconfig.json)",
    );
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

  it("reports a tsconfig that still extends the retired generated fragment", async () => {
    const root = makeTempRoot();
    write(root, {
      "aruna.config.ts": minimalConfig(),
      "tsconfig.json": `{\n  "extends": "./src/.aruna/tsconfig.aruna.json",\n  "compilerOptions": {}\n}\n`,
    });

    const diagnostics = await collectLayoutDesyncDiagnostics({ projectRoot: root });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("aruna::111");
    expect(diagnostics[0]?.message).toContain("src/.aruna/tsconfig.aruna.json");
    expect(diagnostics[0]?.suggestion).toContain("aruna build");
  });
});
