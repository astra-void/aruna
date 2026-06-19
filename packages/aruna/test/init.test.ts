import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/cli/init.ts";

describe("aruna init", () => {
  it("scaffolds config files with action and runtime aliases", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-init-"));
    try {
      const result = runInit({ projectRoot: root });
      expect(result.created.sort()).toEqual([
        "aruna.config.ts",
        "default.project.json",
        "tsconfig.json",
      ]);

      const tsconfig = JSON.parse(await fs.readFile(path.join(root, "tsconfig.json"), "utf8")) as {
        compilerOptions: { paths: Record<string, string[]> };
      };
      const paths = tsconfig.compilerOptions.paths;
      expect(paths["aruna/server"]).toEqual(["src/.aruna/runtime/server.ts"]);
      expect(paths["aruna/schema"]).toEqual(["src/.aruna/runtime/schema.ts"]);
      expect(paths["$aruna/actions/server"]).toEqual([
        "src/.aruna/actions.server.generated.ts",
      ]);

      const project = JSON.parse(
        await fs.readFile(path.join(root, "default.project.json"), "utf8"),
      ) as { tree: { ReplicatedStorage: { TS: { $path: string } } } };
      expect(project.tree.ReplicatedStorage.TS.$path).toBe("out");
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
        "tsconfig.json",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
