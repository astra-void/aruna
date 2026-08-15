import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  arunaNodeModulesProjectContents,
  discoverRobloxScopes,
  inspectNodeModulesMounts,
  isRobloxFacingPackage,
  nodeModulesProjectMount,
} from "../src/cli/rojo-node-modules.ts";

async function writeFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

// A node_modules holding one package of each shape a real rbxts project sees:
// Luau at the package root, Luau under out/, a build-time-only package, and a
// scope with no Luau anywhere.
async function scaffoldNodeModules(root: string): Promise<void> {
  const nm = path.join(root, "node_modules");
  await writeFile(path.join(nm, "@rbxts/services/init.lua"), "return {}\n");
  await writeFile(path.join(nm, "@rbxts/types/include/roblox.d.ts"), "export {};\n");
  await writeFile(path.join(nm, "@lattice-ui/react-dialog/out/init.luau"), "return {}\n");
  await writeFile(path.join(nm, "@facet-ui/theme/dist/index.js"), "module.exports = {};\n");
  await writeFile(path.join(nm, "@types/node/index.d.ts"), "export {};\n");
}

describe("isRobloxFacingPackage", () => {
  it("accepts packages shipping Luau and rejects build-time-only ones", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-nm-"));
    try {
      await scaffoldNodeModules(root);
      const nm = path.join(root, "node_modules");
      expect(isRobloxFacingPackage(path.join(nm, "@rbxts/services"))).toBe(true);
      expect(isRobloxFacingPackage(path.join(nm, "@lattice-ui/react-dialog"))).toBe(true);
      expect(isRobloxFacingPackage(path.join(nm, "@facet-ui/theme"))).toBe(false);
      expect(isRobloxFacingPackage(path.join(nm, "@types/node"))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("ignores Luau inside a package's own nested node_modules", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-nm-"));
    try {
      await writeFile(
        path.join(root, "node_modules/@tool/bundler/node_modules/dep/init.lua"),
        "return {}\n",
      );
      expect(isRobloxFacingPackage(path.join(root, "node_modules/@tool/bundler"))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("discoverRobloxScopes", () => {
  it("mounts a fully Roblox-facing scope wholesale and a mixed one per package", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-nm-"));
    try {
      await scaffoldNodeModules(root);
      expect(discoverRobloxScopes(root)).toEqual([
        // Every package in @lattice-ui ships Luau, so the scope directory is the
        // mount and a package added to it later needs no regeneration to work.
        { scope: "@lattice-ui", packages: [] },
        // @rbxts is mixed: types/ ships only declarations, so mounting the scope
        // would put it in the DataModel as an empty Folder.
        { scope: "@rbxts", packages: [{ name: "services", directory: "services" }] },
      ]);
      // @facet-ui holds no Luau package at all and drops out entirely.
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("names a per-package mount the way rojo would", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-nm-"));
    try {
      await scaffoldNodeModules(root);
      // Rojo takes the instance name from a mounted directory's own project
      // file, and roblox-ts resolves requires against that name — so an explicit
      // key has to reproduce it rather than use the directory name.
      await writeFile(
        path.join(root, "node_modules/@facet-ui/react-variants/out/init.lua"),
        "return {}\n",
      );
      await writeFile(
        path.join(root, "node_modules/@facet-ui/react-variants/default.project.json"),
        JSON.stringify({ name: "variants", tree: { $path: "out" } }),
      );

      const facet = discoverRobloxScopes(root).find((entry) => entry.scope === "@facet-ui");
      expect(facet?.packages).toEqual([{ name: "variants", directory: "react-variants" }]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns nothing when node_modules is absent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-nm-"));
    try {
      expect(discoverRobloxScopes(root)).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("arunaNodeModulesProjectContents", () => {
  it("points each scope back out of the generated dir", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-nm-"));
    try {
      await scaffoldNodeModules(root);
      const project = JSON.parse(arunaNodeModulesProjectContents(root, "src/.aruna")) as {
        tree: Record<string, { $path?: string; $className?: string } | string>;
      };
      expect(project.tree["$className"]).toBe("Folder");
      // Rojo resolves a nested project's paths relative to that file.
      expect(project.tree["@lattice-ui"]?.$path).toBe("../../node_modules/@lattice-ui");
      // Mixed scope: only the package that ships Luau is mounted, so the
      // declaration-only ones stay out of the DataModel.
      expect(project.tree["@rbxts"]).toEqual({
        $className: "Folder",
        services: { $path: "../../node_modules/@rbxts/services" },
      });
      expect(project.tree["@types"]).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("inspectNodeModulesMounts", () => {
  it("reports scopes a hand-written project file never mounts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-nm-"));
    try {
      await scaffoldNodeModules(root);
      const report = inspectNodeModulesMounts(root, "src/.aruna", [
        "out/server",
        "node_modules/@rbxts",
      ]);
      expect(report.managed).toBe(false);
      expect(report.missing).toEqual(["@lattice-ui"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("treats the generated project mount as covering every scope", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-nm-"));
    try {
      await scaffoldNodeModules(root);
      const report = inspectNodeModulesMounts(root, "src/.aruna", [
        nodeModulesProjectMount("src/.aruna"),
      ]);
      expect(report.managed).toBe(true);
      expect(report.missing).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a project that mounts node_modules wholesale", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-nm-"));
    try {
      await scaffoldNodeModules(root);
      const report = inspectNodeModulesMounts(root, "src/.aruna", ["node_modules"]);
      expect(report.missing).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
