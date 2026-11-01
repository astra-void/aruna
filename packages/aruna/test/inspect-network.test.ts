import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inspectProject } from "@arunajs/compiler";
import { buildNetworkInspectionReport, formatNetworkInspection } from "../src/cli/inspect-network.js";

const fixturesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

describe("aruna inspect network", () => {
  it("reports declared policy, labelled as static", async () => {
    const output = await inspectProject({ root: path.join(fixturesRoot, "action-rate-limit", "input") });
    const report = buildNetworkInspectionReport(output);
    expect(report.kind).toBe("static");
    expect(report.note).toContain("createNetworkMetrics");
    expect(report.requestBudget).toEqual({ burst: 60, perSecond: 30, maxInFlight: 32, source: "runtime default" });
    expect(report.actions.length).toBeGreaterThan(0);
    for (const action of report.actions) {
      expect(["declared", "defaultRateLimit"]).toContain(action.rateLimitSource);
    }
    const text = formatNetworkInspection(output, "never");
    expect(text).toContain("not measured traffic");
  });

  it("reports signal remotes and schema-bound sizes as estimates", async () => {
    const output = await inspectProject({ root: path.join(fixturesRoot, "signal-payload-size", "input") });
    const report = buildNetworkInspectionReport(output);
    expect(report.signals.some((signal) => signal.remote === "unreliable")).toBe(true);
    const text = formatNetworkInspection(output, "never");
    expect(text).toMatch(/estimated max payload: (unbounded|\d+ bytes \(schema bound)/);
  });

  it("lists resources with their scope", async () => {
    const output = await inspectProject({ root: path.join(fixturesRoot, "resource-basic", "input") });
    expect(buildNetworkInspectionReport(output).resources).toEqual([
      { id: "encounter.boss", scope: "global", authorized: true },
      { id: "quests.progress", scope: "player", authorized: false },
    ]);
  });
});
