import { describe, expect, it } from "vitest";
import {
  layoutTargetFor,
  partitionedRojoProject,
  stagePathFor,
  stagedIncludeGlobs,
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
