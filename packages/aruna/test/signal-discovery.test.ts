import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectProject } from "@arunajs/compiler";
import { buildActionContractSnapshot } from "../src/cli/action-contracts.js";
import { buildSignalInspectionReport } from "../src/cli/inspect-signals.js";

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aruna-signal-"));
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

describe("signal discovery", () => {
  it("discovers defineSignal across the manifest, contract snapshot, and inspect report", async () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": tsconfig,
      "src/domains/combat/signals.ts": `
import { defineSignal } from "aruna/server";
import { schema } from "aruna/schema";

export const damaged = defineSignal({
  id: "combat.damaged",
  payload: schema.object({ amount: schema.u16(), source: schema.string() }),
});

export const tick = defineSignal({ id: "world.tick" });
`,
    });

    const output = await inspectProject({ root });
    const signals = output.manifest.signals ?? [];

    expect(signals.map((signal) => signal.id)).toEqual(["combat.damaged", "world.tick"]);

    const damaged = signals.find((signal) => signal.id === "combat.damaged");
    expect(damaged?.hasPayloadSchema).toBe(true);
    expect(damaged?.payloadSchema?.kind).toBe("object");
    // Feature A flows through discovery: the width hint survives into metadata.
    expect(damaged?.payloadSchema?.properties?.amount?.numericFormat).toBe("u16");

    const tick = signals.find((signal) => signal.id === "world.tick");
    expect(tick?.hasPayloadSchema).toBe(false);
    expect(tick?.payloadSchema).toBeUndefined();

    const snapshot = buildActionContractSnapshot(output);
    expect(snapshot.signals?.map((signal) => signal.id)).toEqual(["combat.damaged", "world.tick"]);
    expect(snapshot.signals?.[0]?.direction).toBe("server-to-client");

    const report = buildSignalInspectionReport(output);
    expect(report.signals).toHaveLength(2);
  });

  it("omits signals from the contract snapshot when none are declared", async () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": tsconfig,
      "src/shared/util.ts": `export const value = 1;\n`,
    });

    const output = await inspectProject({ root });
    expect(output.manifest.signals ?? []).toEqual([]);
    expect(buildActionContractSnapshot(output).signals).toBeUndefined();
  });

  it("surfaces a numeric width hint on an action input through the contract summary", async () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": tsconfig,
      "src/domains/player/actions.ts": `
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const move = defineAction({
  id: "player.move",
  input: schema.object({ dx: schema.i16(), dy: schema.i16() }),
  run(ctx, input) {
    return { ok: true };
  },
});
`,
    });

    const output = await inspectProject({ root });
    const action = output.manifest.actions.find((entry) => entry.id === "player.move");
    expect(action?.inputSchema?.properties?.dx?.numericFormat).toBe("i16");

    const snapshot = buildActionContractSnapshot(output);
    const move = snapshot.actions.find((entry) => entry.id === "player.move");
    // The width is visible in the human-readable contract summary for diffs.
    expect(move?.input.summary).toContain("i16");
  });
});
