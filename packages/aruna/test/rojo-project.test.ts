import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectRojoPaths,
  formatRojoProjectProblem,
  inspectRojoProject,
} from "../src/cli/rojo-project.ts";
import { partitionedRojoProject } from "../src/cli/rojo-layout.ts";

async function makeProject(contents?: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-rojo-project-"));
  if (contents !== undefined) {
    await fs.writeFile(path.join(root, "default.project.json"), contents, "utf8");
  }
  return root;
}

// The project file `rojo init` scaffolds: Luau sources mounted straight off
// src/, nothing pointing at the compiled out/ tree.
const ROJO_INIT_PROJECT = JSON.stringify({
  name: "basic-rojo",
  tree: {
    $className: "DataModel",
    ReplicatedStorage: { Shared: { $path: "src/shared" } },
    ServerScriptService: { Server: { $path: "src/server" } },
    StarterPlayer: { StarterPlayerScripts: { Client: { $path: "src/client" } } },
  },
});

describe("collectRojoPaths", () => {
  it("finds every $path at any depth", () => {
    expect(collectRojoPaths(JSON.parse(ROJO_INIT_PROJECT)).sort()).toEqual([
      "src/client",
      "src/server",
      "src/shared",
    ]);
  });

  it("normalizes leading ./ and trailing slashes", () => {
    expect(collectRojoPaths({ tree: { A: { $path: "./out/server/" } } })).toEqual(["out/server"]);
  });

  it("reads the optional-path object form", () => {
    expect(collectRojoPaths({ tree: { A: { $path: { optional: "out/client" } } } })).toEqual([
      "out/client",
    ]);
  });
});

describe("inspectRojoProject", () => {
  it("accepts the project aruna init scaffolds", async () => {
    const root = await makeProject(JSON.stringify(partitionedRojoProject()));
    try {
      const report = inspectRojoProject(root);
      expect(report.status).toBe("aligned");
      expect(report.absent).toEqual([]);
      expect(formatRojoProjectProblem(report)).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("flags a stock rojo init project that mounts no out/ partition", async () => {
    const root = await makeProject(ROJO_INIT_PROJECT);
    try {
      const report = inspectRojoProject(root);
      expect(report.status).toBe("incomplete");
      expect(report.present).toEqual([]);
      expect(report.absent).toEqual(["out/client", "out/server", "out/shared", "include"]);
      // This is the silent failure: without this warning the place builds empty.
      expect(formatRojoProjectProblem(report).join("\n")).toContain("does not mount");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("flags a partially mounted project", async () => {
    const root = await makeProject(
      JSON.stringify({
        tree: {
          ServerScriptService: { TS: { $path: "out/server" } },
          ReplicatedStorage: { TS: { $path: "out/shared" }, rbxts_include: { $path: "include" } },
        },
      }),
    );
    try {
      const report = inspectRojoProject(root);
      expect(report.status).toBe("incomplete");
      expect(report.absent).toEqual(["out/client"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("counts a wholesale out/ mount as covering every partition", async () => {
    const root = await makeProject(
      JSON.stringify({ tree: { ReplicatedStorage: { TS: { $path: "out" }, I: { $path: "include" } } } }),
    );
    try {
      expect(inspectRojoProject(root).status).toBe("aligned");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports a missing project file", async () => {
    const root = await makeProject();
    try {
      const report = inspectRojoProject(root);
      expect(report.status).toBe("missing");
      expect(formatRojoProjectProblem(report).join("\n")).toContain("no Rojo project file found");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("inspects a project file that does not use the default name", async () => {
    const root = await makeProject();
    try {
      await fs.writeFile(
        path.join(root, "game.project.json"),
        JSON.stringify(partitionedRojoProject()),
        "utf8",
      );
      const report = inspectRojoProject(root);
      expect(report.path).toBe("game.project.json");
      expect(report.status).toBe("aligned");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports an unparseable project file", async () => {
    const root = await makeProject("{ not json");
    try {
      const report = inspectRojoProject(root);
      expect(report.status).toBe("unreadable");
      expect(formatRojoProjectProblem(report).join("\n")).toContain("could not be parsed");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
