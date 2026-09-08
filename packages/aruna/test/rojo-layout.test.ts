import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Manifest } from "@arunajs/core";
import {
  collectAmbientDeclarations,
  layoutTargetFor,
  partitionedRojoProject,
  readInheritedCompilerOptions,
  stagePartition,
  stagePathFor,
  stagedCompilerOptions,
  stagedIncludeGlobs,
  stripJsonComments,
} from "../src/cli/rojo-layout.js";

describe("layoutTargetFor", () => {
  it("routes modules to their service partition by classification", () => {
    expect(layoutTargetFor("src/domains/shop/ui.tsx", "client", ".aruna")).toBe("client");
    expect(layoutTargetFor("src/client.tsx", "clientEntry", ".aruna")).toBe("client");
    expect(layoutTargetFor("src/domains/shop/actions.ts", "serverAction", ".aruna")).toBe("server");
    expect(layoutTargetFor("src/domains/waves/runtime.ts", "server", ".aruna")).toBe("server");
    expect(layoutTargetFor("src/server.ts", "serverEntry", ".aruna")).toBe("server");
    expect(layoutTargetFor("src/domains/shop/schema.ts", "shared", ".aruna")).toBe("shared");
    // A spec goes to its own partition, which no game build ever stages.
    expect(layoutTargetFor("src/domains/shop/server/pricing.test.ts", "test", ".aruna")).toBe(
      "test",
    );
  });

  it("keeps store modules out of the replicated partition", () => {
    // A store module carries the DataStore name and the persistence code. In
    // the shared partition it would be replicated to every client, which the
    // import-level boundary rules cannot catch — nothing has to import it for
    // the file itself to ship.
    expect(layoutTargetFor("src/domains/economy/store.ts", "serverStore", ".aruna")).toBe("server");
  });

  it("keeps the server action registry server-side and other generated files shared", () => {
    // The server stub imports server implementations — it must NOT be replicated.
    expect(layoutTargetFor("src/.aruna/actions.server.generated.ts", "serverAction", ".aruna")).toBe(
      "server",
    );
    // Client stub + signal registry are client-importable → shared.
    expect(layoutTargetFor("src/.aruna/actions.client.generated.ts", "client", ".aruna")).toBe(
      "shared",
    );
    expect(layoutTargetFor("src/.aruna/signals.generated.ts", "shared", ".aruna")).toBe("shared");
  });

  it("routes split-tree generated files by their partition subtree", () => {
    expect(
      layoutTargetFor("src/.aruna/server/actions.server.generated.ts", "serverAction", ".aruna"),
    ).toBe("server");
    expect(layoutTargetFor("src/.aruna/server/main.server.ts", "server", ".aruna")).toBe("server");
    expect(layoutTargetFor("src/.aruna/client/main.client.ts", "client", ".aruna")).toBe("client");
    expect(
      layoutTargetFor("src/.aruna/shared/actions.client.generated.ts", "client", ".aruna"),
    ).toBe("shared");
    expect(layoutTargetFor("src/.aruna/shared/signals.generated.ts", "shared", ".aruna")).toBe(
      "shared",
    );
  });
});

describe("stagePathFor", () => {
  it("renames entry modules to *.client/*.server and partitions the rest", () => {
    expect(stagePathFor("src/client.tsx", "clientEntry", "client")).toBe("client/main.client.tsx");
    expect(stagePathFor("src/server.ts", "serverEntry", "server")).toBe("server/main.server.ts");
    expect(stagePathFor("src/domains/shop/actions.ts", "serverAction", "server")).toBe(
      "server/domains/shop/actions.ts",
    );
    expect(stagePathFor("src/shared/result.ts", "shared", "shared")).toBe("shared/shared/result.ts");
  });
});

describe("stagedIncludeGlobs", () => {
  it("names the generated dir so a dot-prefixed one still compiles", () => {
    // `src/**/*.ts` alone never matches a dot-prefixed segment — without the
    // explicit globs the generated entry scripts are dropped from the program
    // and the built place ends up with no Script/LocalScript.
    expect(stagedIncludeGlobs(".aruna")).toEqual([
      "src/**/*.ts",
      "src/**/*.tsx",
      "src/*/.aruna/**/*.ts",
      "src/*/.aruna/**/*.tsx",
    ]);
  });

  it("follows a custom generated dir", () => {
    expect(stagedIncludeGlobs("generated")).toContain("src/*/generated/**/*.ts");
  });
});

describe("partitionedRojoProject", () => {
  it("maps each partition onto the right Roblox service", () => {
    const project = partitionedRojoProject() as {
      tree: {
        ServerScriptService: { TS: { $path: string } };
        ReplicatedStorage: { TS: { $path: string } };
        StarterPlayer: { StarterPlayerScripts: { TS: { $path: string } } };
      };
    };
    expect(project.tree.ServerScriptService.TS.$path).toBe("out/server");
    expect(project.tree.ReplicatedStorage.TS.$path).toBe("out/shared");
    expect(project.tree.StarterPlayer.StarterPlayerScripts.TS.$path).toBe("out/client");
    expect(
      (project.tree.ServerScriptService as Record<string, unknown>)["ArunaTests"],
    ).toBeUndefined();
  });

  it("mounts the compiled specs only for a test run", () => {
    // rbxtsc resolves every import through this project file, so a spec that is
    // being compiled needs a mount — and a place that is being built must not
    // have one.
    const project = partitionedRojoProject({ includeTests: true }) as {
      tree: { ServerScriptService: Record<string, { $path: string }> };
    };
    expect(project.tree.ServerScriptService["ArunaTests"]?.$path).toBe("out/test");
  });
});

describe("staged tsconfig inheritance", () => {
  it("strips comments but keeps them inside strings", () => {
    expect(stripJsonComments('{ // note\n "a": "http://x", /* b */ "c": 1 }')).toContain(
      '"a": "http://x"',
    );
    expect(stripJsonComments('{ // note\n "c": 1 }')).not.toContain("note");
  });

  it("reads compilerOptions through the extends chain, nearest wins", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aruna-tsconfig-"));
    try {
      fs.writeFileSync(
        path.join(root, "base.json"),
        '{ "compilerOptions": { "strict": true, "jsx": "preserve", "target": "ES2015" } }',
      );
      fs.writeFileSync(
        path.join(root, "tsconfig.json"),
        `{
          // a real project comments its tsconfig
          "extends": "./base.json",
          "compilerOptions": {
            "jsx": "react",
            "plugins": [{ "transform": "vela-rbxts/transformer" }]
          }
        }`,
      );

      const options = readInheritedCompilerOptions(path.join(root, "tsconfig.json"));
      expect(options["jsx"]).toBe("react");
      expect(options["strict"]).toBe(true);
      expect(options["target"]).toBe("ES2015");
      // Transformers must survive: dropping them compiles the project without
      // the transform it depends on.
      expect(options["plugins"]).toEqual([{ transform: "vela-rbxts/transformer" }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops inherited options that describe the consumer's tree, not the staged one", () => {
    const merged = stagedCompilerOptions(
      {
        jsx: "react",
        plugins: [{ transform: "t" }],
        rootDir: "src",
        outDir: "out",
        baseUrl: "src",
        paths: { "@app/*": ["app/*"] },
        incremental: true,
        tsBuildInfoFile: "out/tsconfig.tsbuildinfo",
      },
      { rootDir: "src", outDir: "out", baseUrl: ".", paths: { "$aruna/signals": ["x.ts"] } },
    );

    expect(merged["jsx"]).toBe("react");
    expect(merged["plugins"]).toEqual([{ transform: "t" }]);
    expect(merged["baseUrl"]).toBe(".");
    expect(merged["paths"]).toEqual({ "$aruna/signals": ["x.ts"] });
    // Writing a tsbuildinfo would land in the consumer's out/ from a temp build.
    expect(merged["incremental"]).toBeUndefined();
    expect(merged["tsBuildInfoFile"]).toBeUndefined();
  });
});

describe("collectAmbientDeclarations", () => {
  it("finds .d.ts files the module manifest never lists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aruna-ambient-"));
    try {
      fs.mkdirSync(path.join(root, "client", "ui"), { recursive: true });
      fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
      fs.writeFileSync(path.join(root, "env.d.ts"), 'import "vela-rbxts";\n');
      fs.writeFileSync(path.join(root, "client", "ui", "jsx.d.ts"), "export {};\n");
      fs.writeFileSync(path.join(root, "client", "ui", "app.tsx"), "export {};\n");
      fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.d.ts"), "export {};\n");

      expect(collectAmbientDeclarations(root)).toEqual(["client/ui/jsx.d.ts", "env.d.ts"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("readInheritedCompilerOptions typeRoots", () => {
  it("rebases an extended config's relative typeRoots onto the root config", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aruna-inherit-"));
    try {
      fs.mkdirSync(path.join(root, "src/.aruna"), { recursive: true });
      // What the generated fragment writes: paths anchored on its own directory.
      fs.writeFileSync(
        path.join(root, "src/.aruna/tsconfig.aruna.json"),
        JSON.stringify({
          compilerOptions: { typeRoots: ["../../node_modules", "../../node_modules/@rbxts"] },
        }),
      );
      fs.writeFileSync(
        path.join(root, "tsconfig.json"),
        JSON.stringify({ extends: "./src/.aruna/tsconfig.aruna.json", compilerOptions: {} }),
      );

      const options = readInheritedCompilerOptions(path.join(root, "tsconfig.json"));
      // Anchored on the project root, which is what the staged node_modules
      // mirror reproduces — `../../node_modules` would climb out of the temp tree.
      expect(options["typeRoots"]).toEqual(["./node_modules", "./node_modules/@rbxts"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("staging the test partition", () => {
  // A minimal project on disk: stagePartition needs a node_modules to mirror, a
  // tsconfig to inherit from, and the sources the manifest lists.
  function makeProject(): { root: string; manifest: Manifest } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aruna-stage-test-"));
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n", "utf8");

    const write = (relative: string, contents: string): void => {
      const absolute = path.join(root, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, contents, "utf8");
    };
    write("src/domains/shop/server/pricing.ts", "export const priceOf = 1;\n");
    write("src/domains/shop/server/pricing.test.ts", "export const spec = 1;\n");
    // The vendored runtime, including the test surface `aruna build` writes to
    // disk so `aruna/testing` resolves in an editor.
    write("src/.aruna/shared/runtime/server.ts", "export const server = 1;\n");
    write("src/.aruna/shared/runtime/testing.ts", "export const testing = 1;\n");
    write("src/.aruna/shared/runtime/testing-framework.ts", "export const framework = 1;\n");

    const manifest: Manifest = {
      version: 1,
      projectRoot: root,
      modules: [
        {
          id: "src/domains/shop/server/pricing.ts",
          path: "src/domains/shop/server/pricing.ts",
          kind: "server",
          reason: "path",
        },
        {
          id: "src/domains/shop/server/pricing.test.ts",
          path: "src/domains/shop/server/pricing.test.ts",
          kind: "test",
          reason: "path",
        },
      ],
      imports: [],
      actions: [],
      diagnostics: [],
    };
    return { root, manifest };
  }

  const stagedFiles = (root: string, manifest: Manifest, includeTests: boolean): string[] => {
    const result = stagePartition({
      projectRoot: root,
      generatedDir: "src/.aruna",
      manifest,
      rbxtscBin: "rbxtsc",
      ...(includeTests ? { includeTests: true } : {}),
    });
    if (!result.ok) {
      throw new Error(`staging failed: ${result.reason}`);
    }
    const staged: string[] = [];
    const walk = (directory: string, prefix: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const next = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(path.join(directory, entry.name), next);
        } else {
          staged.push(next);
        }
      }
    };
    walk(path.join(result.staged.tempRoot, "src"), "");
    fs.rmSync(result.staged.tempRoot, { recursive: true, force: true });
    return staged;
  };

  it("leaves specs and the test runtime out of a game build", () => {
    const { root, manifest } = makeProject();
    const staged = stagedFiles(root, manifest, false);

    expect(staged).toContain("server/domains/shop/server/pricing.ts");
    // Nothing in the place should be able to reach a spec — the surest way is
    // for it never to be compiled.
    expect(staged.some((file) => file.includes("pricing.test"))).toBe(false);
    // The test framework is vendored to disk but must not be replicated to
    // every client along with the rest of the shared runtime.
    expect(staged).toContain("shared/.aruna/runtime/server.ts");
    expect(staged.some((file) => file.includes("runtime/testing"))).toBe(false);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("stages specs into their own partition for a test run", () => {
    const { root, manifest } = makeProject();
    const staged = stagedFiles(root, manifest, true);

    expect(staged).toContain("test/domains/shop/server/pricing.test.ts");
    expect(staged).toContain("server/domains/shop/server/pricing.ts");
    expect(staged).toContain("shared/.aruna/runtime/testing.ts");
    expect(staged).toContain("shared/.aruna/runtime/testing-framework.ts");

    fs.rmSync(root, { recursive: true, force: true });
  });
});
