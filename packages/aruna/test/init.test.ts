import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatInitReport, runInit } from "../src/cli/init.ts";
import { stripJsonComments } from "./support/jsonc.ts";

// What `rojo init` leaves behind: Luau sources mounted off src/, nothing
// pointing at the compiled out/ tree.
const ROJO_INIT_PROJECT = `${JSON.stringify(
  {
    name: "basic-rojo",
    tree: {
      $className: "DataModel",
      ReplicatedStorage: { Shared: { $path: "src/shared" } },
      ServerScriptService: { Server: { $path: "src/server" } },
    },
  },
  null,
  2,
)}\n`;

describe("aruna init", () => {
  it("scaffolds an extends-managed tsconfig plus the generated alias fragment", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-init-"));
    try {
      const result = runInit({ projectRoot: root });
      expect(result.created.sort()).toEqual([
        "aruna.config.ts",
        "default.project.json",
        "src/.aruna/node_modules.project.json",
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
          ReplicatedStorage: {
            TS: { $path: string };
            rbxts_include: { node_modules: { $path?: string } };
          };
          StarterPlayer: { StarterPlayerScripts: { TS: { $path: string } } };
        };
      };
      // node_modules is mounted through the generated nested project, so adding
      // a Roblox-facing dependency never means editing this file.
      expect(project.tree.ReplicatedStorage.rbxts_include.node_modules.$path).toBe(
        "src/.aruna/node_modules.project.json",
      );
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
        "src/.aruna/node_modules.project.json",
        "src/.aruna/tsconfig.aruna.json",
        "tsconfig.json",
      ]);
      // Its own scaffolded project file is aligned, so no warning fires.
      expect(second.rojoProject.status).toBe("aligned");
      expect(formatInitReport(second)).not.toContain("warning");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("warns when it keeps a rojo project that never mounts out/", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-init-"));
    try {
      await fs.writeFile(path.join(root, "default.project.json"), ROJO_INIT_PROJECT, "utf8");
      const result = runInit({ projectRoot: root });

      expect(result.skipped).toEqual(["default.project.json"]);
      expect(result.rojoProject.status).toBe("incomplete");
      expect(result.rojoProject.present).toEqual([]);

      // Without this the whole pipeline exits 0 and the built place is empty.
      const report = formatInitReport(result);
      expect(report).toContain("warning");
      expect(report).toContain("does not mount");
      expect(report).toContain("aruna init --force");

      // The user's project file is left untouched without --force.
      expect(await fs.readFile(path.join(root, "default.project.json"), "utf8")).toBe(
        ROJO_INIT_PROJECT,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("replaces an unmounted rojo project under --force", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-init-"));
    try {
      await fs.writeFile(path.join(root, "default.project.json"), ROJO_INIT_PROJECT, "utf8");
      const result = runInit({ projectRoot: root, force: true });

      expect(result.overwritten).toEqual(["default.project.json"]);
      expect(result.skipped).toEqual([]);
      expect(result.rojoProject.status).toBe("aligned");
      expect(formatInitReport(result)).toContain("overwritten (--force)");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
