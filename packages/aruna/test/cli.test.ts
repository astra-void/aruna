import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inspectProject } from "@arunajs/compiler";
import { formatGraphInspection, formatModuleInspection, formatSummary } from "../src/format.js";
import { resolveColorMode, serializeJson } from "../src/cli.js";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/;
const fixturesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

async function loadFixtureOutput(name: string) {
  return inspectProject({ root: path.join(fixturesRoot, name, "input") });
}

describe("color policy", () => {
  it("disables colors for json, no-color, no_color, ci, and non-tty output", () => {
    expect(resolveColorMode({ json: true }, {}, true).enabled).toBe(false);
    expect(resolveColorMode({ noColor: true }, {}, true).enabled).toBe(false);
    expect(resolveColorMode({}, { NO_COLOR: "1" }, true).enabled).toBe(false);
    expect(resolveColorMode({}, { CI: "1" }, true).enabled).toBe(false);
    expect(resolveColorMode({}, {}, false).enabled).toBe(false);
    expect(resolveColorMode({}, {}, true).enabled).toBe(true);
  });
});

describe("json output", () => {
  it("serializes cleanly without ANSI escape sequences", async () => {
    const output = await loadFixtureOutput("invalid-client-imports-server");
    expect(serializeJson(output)).not.toMatch(ANSI_PATTERN);
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
