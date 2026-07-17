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
    expect(result.stdout).toContain("rateLimit.limit is not supported in the pre-public final API");
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

    // The legacy --emit-runtime flag is still accepted (redundant explicit-on).
    fs.rmSync(path.dirname(runtimeMarker), { recursive: true, force: true });
    const explicit = runBuild(["--emit-runtime"]);
    expect(explicit.status).toBe(0);
    expect(fs.existsSync(runtimeMarker)).toBe(true);
  });

  it("explains defineConfig when the legacy flat config is used", () => {
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
    expect(result.stdout).toContain("defineConfig");
    expect(result.stdout).toContain("generatedDir");
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

  it("points the rateLimit legacy limit diagnostic at max/windowMs/key", () => {
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
    expect(result.stdout).toContain("rateLimit.limit is not supported in the pre-public final API");
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
