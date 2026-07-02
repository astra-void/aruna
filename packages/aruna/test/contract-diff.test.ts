import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inspectProject } from "@arunajs/compiler";
import {
  buildActionContractSnapshot,
  type ActionContractRecord,
  type ActionContractSnapshot,
  type SignalContractRecord,
} from "../src/cli/action-contracts.js";
import {
  diffActionContractSnapshots,
  formatContractDiffReport,
  parseActionContractSnapshotJson,
} from "../src/cli/contract-diff.js";
import { serializeJson } from "../src/cli.js";

const fixturesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures",
);

function objectSchema(
  properties: Record<string, unknown>,
): NonNullable<ActionContractRecord["input"]["schema"]> {
  return {
    kind: "object",
    properties,
  } as NonNullable<ActionContractRecord["input"]["schema"]>;
}

function optionalSchema(inner: unknown): NonNullable<ActionContractRecord["input"]["schema"]> {
  return {
    kind: "optional",
    inner,
  } as NonNullable<ActionContractRecord["input"]["schema"]>;
}

function action(overrides: Record<string, unknown> = {}): ActionContractRecord {
  return {
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
      schema: objectSchema({
        itemId: { kind: "string" },
      }),
    },
    output: {
      summary: "object { ok: boolean }",
      schema: objectSchema({
        ok: { kind: "boolean" },
      }),
    },
    serialization: {
      policy: "plain-data-v1",
    },
    rateLimit: null,
    warnings: [],
    ...(overrides as Partial<ActionContractRecord>),
  };
}

function signal(overrides: Record<string, unknown> = {}): SignalContractRecord {
  return {
    id: "combat.playerDamaged",
    source: "src/domains/combat/signals.ts",
    moduleKind: "shared",
    direction: "server-to-client",
    payload: {
      summary: "object { amount: number }",
      schema: objectSchema({
        amount: { kind: "number" },
      }),
    },
    serialization: {
      policy: "plain-data-v1",
    },
    warnings: [],
    ...(overrides as Partial<SignalContractRecord>),
  };
}

function snapshot(
  actions: readonly ActionContractRecord[],
  project: ActionContractSnapshot["project"] = {
    root: "apps/example",
    generatedDir: "src/.aruna",
    manifest: "src/.aruna/manifest.json",
  },
): ActionContractSnapshot {
  return {
    version: 1,
    project,
    actions,
    diagnostics: [],
    generatedAt: null,
  };
}

describe("contract diff", () => {
  it("reports identical snapshots as unchanged", () => {
    const before = snapshot([action()]);
    const after = snapshot([action()]);

    const result = diffActionContractSnapshots(before, after);

    expect(result).toEqual({
      version: 1,
      summary: {
        breaking: 0,
        nonBreaking: 0,
        info: 0,
      },
      entries: [],
    });
  });

  it("classifies action additions and removals", () => {
    const added = diffActionContractSnapshots(snapshot([]), snapshot([action()]));
    const removed = diffActionContractSnapshots(snapshot([action()]), snapshot([]));

    expect(added.summary).toEqual({ breaking: 0, nonBreaking: 1, info: 0 });
    expect(added.entries[0]).toMatchObject({
      severity: "non-breaking",
      kind: "action-added",
      actionId: "shop.purchaseItem",
    });

    expect(removed.summary).toEqual({ breaking: 1, nonBreaking: 0, info: 0 });
    expect(removed.entries[0]).toMatchObject({
      severity: "breaking",
      kind: "action-removed",
      actionId: "shop.purchaseItem",
    });
  });

  it("classifies schema and metadata changes conservatively", () => {
    const inputRequiredAdded = diffActionContractSnapshots(
      snapshot([action()]),
      snapshot([
        action({
          input: {
            summary: "object { itemId: string, quantity: number }",
            schema: objectSchema({
              itemId: { kind: "string" },
              quantity: { kind: "number" },
            }),
          },
        }),
      ]),
    );

    const inputOptionalAdded = diffActionContractSnapshots(
      snapshot([action()]),
      snapshot([
        action({
          input: {
            summary: "object { itemId: string, note?: string }",
            schema: objectSchema({
              itemId: { kind: "string" },
              note: optionalSchema({ kind: "string" }),
            }),
          },
        }),
      ]),
    );

    const inputTypeChanged = diffActionContractSnapshots(
      snapshot([action()]),
      snapshot([
        action({
          input: {
            summary: "object { itemId: number }",
            schema: objectSchema({
              itemId: { kind: "number" },
            }),
          },
        }),
      ]),
    );

    const outputRemoved = diffActionContractSnapshots(
      snapshot([action()]),
      snapshot([
        action({
          output: {
            summary: "object {}",
            schema: objectSchema({}),
          },
        }),
      ]),
    );

    const outputAdded = diffActionContractSnapshots(
      snapshot([action()]),
      snapshot([
        action({
          output: {
            summary: "object { ok: boolean, receiptId: string }",
            schema: objectSchema({
              ok: { kind: "boolean" },
              receiptId: { kind: "string" },
            }),
          },
        }),
      ]),
    );

    expect(inputRequiredAdded.entries[0]).toMatchObject({
      severity: "breaking",
      kind: "input-field-added-required",
    });
    expect(inputOptionalAdded.entries[0]).toMatchObject({
      severity: "non-breaking",
      kind: "input-field-added-optional",
    });
    expect(inputTypeChanged.entries[0]).toMatchObject({
      severity: "breaking",
      kind: "input-field-type-changed",
    });
    expect(outputRemoved.entries[0]).toMatchObject({
      severity: "breaking",
      kind: "output-field-removed",
    });
    expect(outputAdded.entries[0]).toMatchObject({
      severity: "non-breaking",
      kind: "output-field-added",
    });
  });

  it("covers serialization policy, rate limits, and generated exports", () => {
    const serializationChanged = diffActionContractSnapshots(
      snapshot([action()]),
      snapshot([
        action({
          serialization: {
            policy: "binary-v2",
          },
        }) as ActionContractRecord,
      ]),
    );

    const rateTightened = diffActionContractSnapshots(
      snapshot([
        action({
          rateLimit: {
            key: "player",
            windowMs: 1000,
            max: 10,
          },
        }),
      ]),
      snapshot([
        action({
          rateLimit: {
            key: "player",
            windowMs: 1000,
            max: 5,
          },
        }),
      ]),
    );

    const rateLoosened = diffActionContractSnapshots(
      snapshot([
        action({
          rateLimit: {
            key: "player",
            windowMs: 1000,
            max: 5,
          },
        }),
      ]),
      snapshot([
        action({
          rateLimit: {
            key: "player",
            windowMs: 1000,
            max: 10,
          },
        }),
      ]),
    );

    const generatedExportChanged = diffActionContractSnapshots(
      snapshot([action()]),
      snapshot([
        action({
          generated: {
            clientExport: "purchaseItemV2",
            serverRegistry: true,
          },
        }),
      ]),
    );

    expect(serializationChanged.entries[0]).toMatchObject({
      severity: "breaking",
      kind: "serialization-policy-changed",
    });
    expect(rateTightened.entries[0]).toMatchObject({
      severity: "breaking",
      kind: "rate-limit-tightened",
    });
    expect(rateLoosened.entries[0]).toMatchObject({
      severity: "non-breaking",
      kind: "rate-limit-loosened",
    });
    expect(generatedExportChanged.entries[0]).toMatchObject({
      severity: "breaking",
      kind: "generated-export-changed",
    });
  });

  it("sorts diff entries deterministically", () => {
    const before = snapshot([
      action({
        id: "beta.action",
        serialization: {
          policy: "plain-data-v1",
        },
      }),
      action({
        id: "alpha.action",
        serialization: {
          policy: "plain-data-v1",
        },
      }),
    ]);

    const after = snapshot([
      action({
        id: "alpha.action",
        serialization: {
          policy: "binary-v2",
        },
      }),
    ]);

    const result = diffActionContractSnapshots(before, after);

    expect(result.entries.map((entry) => [entry.severity, entry.actionId, entry.kind])).toEqual([
      ["breaking", "alpha.action", "serialization-policy-changed"],
      ["breaking", "beta.action", "action-removed"],
    ]);
  });

  it("formats a stable human report without ANSI when colors are disabled", () => {
    const result = diffActionContractSnapshots(snapshot([]), snapshot([action()]));
    const report = formatContractDiffReport(result, {
      colors: { enabled: false },
      baselineLabel: "baseline.json",
      currentLabel: "current.json",
    });

    expect(report).toContain("aruna contract diff");
    expect(report).toContain("baseline: baseline.json");
    expect(report).toContain("current: current.json");
    expect(report).toContain("non-breaking change");
    expect(report).toContain("result: compatible");
    expect(report).not.toContain(String.fromCharCode(27));
  });

  it("rejects unsupported snapshot versions", () => {
    expect(() => parseActionContractSnapshotJson({ version: 2 })).toThrow(
      "snapshot.version must be 1.",
    );
  });

  it("classifies signal additions and removals", () => {
    const before = snapshot([action()]);
    const after = { ...snapshot([action()]), signals: [signal()] };

    const added = diffActionContractSnapshots(before, after);
    expect(added.summary).toEqual({ breaking: 0, nonBreaking: 1, info: 0 });
    expect(added.entries[0]).toMatchObject({
      severity: "non-breaking",
      kind: "signal-added",
      actionId: "combat.playerDamaged",
    });

    const removed = diffActionContractSnapshots(after, before);
    expect(removed.summary).toEqual({ breaking: 1, nonBreaking: 0, info: 0 });
    expect(removed.entries[0]).toMatchObject({
      severity: "breaking",
      kind: "signal-removed",
      actionId: "combat.playerDamaged",
    });
  });

  it("classifies signal payload field changes with output compatibility rules", () => {
    const before = {
      ...snapshot([]),
      signals: [signal()],
    };
    const withExtraField = {
      ...snapshot([]),
      signals: [
        signal({
          payload: {
            summary: "object { amount: number; source: string }",
            schema: objectSchema({
              amount: { kind: "number" },
              source: { kind: "string" },
            }),
          },
        }),
      ],
    };

    const added = diffActionContractSnapshots(before, withExtraField);
    expect(added.summary).toEqual({ breaking: 0, nonBreaking: 1, info: 0 });
    expect(added.entries[0]).toMatchObject({
      kind: "signal-payload-field-added",
      actionId: "combat.playerDamaged",
      path: "payload.source",
    });

    const removed = diffActionContractSnapshots(withExtraField, before);
    expect(removed.summary).toEqual({ breaking: 1, nonBreaking: 0, info: 0 });
    expect(removed.entries[0]).toMatchObject({
      severity: "breaking",
      kind: "signal-payload-field-removed",
      actionId: "combat.playerDamaged",
      path: "payload.source",
    });
  });

  it("flags a retyped signal payload field as breaking", () => {
    const before = { ...snapshot([]), signals: [signal()] };
    const retyped = {
      ...snapshot([]),
      signals: [
        signal({
          payload: {
            summary: "object { amount: string }",
            schema: objectSchema({ amount: { kind: "string" } }),
          },
        }),
      ],
    };

    const result = diffActionContractSnapshots(before, retyped);
    expect(result.summary.breaking).toBe(1);
    expect(result.entries[0]).toMatchObject({
      severity: "breaking",
      kind: "signal-payload-field-type-changed",
      actionId: "combat.playerDamaged",
      path: "payload.amount",
    });
  });

  it("treats a signals-free baseline against a signals-free current as unchanged", () => {
    const result = diffActionContractSnapshots(snapshot([action()]), snapshot([action()]));
    expect(result.entries).toHaveLength(0);
  });

  it("round-trips signals through snapshot JSON parsing", () => {
    const withSignals = { ...snapshot([action()]), signals: [signal()] };
    const parsed = parseActionContractSnapshotJson(
      JSON.parse(JSON.stringify(withSignals)) as unknown,
    );
    expect(parsed.signals).toHaveLength(1);
    expect(parsed.signals?.[0]).toMatchObject({ id: "combat.playerDamaged" });

    const result = diffActionContractSnapshots(parsed, withSignals);
    expect(result.entries).toHaveLength(0);
  });

  it("rejects duplicate signal ids in a snapshot", () => {
    const withSignals = { ...snapshot([]), signals: [signal(), signal()] };
    expect(() =>
      parseActionContractSnapshotJson(JSON.parse(JSON.stringify(withSignals)) as unknown),
    ).toThrow("duplicate signal id");
  });

  it("matches the fixture snapshot against the current project", async () => {
    const fixture = path.join(fixturesRoot, "action-rate-limit");
    const output = await inspectProject({
      root: path.join(fixture, "input"),
    });
    expect(output.ok).toBe(true);

    const current = buildActionContractSnapshot(output);
    const expected = parseActionContractSnapshotJson(
      JSON.parse(
        fs.readFileSync(path.join(fixture, "expected", "contract.snapshot.json"), "utf8"),
      ) as unknown,
    );

    const result = diffActionContractSnapshots(expected, current);
    expect(result.entries).toHaveLength(0);
    expect(serializeJson(result)).toBe(JSON.stringify(result, null, 2));
  });
});
