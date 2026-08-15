import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectProject } from "@arunajs/compiler";
import { buildStoreInspectionReport, formatStoreInspection } from "../src/cli/inspect-stores.js";

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aruna-store-"));
}

function writeProject(root: string, files: Record<string, string>): void {
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents, "utf8");
  }
}

const tsconfig = `{
  "compilerOptions": {
    "module": "ESNext"
  }
}
`;

describe("store discovery", () => {
  it("records stores in the manifest and the inspect report", async () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": tsconfig,
      "src/domains/economy/store.ts": `
import { definePlayerStore } from "aruna/server";
import { schema } from "aruna/schema";

export const profile = definePlayerStore({
  id: "player.profile",
  version: 2,
  schema: schema.object({ coins: schema.u32() }),
  defaultValue: () => ({ coins: 0 }),
  migrate: (stored, from) => (from === 1 ? { coins: 0 } : undefined),
});
`,
      "src/domains/settings/store.ts": `
import { defineStore } from "aruna/server";
import { schema } from "aruna/schema";

export const settings = defineStore({
  id: "game.settings",
  scope: "live",
  schema: schema.object({ doubleCoins: schema.boolean() }),
  defaultValue: { doubleCoins: false },
});
`,
    });

    const output = await inspectProject({ root });
    const stores = output.manifest.stores ?? [];
    expect(stores.map((store) => store.id)).toEqual(["game.settings", "player.profile"]);

    const profile = stores.find((store) => store.id === "player.profile");
    expect(profile?.kind).toBe("playerStore");
    expect(profile?.version).toBe(2);
    expect(profile?.hasMigrate).toBe(true);

    const settings = stores.find((store) => store.id === "game.settings");
    expect(settings?.kind).toBe("store");
    expect(settings?.scope).toBe("live");
    expect(settings?.version).toBe(1);

    const report = buildStoreInspectionReport(output);
    expect(report.stores).toHaveLength(2);
    expect(report.stores[0]?.schema).toContain("doubleCoins");

    const rendered = formatStoreInspection(output, "never");
    expect(rendered).toContain("aruna inspect stores");
    expect(rendered).toContain("player store (session locked)");
  });

  it("classifies a store module as server-only", async () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": tsconfig,
      "src/domains/economy/store.ts": `
import { defineStore } from "aruna/server";
import { schema } from "aruna/schema";

export const bank = defineStore({
  id: "game.bank",
  schema: schema.object({ total: schema.u32() }),
  defaultValue: { total: 0 },
});
`,
    });

    const output = await inspectProject({ root });
    const module = output.manifest.modules.find(
      (entry) => entry.path === "src/domains/economy/store.ts",
    );
    expect(module?.kind).toBe("serverStore");
    expect(module?.reasonDetail).toContain("defineStore");
  });

  it("reports a client module that imports a store", async () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": tsconfig,
      "src/domains/economy/store.ts": `
import { defineStore } from "aruna/server";
import { schema } from "aruna/schema";

export const bank = defineStore({
  id: "game.bank",
  schema: schema.object({ total: schema.u32() }),
  defaultValue: { total: 0 },
});
`,
      "src/client.tsx": `
import { bank } from "./domains/economy/store";

export const id = bank.id;
`,
    });

    const output = await inspectProject({ root });
    const violation = output.diagnostics.find((diagnostic) => diagnostic.code === "aruna::574");
    expect(violation?.name).toBe("store-imported-from-client");
    expect(violation?.severity).toBe("error");
    expect(violation?.suggestion).toContain("server");
  });

  it("reports a duplicated store id across files", async () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": tsconfig,
      "src/domains/a/store.ts": `
import { defineStore } from "aruna/server";
import { schema } from "aruna/schema";

export const first = defineStore({
  id: "game.shared",
  schema: schema.object({ total: schema.u32() }),
  defaultValue: { total: 0 },
});
`,
      "src/domains/b/store.ts": `
import { defineStore } from "aruna/server";
import { schema } from "aruna/schema";

export const second = defineStore({
  id: "game.shared",
  schema: schema.object({ total: schema.u32() }),
  defaultValue: { total: 0 },
});
`,
    });

    const output = await inspectProject({ root });
    const duplicate = output.diagnostics.find((diagnostic) => diagnostic.code === "aruna::573");
    expect(duplicate?.name).toBe("duplicate-store-id");
    expect(duplicate?.severity).toBe("error");
  });

  it("omits stores from the manifest when none are declared", async () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": tsconfig,
      "src/shared/util.ts": `export const value = 1;\n`,
    });

    const output = await inspectProject({ root });
    expect(output.manifest.stores ?? []).toEqual([]);
  });
});
