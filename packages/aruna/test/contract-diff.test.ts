import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inspectProject } from "@arunajs/compiler";
import {
  buildActionContractSnapshot,
  type ActionContractRecord,
  type ActionContractSnapshot,
  type ResourceContractRecord,
  type SignalContractRecord,
  type StoreContractRecord,
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

function resource(overrides: Record<string, unknown> = {}): ResourceContractRecord {
  return {
    id: "quests.progress",
    source: "src/domains/quests/resources.ts",
    moduleKind: "server",
    direction: "server-to-client",
    scope: "player",
    value: {
      summary: "object { step: u16 }",
      schema: objectSchema({ step: { kind: "number", numericFormat: "u16" } }),
    },
    serialization: { policy: "plain-data-v1" },
    warnings: [],
    ...(overrides as Partial<ResourceContractRecord>),
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
    version: 2,
    project,
    actions,
    diagnostics: [],
    generatedAt: null,
  };
}

function store(overrides: Partial<StoreContractRecord> = {}): StoreContractRecord {
  return {
    id: "player.profile",
    source: "src/domains/economy/store.ts",
    kind: "playerStore",
    version: 1,
    scope: null,
    hasMigrate: false,
    schema: {
      summary: "object { coins: number, name: string }",
      schema: objectSchema({ coins: { kind: "number" }, name: { kind: "string" } }),
    },
    warnings: [],
    ...overrides,
  };
}

function storeSchema(properties: Record<string, unknown>): StoreContractRecord["schema"] {
  return { summary: "object", schema: objectSchema(properties) };
}

function storeSnapshot(stores: readonly StoreContractRecord[]): ActionContractSnapshot {
  return { ...snapshot([]), stores };
}

function diffStores(before: StoreContractRecord, after: StoreContractRecord) {
  return diffActionContractSnapshots(storeSnapshot([before]), storeSnapshot([after]));
}

describe("contract diff for stores", () => {
  it("reports nothing when the store is unchanged", () => {
    expect(diffStores(store(), store()).entries).toEqual([]);
  });

  it("breaks on a required field added at the same version, not on an optional one", () => {
    const required = diffStores(
      store(),
      store({ schema: storeSchema({ coins: { kind: "number" }, name: { kind: "string" }, gems: { kind: "number" } }) }),
    );
    const optional = diffStores(
      store(),
      store({
        schema: storeSchema({
          coins: { kind: "number" },
          name: { kind: "string" },
          gems: { kind: "optional", inner: { kind: "number" } },
        }),
      }),
    );

    expect(required.entries).toEqual([
      expect.objectContaining({
        severity: "breaking",
        kind: "store-field-added-required",
        actionId: "player.profile",
        path: "schema.gems",
      }),
    ]);
    expect(optional.entries).toEqual([
      expect.objectContaining({ severity: "non-breaking", kind: "store-field-added-optional" }),
    ]);
  });

  it("breaks on a field type changed or narrowed, and allows a widening", () => {
    const changed = diffStores(
      store(),
      store({ schema: storeSchema({ coins: { kind: "string" }, name: { kind: "string" } }) }),
    );
    const narrowed = diffStores(
      store(),
      store({
        schema: storeSchema({ coins: { kind: "number", numericFormat: "u8" }, name: { kind: "string" } }),
      }),
    );
    const widened = diffStores(
      store({
        schema: storeSchema({ coins: { kind: "number", numericFormat: "u8" }, name: { kind: "string" } }),
      }),
      store({
        schema: storeSchema({ coins: { kind: "number", numericFormat: "i16" }, name: { kind: "string" } }),
      }),
    );
    const madeRequired = diffStores(
      store({
        schema: storeSchema({ coins: { kind: "optional", inner: { kind: "number" } }, name: { kind: "string" } }),
      }),
      store(),
    );

    expect(changed.entries).toEqual([
      expect.objectContaining({ severity: "breaking", kind: "store-field-type-changed", path: "schema.coins" }),
    ]);
    expect(narrowed.entries).toEqual([
      expect.objectContaining({ severity: "breaking", kind: "store-field-type-changed", path: "schema.coins" }),
    ]);
    expect(widened.entries).toEqual([]);
    expect(madeRequired.entries).toEqual([
      expect.objectContaining({ severity: "breaking", path: "schema.coins" }),
    ]);
  });

  it("breaks when an enum loses a value, not when it gains one", () => {
    const rank = (values: string[]) =>
      storeSchema({
        rank: { kind: "enum", values: values.map((value) => ({ kind: "string", value })) },
      });

    expect(diffStores(store({ schema: rank(["a", "b"]) }), store({ schema: rank(["a"]) })).summary.breaking).toBe(1);
    expect(diffStores(store({ schema: rank(["a"]) }), store({ schema: rank(["a", "b"]) })).entries).toEqual([]);
  });

  it("warns, without breaking, when a field is removed", () => {
    const result = diffStores(
      store(),
      store({ schema: storeSchema({ coins: { kind: "number" } }) }),
    );

    expect(result.summary).toEqual({ breaking: 0, warning: 1, nonBreaking: 0, info: 0 });
    expect(result.entries[0]).toMatchObject({ kind: "store-field-removed", path: "schema.name" });
  });

  it("treats a version bump as info with migrate and breaking without, and skips the schema", () => {
    const reshaped = storeSchema({ total: { kind: "number" } });
    const withMigrate = diffStores(store(), store({ version: 2, hasMigrate: true, schema: reshaped }));
    const withoutMigrate = diffStores(store(), store({ version: 2, schema: reshaped }));

    expect(withMigrate.entries).toEqual([
      expect.objectContaining({ severity: "info", kind: "store-version-bumped", before: 1, after: 2 }),
    ]);
    expect(withoutMigrate.entries).toEqual([
      expect.objectContaining({ severity: "breaking", kind: "store-version-bumped-without-migrate" }),
    ]);
  });

  it("breaks when the version goes down", () => {
    const result = diffStores(store({ version: 3, hasMigrate: true }), store({ version: 2, hasMigrate: true }));

    expect(result.entries).toEqual([
      expect.objectContaining({ severity: "breaking", kind: "store-version-decreased" }),
    ]);
  });

  it("breaks when a store moves to another scope or changes kind", () => {
    const moved = diffActionContractSnapshots(
      storeSnapshot([store({ scope: "live" })]),
      storeSnapshot([store({ scope: "live-v2" })]),
    );
    const rekinded = diffStores(store(), store({ kind: "store" }));

    expect(moved.entries).toEqual([
      expect.objectContaining({ severity: "breaking", kind: "store-scope-changed", before: "live", after: "live-v2" }),
    ]);
    expect(rekinded.entries).toEqual([
      expect.objectContaining({ severity: "breaking", kind: "store-kind-changed" }),
    ]);
  });

  it("does not break when a store is added or removed", () => {
    expect(
      diffActionContractSnapshots(storeSnapshot([]), storeSnapshot([store()])).entries,
    ).toEqual([expect.objectContaining({ severity: "non-breaking", kind: "store-added" })]);
    expect(
      diffActionContractSnapshots(storeSnapshot([store()]), storeSnapshot([])).entries,
    ).toEqual([expect.objectContaining({ severity: "non-breaking", kind: "store-removed" })]);
  });

  it("keeps stores, number widths, and union members when a snapshot round-trips through JSON", () => {
    const original = storeSnapshot([
      store({
        schema: storeSchema({
          coins: { kind: "number", numericFormat: "u8" },
          tag: { kind: "union", members: [{ kind: "string" }, { kind: "number" }] },
        }),
      }),
    ]);
    const parsed = parseActionContractSnapshotJson(JSON.parse(JSON.stringify(original)));

    expect(parsed.stores).toEqual(original.stores);
    expect(diffActionContractSnapshots(parsed, original).entries).toEqual([]);
  });
});

describe("contract diff for constraints", () => {
  function withInput(itemId: Record<string, unknown>): ActionContractRecord {
    return action({
      input: { summary: "object", schema: objectSchema({ itemId: { kind: "string", ...itemId } }) },
    });
  }

  function withOutput(total: Record<string, unknown>): ActionContractRecord {
    return action({
      output: { summary: "object", schema: objectSchema({ total: { kind: "number", ...total } }) },
    });
  }

  function diffActions(before: ActionContractRecord, after: ActionContractRecord) {
    return diffActionContractSnapshots(snapshot([before]), snapshot([after]));
  }

  it("breaks on a tightened input bound and allows a loosened one", () => {
    const tightened = diffActions(withInput({ maxLength: 50 }), withInput({ maxLength: 20 }));
    expect(tightened.entries).toEqual([
      {
        severity: "breaking",
        kind: "constraint-tightened",
        actionId: "shop.purchaseItem",
        path: "input.itemId",
        message: "shop.purchaseItem input.itemId maxLength lowered from 50 to 20.",
        before: 50,
        after: 20,
      },
    ]);

    const loosened = diffActions(withInput({ maxLength: 20 }), withInput({ maxLength: 50 }));
    expect(loosened.entries).toEqual([
      expect.objectContaining({ severity: "non-breaking", kind: "constraint-loosened" }),
    ]);
  });

  it("reads an added bound as tighter and a removed one as looser", () => {
    const gained = diffActions(withInput({}), withInput({ minLength: 3, maxChars: 20, refinements: 1 }));
    expect(gained.entries.map((entry) => [entry.severity, entry.kind, entry.message])).toEqual([
      ["breaking", "constraint-tightened", "shop.purchaseItem input.itemId .refine() calls went from 0 to 1."],
      ["breaking", "constraint-tightened", "shop.purchaseItem input.itemId gained maxChars 20."],
      ["breaking", "constraint-tightened", "shop.purchaseItem input.itemId gained minLength 3."],
    ]);

    const dropped = diffActions(withInput({ minLength: 3, maxChars: 20 }), withInput({}));
    expect(dropped.summary).toEqual({ breaking: 0, warning: 0, nonBreaking: 2, info: 0 });
  });

  it("turns the rule around for an output and a signal payload", () => {
    // Loosening what the server sends can hand an old client a value it was
    // promised it would not get; tightening only promises it less.
    const raised = diffActions(withOutput({ max: 100 }), withOutput({ max: 200 }));
    expect(raised.entries).toEqual([
      expect.objectContaining({
        severity: "breaking",
        kind: "constraint-loosened",
        path: "output.total",
        message: "shop.purchaseItem output.total max raised from 100 to 200.",
      }),
    ]);
    const integral = diffActions(withOutput({}), withOutput({ int: true, min: 0 }));
    expect(integral.summary).toEqual({ breaking: 0, warning: 0, nonBreaking: 2, info: 0 });

    const payload = (amount: Record<string, unknown>) => ({
      ...snapshot([]),
      signals: [
        signal({
          payload: { summary: "object", schema: objectSchema({ amount: { kind: "number", ...amount } }) },
        }),
      ],
    });
    const widened = diffActionContractSnapshots(payload({ max: 10 }), payload({}));
    expect(widened.entries).toEqual([
      expect.objectContaining({ severity: "breaking", kind: "constraint-loosened", path: "payload.amount" }),
    ]);
  });

  it("warns on a change it can see but not judge", () => {
    const predicate = diffActions(
      withInput({ refinements: 1, constraintsHash: "aaaa" }),
      withInput({ refinements: 1, constraintsHash: "bbbb" }),
    );
    expect(predicate.entries).toEqual([
      expect.objectContaining({
        severity: "warning",
        kind: "constraint-changed",
        path: "input.itemId",
        before: "aaaa",
        after: "bbbb",
      }),
    ]);

    // A bound the compiler could not read is not compared by value.
    const computed = diffActions(
      withInput({ maxLength: 40, dynamicConstraints: ["maxLength"], constraintsHash: "aaaa" }),
      withInput({ maxLength: 10, dynamicConstraints: ["maxLength"], constraintsHash: "bbbb" }),
    );
    expect(computed.entries.map((entry) => entry.kind)).toEqual(["constraint-changed"]);
  });

  it("compares bounds inside arrays and records", () => {
    const tags = (items: Record<string, unknown>, list: Record<string, unknown> = {}) =>
      action({
        input: {
          summary: "object",
          schema: objectSchema({
            tags: { kind: "array", items: { kind: "string", ...items }, ...list },
            scores: { kind: "record", items: { kind: "number" }, maxEntries: 8 },
          }),
        },
      });
    const result = diffActions(tags({ maxLength: 16 }, { maxItems: 8 }), tags({ maxLength: 8 }, { maxItems: 4 }));
    expect(result.entries.map((entry) => entry.path)).toEqual(["input.tags", "input.tags.items"]);
    expect(result.summary.breaking).toBe(2);
  });

  it("keeps constraints when a snapshot round-trips through JSON", () => {
    const original = snapshot([
      withInput({
        minLength: 1,
        maxLength: 20,
        maxChars: 10,
        refinements: 2,
        dynamicConstraints: ["minChars"],
        constraintsHash: "0123456789abcdef",
      }),
      action({
        id: "shop.counted",
        input: {
          summary: "object",
          schema: objectSchema({ amount: { kind: "number", min: -5, max: 2.5, int: true } }),
        },
      }),
    ]);
    const parsed = parseActionContractSnapshotJson(JSON.parse(JSON.stringify(original)));

    expect(parsed.actions).toEqual(original.actions);
    expect(diffActionContractSnapshots(parsed, original).entries).toEqual([]);
  });

  it("compares no constraints against a version 1 snapshot, which did not record them", () => {
    // Version 1 hashed `.min(0)` and kept only byte and item bounds.
    const legacy = {
      ...snapshot([withInput({ constraintsHash: "aaaa" })]),
      version: 1 as const,
    };
    const result = diffActionContractSnapshots(legacy, snapshot([withInput({ minLength: 3 })]));
    expect(result.entries).toEqual([
      expect.objectContaining({ severity: "info", kind: "constraints-not-compared" }),
    ]);
    // Everything else is still compared.
    const removed = diffActionContractSnapshots(legacy, snapshot([]));
    expect(removed.summary).toEqual({ breaking: 1, warning: 0, nonBreaking: 0, info: 1 });
  });
});

describe("contract diff for declared errors", () => {
  const stock = (properties: Record<string, unknown>) => ({
    name: "OutOfStock",
    data: { summary: "object", schema: objectSchema(properties) },
  });
  const withErrors = (errors: ReadonlyArray<{ name: string; data: unknown }>) =>
    action({ errors } as Record<string, unknown>);
  const diff = (before: ActionContractRecord, after: ActionContractRecord) =>
    diffActionContractSnapshots(snapshot([before]), snapshot([after]));

  it("treats an added error as non-breaking and a removed one as info", () => {
    const added = diff(action(), withErrors([{ name: "NotEnoughCoins", data: null }]));
    expect(added.entries).toEqual([
      {
        severity: "non-breaking",
        kind: "error-added",
        actionId: "shop.purchaseItem",
        path: "errors.NotEnoughCoins",
        message: "shop.purchaseItem error NotEnoughCoins added.",
      },
    ]);
    const removed = diff(withErrors([{ name: "NotEnoughCoins", data: null }]), action());
    expect(removed.entries).toEqual([
      expect.objectContaining({ severity: "info", kind: "error-removed", path: "errors.NotEnoughCoins" }),
    ]);
  });

  it("compares an error's data by the output rules", () => {
    const before = withErrors([stock({ itemId: { kind: "string" } })]);
    const dropped = diff(before, withErrors([stock({})]));
    expect(dropped.entries).toEqual([
      expect.objectContaining({
        severity: "breaking",
        kind: "error-data-field-removed",
        path: "errors.OutOfStock.data.itemId",
      }),
    ]);
    const added = diff(before, withErrors([stock({ itemId: { kind: "string" }, restockIn: { kind: "number" } })]));
    expect(added.entries).toEqual([
      expect.objectContaining({ severity: "non-breaking", kind: "error-data-field-added" }),
    ]);
    const loosened = diff(
      withErrors([stock({ itemId: { kind: "string", maxLength: 16 } })]),
      withErrors([stock({ itemId: { kind: "string", maxLength: 64 } })]),
    );
    expect(loosened.entries).toEqual([
      expect.objectContaining({
        severity: "breaking",
        kind: "constraint-loosened",
        path: "errors.OutOfStock.data.itemId",
      }),
    ]);
    const retyped = diff(before, withErrors([{ name: "OutOfStock", data: { summary: "number", schema: { kind: "number" } } }]));
    expect(retyped.entries).toEqual([
      expect.objectContaining({
        severity: "breaking",
        kind: "error-data-changed",
        path: "errors.OutOfStock.data",
        message: "shop.purchaseItem error data schema changed from object { itemId: string } to number.",
      }),
    ]);
  });

  it("allows data to appear on an error, and breaks when it goes away", () => {
    const bare = withErrors([{ name: "OutOfStock", data: null }]);
    const carrying = withErrors([stock({ itemId: { kind: "string" } })]);
    expect(diff(bare, carrying).entries).toEqual([
      expect.objectContaining({ severity: "non-breaking", kind: "error-data-changed" }),
    ]);
    expect(diff(carrying, bare).entries).toEqual([
      expect.objectContaining({ severity: "breaking", kind: "error-data-changed" }),
    ]);
  });

  it("keeps declared errors when a snapshot round-trips through JSON", () => {
    const original = snapshot([
      withErrors([{ name: "NotEnoughCoins", data: null }, stock({ itemId: { kind: "string", maxLength: 8 } })]),
    ]);
    const parsed = parseActionContractSnapshotJson(JSON.parse(JSON.stringify(original)));
    expect(parsed.actions).toEqual(original.actions);
    expect(diffActionContractSnapshots(parsed, original).entries).toEqual([]);
  });
});

describe("contract diff for store constraints", () => {
  const level = (constraints: Record<string, unknown>) =>
    store({ schema: storeSchema({ level: { kind: "number", ...constraints } }) });

  it("breaks when a bound tightens at the same version, and says nothing when it loosens", () => {
    const tightened = diffStores(level({}), level({ min: 0, int: true }));
    expect(tightened.entries.map((entry) => [entry.severity, entry.kind, entry.message])).toEqual([
      [
        "breaking",
        "store-bound-tightened",
        "player.profile schema.level gained .int(); saved records may not satisfy it and will fail to load.",
      ],
      [
        "breaking",
        "store-bound-tightened",
        "player.profile schema.level gained min 0; saved records may not satisfy it and will fail to load.",
      ],
    ]);
    expect(diffStores(level({ min: 0, int: true }), level({})).entries).toEqual([]);
  });

  it("breaks on a new .refine(), and warns when only a predicate changed", () => {
    expect(diffStores(level({}), level({ refinements: 1, constraintsHash: "aaaa" })).summary.breaking).toBe(1);
    const changed = diffStores(
      level({ refinements: 1, constraintsHash: "aaaa" }),
      level({ refinements: 1, constraintsHash: "bbbb" }),
    );
    expect(changed.entries).toEqual([
      expect.objectContaining({ severity: "warning", kind: "store-constraint-changed", path: "schema.level" }),
    ]);
  });
});

describe("contract diff", () => {
  it("reports identical snapshots as unchanged", () => {
    const before = snapshot([action()]);
    const after = snapshot([action()]);

    const result = diffActionContractSnapshots(before, after);

    expect(result).toEqual({
      version: 1,
      summary: {
        breaking: 0,
        warning: 0,
        nonBreaking: 0,
        info: 0,
      },
      entries: [],
    });
  });

  it("classifies action additions and removals", () => {
    const added = diffActionContractSnapshots(snapshot([]), snapshot([action()]));
    const removed = diffActionContractSnapshots(snapshot([action()]), snapshot([]));

    expect(added.summary).toEqual({ breaking: 0, warning: 0, nonBreaking: 1, info: 0 });
    expect(added.entries[0]).toMatchObject({
      severity: "non-breaking",
      kind: "action-added",
      actionId: "shop.purchaseItem",
    });

    expect(removed.summary).toEqual({ breaking: 1, warning: 0, nonBreaking: 0, info: 0 });
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

  it("reports a rate-limit strategy change as info, beside any throughput change", () => {
    const limit = (max: number, strategy?: "tokenBucket") => ({
      rateLimit: { key: "player", windowMs: 1000, max, ...(strategy !== undefined ? { strategy } : {}) },
    });
    const switched = diffActionContractSnapshots(
      snapshot([action(limit(5))]),
      snapshot([action(limit(5, "tokenBucket"))]),
    );
    expect(switched.entries).toEqual([
      {
        severity: "info",
        kind: "metadata-changed",
        actionId: "shop.purchaseItem",
        path: "rateLimit.strategy",
        message: "shop.purchaseItem rate limit strategy changed from fixedWindow to tokenBucket.",
        before: "fixedWindow",
        after: "tokenBucket",
      },
    ]);

    const tightened = diffActionContractSnapshots(
      snapshot([action(limit(5, "tokenBucket"))]),
      snapshot([action(limit(2))]),
    );
    expect(tightened.entries.map((entry) => [entry.severity, entry.kind])).toEqual([
      ["breaking", "rate-limit-tightened"],
      ["info", "metadata-changed"],
    ]);
    expect(tightened.entries[0]?.message).toBe(
      "shop.purchaseItem rate limit tightened: changed from player, max 5 / 1000ms (token bucket) to player, max 2 / 1000ms.",
    );

    // A strategy survives the snapshot's JSON form.
    const original = snapshot([action(limit(5, "tokenBucket"))]);
    expect(parseActionContractSnapshotJson(JSON.parse(JSON.stringify(original))).actions).toEqual(
      original.actions,
    );
  });

  it("treats dropping idempotent as breaking and adding it as non-breaking", () => {
    const removed = diffActionContractSnapshots(
      snapshot([action({ idempotent: true })]),
      snapshot([action()]),
    );
    const added = diffActionContractSnapshots(
      snapshot([action()]),
      snapshot([action({ idempotent: true })]),
    );

    expect(removed.entries).toEqual([
      expect.objectContaining({
        severity: "breaking",
        kind: "idempotent-removed",
        actionId: "shop.purchaseItem",
        before: true,
        after: false,
      }),
    ]);
    expect(added.entries).toEqual([
      expect.objectContaining({ severity: "non-breaking", kind: "idempotent-added" }),
    ]);
  });

  it("reports adding or dropping authorize as info, and keeps it through JSON", () => {
    const added = diffActionContractSnapshots(snapshot([action()]), snapshot([action({ authorized: true })]));
    const removed = diffActionContractSnapshots(snapshot([action({ authorized: true })]), snapshot([action()]));

    expect(added.entries).toEqual([
      expect.objectContaining({ severity: "info", kind: "action-authorize-changed", path: "authorized" }),
    ]);
    expect(added.entries[0]?.message).toBe("shop.purchaseItem now authorizes calls.");
    expect(removed.entries[0]?.message).toBe("shop.purchaseItem no longer authorizes calls.");

    const parsed = parseActionContractSnapshotJson(
      JSON.parse(JSON.stringify(snapshot([action({ authorized: true })]))),
    );
    expect(parsed.actions[0]?.authorized).toBe(true);
  });

  it("keeps idempotent when a snapshot round-trips through JSON", () => {
    const parsed = parseActionContractSnapshotJson(
      JSON.parse(JSON.stringify(snapshot([action({ idempotent: true })]))),
    );

    expect(parsed.actions[0]?.idempotent).toBe(true);
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
    expect(() => parseActionContractSnapshotJson({ version: 3 })).toThrow(
      "snapshot.version must be 1 or 2.",
    );
  });

  it("classifies signal additions and removals", () => {
    const before = snapshot([action()]);
    const after = { ...snapshot([action()]), signals: [signal()] };

    const added = diffActionContractSnapshots(before, after);
    expect(added.summary).toEqual({ breaking: 0, warning: 0, nonBreaking: 1, info: 0 });
    expect(added.entries[0]).toMatchObject({
      severity: "non-breaking",
      kind: "signal-added",
      actionId: "combat.playerDamaged",
    });

    const removed = diffActionContractSnapshots(after, before);
    expect(removed.summary).toEqual({ breaking: 1, warning: 0, nonBreaking: 0, info: 0 });
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
    expect(added.summary).toEqual({ breaking: 0, warning: 0, nonBreaking: 1, info: 0 });
    expect(added.entries[0]).toMatchObject({
      kind: "signal-payload-field-added",
      actionId: "combat.playerDamaged",
      path: "payload.source",
    });

    const removed = diffActionContractSnapshots(withExtraField, before);
    expect(removed.summary).toEqual({ breaking: 1, warning: 0, nonBreaking: 0, info: 0 });
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

  it("diffs resources: removal and a scope change break clients, the value follows the output rules", () => {
    const base = { ...snapshot([]), resources: [resource()] };

    const added = diffActionContractSnapshots(snapshot([]), base);
    expect(added.entries[0]).toMatchObject({ severity: "non-breaking", kind: "resource-added" });
    const removed = diffActionContractSnapshots(base, snapshot([]));
    expect(removed.entries[0]).toMatchObject({ severity: "breaking", kind: "resource-removed" });

    const global = diffActionContractSnapshots(base, {
      ...snapshot([]),
      resources: [resource({ scope: "global" })],
    });
    expect(global.entries[0]).toMatchObject({
      severity: "breaking",
      kind: "resource-scope-changed",
      before: "player",
      after: "global",
    });

    const wider = {
      ...snapshot([]),
      resources: [
        resource({
          value: {
            summary: "object { quest: string; step: u16 }",
            schema: objectSchema({ quest: { kind: "string" }, step: { kind: "number", numericFormat: "u16" } }),
          },
        }),
      ],
    };
    const fieldAdded = diffActionContractSnapshots(base, wider);
    expect(fieldAdded.summary).toEqual({ breaking: 0, warning: 0, nonBreaking: 1, info: 0 });
    expect(fieldAdded.entries[0]).toMatchObject({ kind: "resource-value-field-added", path: "value.quest" });
    const fieldRemoved = diffActionContractSnapshots(wider, base);
    expect(fieldRemoved.entries[0]).toMatchObject({
      severity: "breaking",
      kind: "resource-value-field-removed",
      path: "value.quest",
    });

    const authorized = diffActionContractSnapshots(base, {
      ...snapshot([]),
      resources: [resource({ authorized: true })],
    });
    expect(authorized.entries[0]).toMatchObject({ severity: "info", kind: "resource-authorize-changed" });
  });

  it("round-trips resources through snapshot JSON parsing", () => {
    const withResources = { ...snapshot([action()]), resources: [resource({ authorized: true })] };
    const parsed = parseActionContractSnapshotJson(JSON.parse(serializeJson(withResources)));
    expect(parsed.resources).toEqual(withResources.resources);
    expect(diffActionContractSnapshots(parsed, withResources).entries).toHaveLength(0);
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
