import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@arunajs/core";
import {
  parseAddExtras,
  pascalCase,
  planDomainFiles,
  runAddDomain,
  validateDomainName,
} from "../src/cli/add.js";

describe("validateDomainName", () => {
  it("accepts identifier-safe segments", () => {
    for (const name of ["shop", "playerStats", "player-stats", "wave_2"]) {
      expect(validateDomainName(name)).toBeUndefined();
    }
  });

  it("rejects names unusable as directories or action-id prefixes", () => {
    for (const name of ["", "1shop", "shop.buy", "shop/inner", "shop item", "-shop"]) {
      expect(validateDomainName(name)).toBeDefined();
    }
  });
});

describe("parseAddExtras", () => {
  it("defaults to no extras", () => {
    expect(parseAddExtras(undefined)).toEqual({ extras: [] });
    expect(parseAddExtras("")).toEqual({ extras: [] });
  });

  it("parses and dedupes a comma-separated list", () => {
    expect(parseAddExtras("ui,runtime,ui")).toEqual({ extras: ["ui", "runtime"] });
    expect(parseAddExtras(" ui , runtime ")).toEqual({ extras: ["ui", "runtime"] });
  });

  it("rejects unknown parts", () => {
    const result = parseAddExtras("ui,tests");
    expect(result.error).toContain("tests");
  });
});

describe("pascalCase", () => {
  it("capitalizes and joins separator segments", () => {
    expect(pascalCase("shop")).toBe("Shop");
    expect(pascalCase("player-stats")).toBe("PlayerStats");
    expect(pascalCase("wave_two")).toBe("WaveTwo");
  });
});

describe("planDomainFiles", () => {
  it("emits the base trio, adding ui/runtime only when requested", () => {
    // The spec is part of the base scaffold: a new domain starts with a passing
    // test to extend rather than one to remember to write.
    expect(planDomainFiles("shop", []).map((file) => file.name)).toEqual([
      "schema.ts",
      "model.ts",
      "actions.ts",
      "actions.test.ts",
    ]);
    expect(planDomainFiles("shop", ["ui", "runtime"]).map((file) => file.name)).toEqual([
      "schema.ts",
      "model.ts",
      "actions.ts",
      "actions.test.ts",
      "ui.tsx",
      "runtime.ts",
    ]);
  });

  it("only emits file names the default conventions classify", () => {
    // The generator's contract with the classifier: every scaffolded file name
    // must be covered by a Recommended Layout `**/<name>` convention so the
    // domain is correctly partitioned by construction.
    const conventionFileNames = new Set(
      [
        ...DEFAULT_CONFIG.conventions.client,
        ...DEFAULT_CONFIG.conventions.server,
        ...DEFAULT_CONFIG.conventions.shared,
      ]
        .filter((pattern) => pattern.startsWith("**/") && !pattern.endsWith("/**"))
        .map((pattern) => pattern.slice("**/".length)),
    );
    // Spec globs are wildcards rather than literal names, so they are matched by
    // suffix: `**/*.test.ts` covers `actions.test.ts`.
    const testSuffixes = DEFAULT_CONFIG.conventions.test
      .filter((pattern) => pattern.startsWith("**/*"))
      .map((pattern) => pattern.slice("**/*".length));

    for (const file of planDomainFiles("shop", ["ui", "runtime"])) {
      const classified =
        conventionFileNames.has(file.name) ||
        testSuffixes.some((suffix) => file.name.endsWith(suffix));
      expect({ file: file.name, classified }).toEqual({ file: file.name, classified: true });
    }
  });

  it("scaffolds a spec that exercises the starter action", () => {
    const spec = planDomainFiles("player-stats", []).find(
      (file) => file.name === "actions.test.ts",
    );
    expect(spec?.contents).toContain('from "aruna/testing"');
    expect(spec?.contents).toContain('"player-stats.ping": pingPlayerStats');
  });

  it("names the starter action after the domain", () => {
    const actions = planDomainFiles("player-stats", []).find(
      (file) => file.name === "actions.ts",
    );
    expect(actions?.contents).toContain('id: "player-stats.ping"');
    expect(actions?.contents).toContain("export const pingPlayerStats");
  });
});

describe("runAddDomain", () => {
  const tempDirs: string[] = [];

  function tempProject(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aruna-add-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scaffolds under <root>/domains/<name> and never overwrites", () => {
    const projectRoot = tempProject();
    const first = runAddDomain({ projectRoot, root: "src", name: "shop", extras: [] });
    expect(first.created).toEqual([
      "src/domains/shop/schema.ts",
      "src/domains/shop/model.ts",
      "src/domains/shop/actions.ts",
      "src/domains/shop/actions.test.ts",
    ]);
    expect(first.skipped).toEqual([]);

    fs.writeFileSync(path.join(projectRoot, "src/domains/shop/actions.ts"), "// mine\n");
    const second = runAddDomain({ projectRoot, root: "src", name: "shop", extras: ["ui"] });
    expect(second.created).toEqual(["src/domains/shop/ui.tsx"]);
    expect(second.skipped).toEqual([
      "src/domains/shop/schema.ts",
      "src/domains/shop/model.ts",
      "src/domains/shop/actions.ts",
      "src/domains/shop/actions.test.ts",
    ]);
    expect(fs.readFileSync(path.join(projectRoot, "src/domains/shop/actions.ts"), "utf8")).toBe(
      "// mine\n",
    );
  });

  it("respects a non-default source root", () => {
    const projectRoot = tempProject();
    const result = runAddDomain({ projectRoot, root: "game", name: "shop", extras: [] });
    expect(result.domainDir).toBe("game/domains/shop");
    expect(fs.existsSync(path.join(projectRoot, "game/domains/shop/schema.ts"))).toBe(true);
  });
});
