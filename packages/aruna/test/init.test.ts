import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/cli/init.ts";
import { stripJsonComments } from "./support/jsonc.ts";

describe("aruna init", () => {
  it("scaffolds an extends-managed tsconfig plus the generated alias fragment", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-init-"));
    try {
      const result = runInit({ projectRoot: root });
      expect(result.created.sort()).toEqual([
        "aruna.config.ts",
        "default.project.json",
        "src/.aruna/tsconfig.aruna.json",
        "tsconfig.json",
      ]);

      // The scaffolded tsconfig holds no inline aruna aliases — it extends the
      // generated fragment, so codegen-layout changes can never desync it.
      const tsconfig = JSON.parse(await fs.readFile(path.join(root, "tsconfig.json"), "utf8")) as {
        extends: string;
        include: string[];
        compilerOptions: { paths?: Record<string, string[]> };
      };
      expect(tsconfig.extends).toBe("./src/.aruna/tsconfig.aruna.json");
      expect(tsconfig.compilerOptions.paths).toBeUndefined();

      // The dot-prefixed generated dir is named explicitly — TypeScript's
      // wildcard globs skip it, which would leave the generated entry scripts
      // untypechecked by `aruna check` and the IDE.
      expect(tsconfig.include).toContain("src/.aruna/**/*.ts");
      expect(tsconfig.include).toContain("src/.aruna/**/*.tsx");

      const fragment = JSON.parse(
        stripJsonComments(
          await fs.readFile(path.join(root, "src/.aruna/tsconfig.aruna.json"), "utf8"),
        ),
      ) as {
        compilerOptions: { baseUrl: string; paths: Record<string, string[]> };
      };
      expect(fragment.compilerOptions.baseUrl).toBe("../..");
      const paths = fragment.compilerOptions.paths;
      expect(paths["aruna/server"]).toEqual(["src/.aruna/shared/runtime/server.ts"]);
      expect(paths["aruna/schema"]).toEqual(["src/.aruna/shared/runtime/schema.ts"]);
      expect(paths["$aruna/actions/server"]).toEqual([
        "src/.aruna/server/actions.server.generated.ts",
      ]);
      expect(paths["$aruna/signals"]).toEqual(["src/.aruna/shared/signals.generated.ts"]);

      const project = JSON.parse(
        await fs.readFile(path.join(root, "default.project.json"), "utf8"),
      ) as {
        tree: {
          ServerScriptService: { TS: { $path: string } };
          ReplicatedStorage: { TS: { $path: string } };
          StarterPlayer: { StarterPlayerScripts: { TS: { $path: string } } };
        };
      };
      // The scaffolded project maps the partitioned out/ onto the DataModel:
      // server code is NOT replicated to clients.
      expect(project.tree.ServerScriptService.TS.$path).toBe("out/server");
      expect(project.tree.ReplicatedStorage.TS.$path).toBe("out/shared");
      expect(project.tree.StarterPlayer.StarterPlayerScripts.TS.$path).toBe("out/client");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps existing files on re-run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-init-"));
    try {
      runInit({ projectRoot: root });
      const second = runInit({ projectRoot: root });
      expect(second.created).toEqual([]);
      expect(second.skipped.sort()).toEqual([
        "aruna.config.ts",
        "default.project.json",
        "src/.aruna/tsconfig.aruna.json",
        "tsconfig.json",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
