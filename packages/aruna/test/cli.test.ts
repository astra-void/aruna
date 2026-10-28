import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inspectProject } from "@arunajs/compiler";
import { formatGraphInspection, formatModuleInspection, formatSummary } from "../src/format.js";
import { buildActionInspectionReport, formatActionInspection } from "../src/cli/inspect-actions.js";
import { formatActionSchemaSummary } from "../src/cli/format-action-schema.js";
import {
  relativeImportsOf,
  resolveColorMode,
  serializeJson,
  validateRobloxRuntimeSource,
} from "../src/cli.js";
import {
  ARUNA_CLI_PALETTES,
  formatMuted,
  formatSeverityLabel,
  formatWarning,
  formatError,
  formatSuccess,
} from "../src/theme.js";

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`);
const fixturesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures",
);
const builtCliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aruna-cli-"));
}

function writeProject(root: string, files: Record<string, string>): void {
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents, "utf8");
  }
}

// Copies a fixture's input into a throwaway temp dir so `aruna build` can write
// generated output (stubs, vendored runtime) without polluting the committed
// fixture — which the compiler fixture snapshots read from.
function copyFixtureInput(name: string): string {
  const dest = makeTempRoot();
  fs.cpSync(path.join(fixturesRoot, name, "input"), dest, { recursive: true });
  return dest;
}

async function loadFixtureOutput(name: string) {
  return inspectProject({ root: path.join(fixturesRoot, name, "input") });
}

describe("color policy", () => {
  it("disables colors for json, no-color, no_color, ci, and non-tty output", () => {
    expect(resolveColorMode({ json: true }, {}, true).enabled).toBe(false);
    expect(resolveColorMode({ noColor: true }, {}, true).enabled).toBe(false);
    expect(resolveColorMode({ color: false }, {}, true).enabled).toBe(false);
    expect(resolveColorMode({}, { NO_COLOR: "1" }, true).enabled).toBe(false);
    expect(resolveColorMode({}, { CI: "1" }, true).enabled).toBe(false);
    expect(resolveColorMode({}, {}, false).enabled).toBe(false);
    expect(resolveColorMode({}, {}, true).enabled).toBe(true);
  });
});

describe("theme", () => {
  it("keeps the spec palette values unchanged", () => {
    expect(ARUNA_CLI_PALETTES.sunrise).toEqual(["#f6c177", "#eb6f92", "#9ccfd8"]);
    expect(ARUNA_CLI_PALETTES.softAurora).toEqual(["#c4a7e7", "#9ccfd8", "#f6c177"]);
    expect(ARUNA_CLI_PALETTES.minimalCyan).toEqual(["#9ccfd8", "#31748f"]);
  });

  it("returns plain text for semantic helpers when colors are disabled", () => {
    const colorMode = { enabled: false };

    expect(formatSeverityLabel("error", "error", colorMode)).toBe("error");
    expect(formatSeverityLabel("warning", "warning", colorMode)).toBe("warning");
    expect(formatSeverityLabel("info", "info", colorMode)).toBe("info");
    expect(formatSeverityLabel("success", "success", colorMode)).toBe("success");
    expect(formatSeverityLabel("muted", "muted", colorMode)).toBe("muted");
    expect(formatSuccess("ok", colorMode)).toBe("ok");
    expect(formatWarning("warning", colorMode)).toBe("warning");
    expect(formatError("error", colorMode)).toBe("error");
    expect(formatMuted("done in 10ms", colorMode)).toBe("done in 10ms");
  });
});

describe("json output", () => {
  it("serializes cleanly without ANSI escape sequences", async () => {
    const output = await loadFixtureOutput("invalid-client-imports-server");
    expect(serializeJson(output)).not.toMatch(ANSI_PATTERN);
  });
});

describe("store contract gate", () => {
  function runCli(args: string[], cwd?: string): ReturnType<typeof spawnSync> {
    expect(fs.existsSync(builtCliPath)).toBe(true);
    const env = { ...process.env };
    delete env.CI;
    delete env.NO_COLOR;
    delete env.INIT_CWD;
    return spawnSync(process.execPath, [builtCliPath, ...args], {
      encoding: "utf8",
      env,
      ...(cwd !== undefined ? { cwd } : {}),
    });
  }

  function gateDiagnostics(stdout: string): Array<{ code: string; severity: string; message: string }> {
    const parsed = JSON.parse(stdout) as {
      diagnostics: Array<{ code: string; severity: string; message: string }>;
    };
    return parsed.diagnostics.filter((diagnostic) => diagnostic.code.startsWith("aruna::57"));
  }

  it("fails check when a store change leaves saved records unreadable", () => {
    const result = runCli([
      "check",
      "--json",
      "--project",
      path.join(fixturesRoot, "store-contract-incompatible", "input"),
    ]);

    expect(result.status).toBe(1);
    const diagnostics = gateDiagnostics(String(result.stdout));
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["aruna::578", "aruna::578"]);
    expect(diagnostics.every((diagnostic) => diagnostic.severity === "error")).toBe(true);
    const messages = diagnostics.map((diagnostic) => diagnostic.message).join("\n");
    expect(messages).toContain("schema.coins narrowed");
    expect(messages).toContain("schema.gems added as a required field with no .default()");
  });

  it("passes check when saved records still read", () => {
    const result = runCli([
      "check",
      "--json",
      "--project",
      path.join(fixturesRoot, "store-contract-compatible", "input"),
    ]);

    expect(result.status).toBe(0);
    expect(gateDiagnostics(String(result.stdout))).toEqual([]);
  });

  it("stops the build before vendoring or compiling", () => {
    const root = copyFixtureInput("store-contract-incompatible");
    const result = runCli(["build", "--no-emit-luau", "--project", root]);

    expect(result.status).toBe(1);
    expect(String(result.stdout)).toContain("aruna::578");
    expect(fs.existsSync(path.join(root, "src/.aruna/shared/runtime"))).toBe(false);
  });

  it("diffs against the committed snapshot when no baseline is given", () => {
    const result = runCli(
      ["contract", "diff", "--no-color"],
      path.join(fixturesRoot, "store-contract-incompatible", "input"),
    );

    expect(result.status).toBe(1);
    const stdout = String(result.stdout);
    expect(stdout).toContain("baseline: aruna.contract.json");
    expect(stdout).toContain("2 breaking changes");
    expect(stdout).toContain("1 warning");
    expect(stdout).toContain("schema.name removed");
  });

  it("reports the version-bump rules in the diff", () => {
    const result = runCli(
      ["contract", "diff", "--json"],
      path.join(fixturesRoot, "store-contract-compatible", "input"),
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(String(result.stdout)) as {
      summary: { breaking: number };
      entries: Array<{ kind: string; severity: string }>;
    };
    expect(parsed.summary.breaking).toBe(0);
    expect(parsed.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "store-version-bumped", severity: "info" }),
        expect.objectContaining({ kind: "store-field-added-optional", severity: "non-breaking" }),
      ]),
    );
  });

  it("fails the gate when a store bound is lowered or added at the same version", () => {
    const root = path.join(fixturesRoot, "store-contract-bound-tightened", "input");
    const check = runCli(["check", "--json", "--project", root]);

    expect(check.status).toBe(1);
    const messages = gateDiagnostics(String(check.stdout)).map((diagnostic) => diagnostic.message);
    expect(messages).toEqual([
      "player.profile schema.name maxLength lowered from 32 to 16; saved records up to 32 bytes long will fail to load.",
      "player.profile schema.tags gained maxItems 10; saved records may be longer and will fail to load.",
    ]);

    // Raising title's maxLength is compatible, so it is not listed at all.
    const diff = runCli(["contract", "diff", "--json"], root);
    const parsed = JSON.parse(String(diff.stdout)) as {
      entries: Array<{ kind: string; path: string; before: unknown; after: unknown }>;
    };
    expect(parsed.entries).toEqual([
      expect.objectContaining({ kind: "store-bound-tightened", path: "schema.name", before: 32, after: 16 }),
      expect.objectContaining({ kind: "store-bound-tightened", path: "schema.tags", before: null, after: 10 }),
    ]);
  });

  it("warns, without failing the gate, when a constraint the compiler cannot check changed", () => {
    const root = path.join(fixturesRoot, "store-contract-constraint-changed", "input");

    expect(runCli(["check", "--project", root]).status).toBe(0);
    const diff = runCli(["contract", "diff", "--json"], root);
    expect(diff.status).toBe(0);
    const parsed = JSON.parse(String(diff.stdout)) as {
      summary: { breaking: number; warning: number };
      entries: Array<{ kind: string; severity: string; path: string; message: string }>;
    };
    expect(parsed.summary).toMatchObject({ breaking: 0, warning: 2 });
    expect(parsed.entries.map((entry) => [entry.kind, entry.severity, entry.path])).toEqual([
      ["store-constraint-changed", "warning", "schema.level"],
      ["store-constraint-changed", "warning", "schema.nickname"],
    ]);
    expect(parsed.entries[0]?.message).toContain("constraint changed; saved records not verified");
    // A warning is not an unreadable-record change, so update records it.
    const copy = copyFixtureInput("store-contract-constraint-changed");
    expect(runCli(["contract", "update", "--project", copy]).status).toBe(0);
  });

  it("lowers the gate to a warning through strict.storeCompatibility", () => {
    const root = copyFixtureInput("store-contract-incompatible");
    writeProject(root, {
      "aruna.config.ts":
        'import { defineConfig } from "aruna";\n\nexport default defineConfig({ strict: { storeCompatibility: "warning" } });\n',
    });
    const result = runCli(["check", "--json", "--project", root]);

    expect(result.status).toBe(0);
    const diagnostics = gateDiagnostics(String(result.stdout));
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.every((diagnostic) => diagnostic.severity === "warning")).toBe(true);
  });

  it("reads the snapshot from contract.snapshot", () => {
    const root = copyFixtureInput("store-contract-incompatible");
    fs.mkdirSync(path.join(root, "contracts"));
    fs.renameSync(path.join(root, "aruna.contract.json"), path.join(root, "contracts/shipped.json"));
    // Without the config, there is no snapshot at the default path: no gate.
    expect(runCli(["check", "--project", root]).status).toBe(0);

    writeProject(root, {
      "aruna.config.ts":
        'import { defineConfig } from "aruna";\n\nexport default defineConfig({ contract: { snapshot: "contracts/shipped.json" } });\n',
    });
    expect(runCli(["check", "--project", root]).status).toBe(1);
  });

  it("reports an unreadable snapshot as aruna::579", () => {
    const root = copyFixtureInput("store-contract-compatible");
    fs.writeFileSync(path.join(root, "aruna.contract.json"), "{ not json", "utf8");
    const result = runCli(["check", "--json", "--project", root]);

    expect(result.status).toBe(1);
    expect(gateDiagnostics(String(result.stdout)).map((diagnostic) => diagnostic.code)).toEqual([
      "aruna::579",
    ]);
  });

  it("refuses to record a store change that leaves saved records unreadable", () => {
    const root = copyFixtureInput("store-contract-incompatible");
    const before = fs.readFileSync(path.join(root, "aruna.contract.json"), "utf8");
    const update = runCli(["contract", "update", "--no-color", "--project", root]);

    expect(update.status).toBe(1);
    const stderr = String(update.stderr);
    expect(stderr).toContain("refusing to update aruna.contract.json");
    expect(stderr).toContain("schema.coins narrowed");
    expect(stderr).toContain("--accept-unreadable-records");
    expect(stderr).not.toContain("contract update`");
    expect(fs.readFileSync(path.join(root, "aruna.contract.json"), "utf8")).toBe(before);
    expect(runCli(["check", "--project", root]).status).toBe(1);
  });

  it("writes an unreadable change only with --accept-unreadable-records, loudly", () => {
    const root = copyFixtureInput("store-contract-incompatible");
    const update = runCli([
      "contract",
      "update",
      "--accept-unreadable-records",
      "--no-color",
      "--project",
      root,
    ]);

    expect(update.status).toBe(0);
    expect(String(update.stdout)).toContain("wrote aruna.contract.json");
    const stderr = String(update.stderr);
    expect(stderr).toContain("WARNING: --accept-unreadable-records");
    expect(stderr).toContain("UNREADABLE");
    expect(stderr).toContain("schema.coins narrowed");
    const written = JSON.parse(fs.readFileSync(path.join(root, "aruna.contract.json"), "utf8")) as {
      stores: Array<{ id: string; schema: { summary: string } }>;
    };
    expect(written.stores[0]?.schema.summary).toBe("object { coins: u8, gems: number }");
    expect(runCli(["check", "--project", root]).status).toBe(0);
  });

  it("records a compatible store change without the flag", () => {
    const root = copyFixtureInput("store-contract-compatible");
    const update = runCli(["contract", "update", "--project", root]);

    expect(update.status).toBe(0);
    expect(String(update.stderr)).toBe("");
  });

  it("refuses to overwrite an unreadable snapshot without the flag", () => {
    const root = copyFixtureInput("store-contract-compatible");
    fs.writeFileSync(path.join(root, "aruna.contract.json"), "{ not json", "utf8");

    const refused = runCli(["contract", "update", "--no-color", "--project", root]);
    expect(refused.status).toBe(1);
    expect(String(refused.stderr)).toContain("could not compare against aruna.contract.json");
    expect(fs.readFileSync(path.join(root, "aruna.contract.json"), "utf8")).toBe("{ not json");

    const accepted = runCli(["contract", "update", "--accept-unreadable-records", "--project", root]);
    expect(accepted.status).toBe(0);
    expect(String(accepted.stderr)).toContain("no store was checked");
  });

  it("creates a missing snapshot", () => {
    const root = copyFixtureInput("store-contract-compatible");
    fs.rmSync(path.join(root, "aruna.contract.json"));
    const update = runCli(["contract", "update", "--project", root]);

    expect(update.status).toBe(0);
    expect(fs.existsSync(path.join(root, "aruna.contract.json"))).toBe(true);
  });

  it("exits 1 from contract update --check while the snapshot is out of date", () => {
    const root = copyFixtureInput("store-contract-compatible");
    const before = fs.readFileSync(path.join(root, "aruna.contract.json"), "utf8");

    const stale = runCli(["contract", "update", "--check", "--no-color", "--project", root]);
    expect(stale.status).toBe(1);
    expect(String(stale.stderr)).toContain("aruna.contract.json is out of date");
    // --check never writes.
    expect(fs.readFileSync(path.join(root, "aruna.contract.json"), "utf8")).toBe(before);

    expect(runCli(["contract", "update", "--project", root]).status).toBe(0);
    const fresh = runCli(["contract", "update", "--check", "--json", "--project", root]);
    expect(fresh.status).toBe(0);
    expect(JSON.parse(String(fresh.stdout))).toMatchObject({ ok: true, outOfDate: false });

    // Reformatting the file does not make it out of date.
    const written = fs.readFileSync(path.join(root, "aruna.contract.json"), "utf8");
    fs.writeFileSync(
      path.join(root, "aruna.contract.json"),
      JSON.stringify(JSON.parse(written)),
      "utf8",
    );
    expect(runCli(["contract", "update", "--check", "--project", root]).status).toBe(0);
  });

  it("names the unreadable changes from contract update --check, and a missing snapshot", () => {
    const root = copyFixtureInput("store-contract-incompatible");
    const stale = runCli(["contract", "update", "--check", "--json", "--project", root]);

    expect(stale.status).toBe(1);
    const parsed = JSON.parse(String(stale.stdout)) as {
      ok: boolean;
      unreadableRecordChanges: string[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.unreadableRecordChanges).toHaveLength(2);

    fs.rmSync(path.join(root, "aruna.contract.json"));
    const missing = runCli(["contract", "update", "--check", "--no-color", "--project", root]);
    expect(missing.status).toBe(1);
    expect(String(missing.stderr)).toContain("aruna.contract.json does not exist");
  });

  it("no longer suggests contract update for an unreadable store change", () => {
    const result = runCli([
      "check",
      "--json",
      "--project",
      path.join(fixturesRoot, "store-contract-incompatible", "input"),
    ]);
    const parsed = JSON.parse(String(result.stdout)) as {
      diagnostics: Array<{ code: string; suggestion?: string }>;
    };
    const suggestions = parsed.diagnostics
      .filter((diagnostic) => diagnostic.code === "aruna::578")
      .map((diagnostic) => diagnostic.suggestion ?? "");
    expect(suggestions.length).toBeGreaterThan(0);
    for (const suggestion of suggestions) {
      expect(suggestion).toContain(".default(");
      expect(suggestion).toContain("migrate()");
      expect(suggestion).not.toContain("contract update");
    }
  });

  it("refuses to write a snapshot from a project that does not compile", () => {
    const root = copyFixtureInput("invalid-action-rate-limit");
    const result = runCli(["contract", "update", "--project", root]);

    expect(result.status).toBe(1);
    expect(fs.existsSync(path.join(root, "aruna.contract.json"))).toBe(false);
  });
});

describe("cli integration", () => {
  function runContractDiff(args: string[]): ReturnType<typeof spawnSync> {
    expect(fs.existsSync(builtCliPath)).toBe(true);

    const env = { ...process.env };
    delete env.CI;
    delete env.NO_COLOR;

    return spawnSync(process.execPath, [builtCliPath, "contract", "diff", ...args], {
      encoding: "utf8",
      env,
    });
  }

  it("disables ANSI output in the built CLI when Commander parses --no-color", () => {
    expect(fs.existsSync(builtCliPath)).toBe(true);

    const env = { ...process.env };
    delete env.CI;
    delete env.NO_COLOR;

    const result = spawnSync(
      process.execPath,
      [
        builtCliPath,
        "check",
        "--no-color",
        "--project",
        path.join(fixturesRoot, "valid-client-imports-shared", "input"),
      ],
      {
        encoding: "utf8",
        env,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("aruna check");
    expect(result.stdout).not.toMatch(ANSI_PATTERN);
    expect(result.stderr).toBe("");
  });

  it("prints contract diff output and honors no-color", () => {
    const result = runContractDiff([
      "--no-color",
      "--from",
      path.join(fixturesRoot, "action-rate-limit", "expected", "contract.snapshot.json"),
      "--to",
      path.join(fixturesRoot, "action-rate-limit", "expected", "contract.snapshot.json"),
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("aruna contract diff");
    expect(result.stdout).toContain("no contract changes");
    expect(result.stdout).not.toMatch(ANSI_PATTERN);
    expect(result.stderr).toBe("");
  });

  it("emits stable JSON for contract diff", () => {
    const result = runContractDiff([
      "--json",
      "--from",
      path.join(fixturesRoot, "action-rate-limit", "expected", "contract.snapshot.json"),
      "--to",
      path.join(fixturesRoot, "action-rate-limit", "expected", "contract.snapshot.json"),
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\s*\{/);
    expect(result.stdout).not.toMatch(ANSI_PATTERN);

    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      version: 1,
      summary: {
        breaking: 0,
        warning: 0,
        nonBreaking: 0,
        info: 0,
      },
      entries: [],
    });
    expect(result.stderr).toBe("");
  });

  it("compares a project snapshot against the baseline fixture", () => {
    const result = runContractDiff([
      "--no-color",
      "--project",
      path.join(fixturesRoot, "action-rate-limit", "input"),
      "--baseline",
      path.join(fixturesRoot, "action-rate-limit", "expected", "contract.snapshot.json"),
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("aruna contract diff");
    expect(result.stdout).toContain("no contract changes");
    expect(result.stdout).not.toMatch(ANSI_PATTERN);
    expect(result.stderr).toBe("");
  });

  it("returns a clear failure when the current project has compiler errors", () => {
    const result = runContractDiff([
      "--no-color",
      "--project",
      path.join(fixturesRoot, "invalid-action-rate-limit", "input"),
      "--baseline",
      path.join(fixturesRoot, "action-rate-limit", "expected", "contract.snapshot.json"),
    ]);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("aruna contract diff");
    expect(result.stdout).toContain("unable to compare: current project has compiler errors.");
    expect(result.stdout).not.toMatch(ANSI_PATTERN);
    expect(result.stderr).toBe("");
  });

  it("prints action inventory output and diagnostics in the built CLI", () => {
    expect(fs.existsSync(builtCliPath)).toBe(true);

    const env = { ...process.env };
    delete env.CI;
    delete env.NO_COLOR;

    const result = spawnSync(
      process.execPath,
      [
        builtCliPath,
        "inspect",
        "actions",
        "--no-color",
        "--project",
        path.join(fixturesRoot, "invalid-action-rate-limit", "input"),
      ],
      {
        encoding: "utf8",
        env,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("aruna inspect actions");
    expect(result.stdout).toContain("9 actions discovered");
    expect(result.stdout).toContain("shop.legacyLimit");
    expect(result.stdout).toContain("rate limit: none");
    expect(result.stdout).toContain("rateLimit does not support the limit key");
    expect(result.stdout).toContain('key: "player"');
    expect(result.stdout).toContain("aruna::560");
    expect(result.stdout).not.toMatch(ANSI_PATTERN);
    expect(result.stderr).toBe("");
  });

  it("emits stable JSON for the action inventory", () => {
    expect(fs.existsSync(builtCliPath)).toBe(true);

    const env = { ...process.env };
    delete env.CI;
    delete env.NO_COLOR;

    const result = spawnSync(
      process.execPath,
      [
        builtCliPath,
        "inspect",
        "actions",
        "--json",
        "--project",
        path.join(fixturesRoot, "action-rate-limit", "input"),
      ],
      {
        encoding: "utf8",
        env,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\s*\{/);
    expect(result.stdout).not.toMatch(ANSI_PATTERN);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions[0]).toMatchObject({
      id: "shop.purchaseItem",
      source: "src/domains/shop/actions.ts",
      moduleKind: "serverAction",
      authority: {
        owner: "server",
        clientCallable: true,
      },
      generated: {
        clientExport: "purchaseItem",
        serverRegistry: true,
      },
      input: {
        summary: "object { itemId: string }",
      },
      output: {
        summary: "object { ok: boolean }",
      },
      serialization: {
        policy: "plain-data-v1",
      },
      rateLimit: {
        key: "player",
        windowMs: 1000,
        max: 5,
      },
      warnings: [],
    });
    expect(result.stderr).toBe("");
  });

  it("keeps built CLI JSON output free of ANSI escape codes", () => {
    expect(fs.existsSync(builtCliPath)).toBe(true);

    const env = { ...process.env };
    delete env.CI;
    delete env.NO_COLOR;

    const result = spawnSync(
      process.execPath,
      [
        builtCliPath,
        "check",
        "--json",
        "--project",
        path.join(fixturesRoot, "valid-client-imports-shared", "input"),
      ],
      {
        encoding: "utf8",
        env,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\s*\{/);
    expect(result.stdout).not.toMatch(ANSI_PATTERN);
    expect(result.stderr).toBe("");
  });

  it("prints generated files in build output", () => {
    expect(fs.existsSync(builtCliPath)).toBe(true);

    const env = { ...process.env };
    delete env.CI;
    delete env.NO_COLOR;

    const result = spawnSync(
      process.execPath,
      [
        builtCliPath,
        "build",
        "--no-color",
        "--project",
        copyFixtureInput("action-generated-output"),
      ],
      {
        encoding: "utf8",
        env,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("aruna build");
    expect(result.stdout).toContain("generated:");
    expect(result.stdout).toContain("src/.aruna/shared/actions.client.generated.ts");
    expect(result.stdout).toContain("src/.aruna/server/actions.server.generated.ts");
    expect(result.stdout).toContain("src/.aruna/manifest.json");
    expect(result.stdout).toContain("2 actions discovered");
    expect(result.stdout).toContain("0 errors found");
    expect(result.stdout).not.toMatch(ANSI_PATTERN);
    expect(result.stderr).toBe("");
  });

  it("reports a graceful rbxtsc skip when roblox-ts is not installed", () => {
    expect(fs.existsSync(builtCliPath)).toBe(true);

    const env = { ...process.env };
    delete env.CI;
    delete env.NO_COLOR;

    const result = spawnSync(
      process.execPath,
      [
        builtCliPath,
        "build",
        "--no-color",
        "--project",
        copyFixtureInput("action-generated-output"),
      ],
      { encoding: "utf8", env },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("rbxtsc skipped");
    expect(result.stdout).toContain("--no-emit-luau");
    expect(result.stderr).toBe("");
  });

  it("does not attempt the rbxtsc step under --no-emit-luau", () => {
    expect(fs.existsSync(builtCliPath)).toBe(true);

    const env = { ...process.env };
    delete env.CI;
    delete env.NO_COLOR;

    const result = spawnSync(
      process.execPath,
      [
        builtCliPath,
        "build",
        "--no-color",
        "--no-emit-luau",
        "--project",
        copyFixtureInput("action-generated-output"),
      ],
      { encoding: "utf8", env },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("generated:");
    expect(result.stdout).not.toContain("rbxtsc");
    expect(result.stderr).toBe("");
  });

  it("records the rbxtsc step in --json build output", () => {
    expect(fs.existsSync(builtCliPath)).toBe(true);

    const env = { ...process.env };
    delete env.CI;
    delete env.NO_COLOR;

    const withLuau = spawnSync(
      process.execPath,
      [
        builtCliPath,
        "build",
        "--json",
        "--project",
        copyFixtureInput("action-generated-output"),
      ],
      { encoding: "utf8", env },
    );

    expect(withLuau.status).toBe(0);
    const parsed = JSON.parse(withLuau.stdout) as { rbxtsc?: { kind: string } };
    expect(parsed.rbxtsc?.kind).toBe("skipped");

    const withoutLuau = spawnSync(
      process.execPath,
      [
        builtCliPath,
        "build",
        "--json",
        "--no-emit-luau",
        "--project",
        copyFixtureInput("action-generated-output"),
      ],
      { encoding: "utf8", env },
    );

    expect(withoutLuau.status).toBe(0);
    expect(JSON.parse(withoutLuau.stdout)).not.toHaveProperty("rbxtsc");
  });

  it("defaults the project root to the process cwd when --project is omitted", () => {
    expect(fs.existsSync(builtCliPath)).toBe(true);

    const projectRoot = copyFixtureInput("action-generated-output");
    const env = { ...process.env };
    delete env.CI;
    delete env.NO_COLOR;
    // INIT_CWD points elsewhere; a bare `aruna build` (e.g. a package script
    // whose cwd is the package dir) must still target cwd, not INIT_CWD.
    env.INIT_CWD = path.dirname(projectRoot);

    const result = spawnSync(
      process.execPath,
      [builtCliPath, "build", "--no-emit-luau", "--no-emit-runtime", "--no-color"],
      { encoding: "utf8", env, cwd: projectRoot },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("2 actions discovered");
    expect(result.stderr).toBe("");
  });

  it("vendors the Roblox runtime by default and skips it under --no-emit-runtime", () => {
    expect(fs.existsSync(builtCliPath)).toBe(true);

    const env = { ...process.env };
    delete env.CI;
    delete env.NO_COLOR;

    const projectRoot = copyFixtureInput("action-generated-output");
    const runtimeMarker = path.join(projectRoot, "src", ".aruna", "shared", "runtime", "schema.ts");
    const runBuild = (extraArgs: string[]): ReturnType<typeof spawnSync> =>
      spawnSync(
        process.execPath,
        [builtCliPath, "build", "--no-color", ...extraArgs, "--project", projectRoot],
        { encoding: "utf8", env },
      );

    // Default build vendors the native runtime as project source.
    fs.rmSync(path.dirname(runtimeMarker), { recursive: true, force: true });
    const vendored = runBuild([]);
    expect(vendored.status).toBe(0);
    expect(fs.existsSync(runtimeMarker)).toBe(true);

    // --no-emit-runtime opts out of vendoring.
    fs.rmSync(path.dirname(runtimeMarker), { recursive: true, force: true });
    const skipped = runBuild(["--no-emit-runtime"]);
    expect(skipped.status).toBe(0);
    expect(fs.existsSync(runtimeMarker)).toBe(false);

  });

  it("rejects config fields outside defineConfig's shape", () => {
    expect(fs.existsSync(builtCliPath)).toBe(true);

    const env = { ...process.env };
    delete env.CI;
    delete env.NO_COLOR;

    const result = spawnSync(
      process.execPath,
      [
        builtCliPath,
        "check",
        "--no-color",
        "--project",
        path.join(fixturesRoot, "invalid-config", "input"),
      ],
      {
        encoding: "utf8",
        env,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Unsupported top-level config field: generatedDir");
    expect(result.stdout).not.toMatch(ANSI_PATTERN);
    expect(result.stderr).toBe("");
  });

  it("points at the exact nested config field when validation fails", () => {
    expect(fs.existsSync(builtCliPath)).toBe(true);

    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{
  "compilerOptions": {
    "module": "ESNext"
  }
}
`,
      "aruna.config.ts": `import { defineConfig } from "aruna";

export default defineConfig({
  compiler: {
    generatedDir: 123,
  },
});
`,
    });

    const env = { ...process.env };
    delete env.CI;
    delete env.NO_COLOR;

    const result = spawnSync(
      process.execPath,
      [builtCliPath, "check", "--no-color", "--project", root],
      {
        encoding: "utf8",
        env,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("compiler.generatedDir");
    expect(result.stdout).toContain("must be a string");
    expect(result.stderr).toBe("");
  });

  it("points an invalid rateLimit diagnostic at max/windowMs/key", () => {
    expect(fs.existsSync(builtCliPath)).toBe(true);

    const env = { ...process.env };
    delete env.CI;
    delete env.NO_COLOR;

    const result = spawnSync(
      process.execPath,
      [
        builtCliPath,
        "check",
        "--no-color",
        "--project",
        path.join(fixturesRoot, "invalid-action-rate-limit", "input"),
      ],
      {
        encoding: "utf8",
        env,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("rateLimit does not support the limit key");
    expect(result.stdout).toContain('rateLimit.key must be "player", "global", or a key function');
    expect(result.stdout).toContain('Use rateLimit: { key: "player", windowMs: 1000, max: 5 }');
    expect(result.stdout).not.toMatch(ANSI_PATTERN);
    expect(result.stderr).toBe("");
  });
});

describe("human formatting", () => {
  it("renders a calm check summary and diagnostics without color codes when disabled", async () => {
    const output = await loadFixtureOutput("invalid-client-imports-server");
    const colors = { enabled: false };

    const summary = formatSummary(output, "check", { colors, durationMs: 84 });
    const moduleView = formatModuleInspection(
      {
        ...output,
        manifest: {
          ...output.manifest,
          modules: output.manifest.modules.filter((module) => module.kind === "client"),
        },
      },
      colors,
    );

    expect(summary).toContain("aruna check");
    expect(summary).toContain("1 error found");
    expect(summary).toContain("done in 84ms");
    expect(summary).not.toMatch(ANSI_PATTERN);

    expect(moduleView).toContain("module classification");
    expect(moduleView).toContain("client");
    expect(moduleView).not.toContain("server");
    expect(moduleView).not.toContain("shared");
    expect(moduleView).not.toContain("unknown");
    expect(moduleView).not.toMatch(ANSI_PATTERN);
  });

  it("keeps the inspect graph readable across ok, warning, and error edges", async () => {
    const valid = await loadFixtureOutput("valid-client-imports-shared");
    const warning = await loadFixtureOutput("unresolved-import");
    const error = await loadFixtureOutput("invalid-client-imports-server");
    const colors = { enabled: false };

    expect(formatGraphInspection(valid, colors)).toContain("ok");
    expect(formatGraphInspection(warning, colors)).toContain("warning aruna::105");
    expect(formatGraphInspection(error, colors)).toContain("error aruna::300");
  });

  it("renders action contracts with deterministic schema summaries and rate limits", async () => {
    const actionRateLimit = await loadFixtureOutput("action-rate-limit");
    const actionBasic = await loadFixtureOutput("action-basic");
    const colors = { enabled: false };

    const rateLimitView = formatActionInspection(actionRateLimit, colors);
    const basicView = formatActionInspection(actionBasic, colors);

    expect(rateLimitView).toContain("aruna inspect actions");
    expect(rateLimitView).toContain("1 action discovered");
    expect(rateLimitView).toContain("shop.purchaseItem");
    expect(rateLimitView).toContain("source: src/domains/shop/actions.ts");
    expect(rateLimitView).toContain("input: object { itemId: string }");
    expect(rateLimitView).toContain("output: object { ok: boolean }");
    expect(rateLimitView).toContain("serialization: plain-data-v1");
    expect(rateLimitView).toContain("rate limit: player, max 5 / 1000ms");
    expect(rateLimitView).toContain("authority: server-owned, client callable");
    expect(rateLimitView).toContain("Use --json for machine-readable output.");
    expect(rateLimitView).not.toMatch(ANSI_PATTERN);

    expect(basicView).toContain("rate limit: none");
    expect(basicView).not.toMatch(ANSI_PATTERN);
  });

  it("sorts action inventory deterministically in JSON and human output", async () => {
    const invalidRateLimit = await loadFixtureOutput("invalid-action-rate-limit");
    const report = buildActionInspectionReport(invalidRateLimit);

    expect(report.actions.map((action) => action.id)).toEqual([
      "shop.invalidKey",
      "shop.legacyLimit",
      "shop.maxZero",
      "shop.missingKey",
      "shop.missingMax",
      "shop.missingWindowMs",
      "shop.nonIntegerMax",
      "shop.nonLiteralValue",
      "shop.windowZero",
    ]);
    expect(report.actions[0]?.generated.clientExport).toBe("invalidKey");
    expect(report.actions[0]?.generated.serverRegistry).toBe(true);
    expect(report.actions[0]?.moduleKind).toBe("serverAction");
    expect(report.actions[0]?.authority).toEqual({ owner: "server", clientCallable: true });
    expect(report.actions[0]?.input.summary).toBe("unknown (metadata unavailable)");
  });

  it("renders Roblox userdata and union schema kinds without metadata warnings", () => {
    const painted = formatActionSchemaSummary({
      kind: "object",
      properties: {
        cfs: { kind: "array", items: { kind: "cframe" } },
        color: { kind: "color3" },
        at: { kind: "vector3" },
      },
    });

    expect(painted.summary).toBe("object { at: Vector3, cfs: CFrame[], color: Color3 }");
    expect(painted.warnings).toEqual([]);

    const union = formatActionSchemaSummary({
      kind: "union",
      members: [{ kind: "string" }, { kind: "vector3" }],
    });

    expect(union.summary).toBe("string | Vector3");
    expect(union.warnings).toEqual([]);

    expect(formatActionSchemaSummary({ kind: "union", members: [] }).summary).toBe("never");
    expect(formatActionSchemaSummary({ kind: "union" }).warnings).toEqual([
      "union member metadata missing",
    ]);
  });
});

describe("Roblox runtime vendoring integrity", () => {
  // A minimal but internally-consistent stand-in for the native runtime source:
  // every anchor module is present and every relative import resolves.
  function writeCompleteRuntime(dir: string): void {
    const modules: Record<string, string> = {
      "schema.ts": "export type Schema = unknown;\n",
      "serialization.ts": 'import "./binary";\nexport const isWireSafe = true;\n',
      "binary.ts": "export const encode = 0;\n",
      "rate-limit.ts": "export const createActionRateLimiter = 0;\n",
      "signal-runtime.ts": "export const createRemoteSignalPublisher = 0;\n",
      "signal.ts": 'import type { Schema } from "./schema";\nexport const defineSignal = 0;\n',
      "client-runtime.ts": "export type ActionInvoker = unknown;\n",
      "client.ts": 'export * from "./client-runtime";\n',
      "server-runtime.ts": 'import "./rate-limit";\nimport "./serialization";\n',
      "server-app.ts": "export type ServerAppBinding = unknown;\n",
      "server.ts": 'export { defineSignal } from "./signal";\nexport * from "./server-runtime";\nexport * from "./server-app";\n',
      "roblox.ts": 'import "./signal-runtime";\nimport type { ActionInvoker } from "./client-runtime";\nexport const bindActions = 0;\n',
      "testing-framework.ts": "export const expect = 0;\n",
      "testing.ts":
        'import "./server-app";\nimport "./client";\nimport "./signal-runtime";\nexport * from "./testing-framework";\n',
    };
    for (const [name, contents] of Object.entries(modules)) {
      fs.writeFileSync(path.join(dir, name), contents, "utf8");
    }
  }

  it("extracts relative imports across import/export/side-effect forms", () => {
    const source = [
      'import { a } from "./schema";',
      'import type { B } from "./server-runtime";',
      'import "./signal-runtime";',
      'export * from "./server-app";',
      'export { c } from "./signal.ts";',
      'import pkg from "@arunajs/core";',
      'import abs from "node:path";',
    ].join("\n");

    expect(relativeImportsOf(source).sort()).toEqual([
      "schema",
      "server-app",
      "server-runtime",
      "signal",
      "signal-runtime",
    ]);
  });

  it("accepts a complete, internally-consistent runtime source", async () => {
    const dir = makeTempRoot();
    writeCompleteRuntime(dir);

    const files = await validateRobloxRuntimeSource(dir);
    expect(files).toContain("signal.ts");
    expect(files).toContain("roblox.ts");
  });

  it("rejects a source missing an anchor module (the draw-a-tower incident)", async () => {
    const dir = makeTempRoot();
    writeCompleteRuntime(dir);
    // Simulate a concurrent `git stash` that briefly removed the signal modules.
    fs.rmSync(path.join(dir, "signal.ts"));
    fs.rmSync(path.join(dir, "signal-runtime.ts"));

    await expect(validateRobloxRuntimeSource(dir)).rejects.toThrow(/incomplete: missing required/);
  });

  it("rejects a source with a dangling relative import (non-anchor module missing)", async () => {
    const dir = makeTempRoot();
    writeCompleteRuntime(dir);
    // binary.ts is not an anchor, but it is reachable
    // (server -> server-runtime -> serialization -> binary). Removing it leaves a
    // dangling import rather than a missing anchor.
    fs.rmSync(path.join(dir, "binary.ts"));

    await expect(validateRobloxRuntimeSource(dir)).rejects.toThrow(
      /dangling import.*binary\.ts \(imported by serialization\)/,
    );
  });
});
