import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inspectProject } from "@arunajs/compiler";
import { formatGraphInspection, formatModuleInspection, formatSummary } from "../src/format.js";
import { resolveColorMode, serializeJson } from "../src/cli.js";
import {
  ARUNA_CLI_PALETTES,
  formatMuted,
  formatSeverityLabel,
  formatWarning,
  formatError,
  formatSuccess,
} from "../src/theme.js";

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`);
const fixturesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const builtCliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");

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
  it("disables ANSI output in the built CLI when Commander parses --no-color", () => {
    expect(fs.existsSync(builtCliPath)).toBe(true);

    const env = { ...process.env };
    delete env.CI;
    delete env.NO_COLOR;

    const result = spawnSync(process.execPath, [builtCliPath, "check", "--no-color", "--project", path.join("fixtures", "valid-client-imports-shared", "input")], {
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("aruna check");
    expect(result.stdout).not.toMatch(ANSI_PATTERN);
    expect(result.stderr).toBe("");
  });

  it("keeps built CLI JSON output free of ANSI escape codes", () => {
    expect(fs.existsSync(builtCliPath)).toBe(true);

    const env = { ...process.env };
    delete env.CI;
    delete env.NO_COLOR;

    const result = spawnSync(process.execPath, [builtCliPath, "check", "--json", "--project", path.join("fixtures", "valid-client-imports-shared", "input")], {
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\s*\{/);
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
});
