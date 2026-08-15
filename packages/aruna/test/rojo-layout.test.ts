import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectAmbientDeclarations,
  layoutTargetFor,
  partitionedRojoProject,
  readInheritedCompilerOptions,
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
