import path from "node:path";
import type {
  ActionRecord,
  CompilerOutput,
  Diagnostic,
  ModuleRecord,
  SchemaMetadata,
  SignalRecord,
  StoreRecord,
} from "@arunajs/core";
import { formatActionSchemaSummary } from "./format-action-schema.js";

export type ActionContractProjectMetadata = {
  readonly root: string;
  readonly generatedDir: string;
  readonly manifest: string;
};

export type ActionContractSchema = {
  readonly summary: string;
  readonly schema: SchemaMetadata | null;
};

export type ActionContractRecord = {
  readonly id: string;
  readonly source: string;
  readonly moduleKind: ModuleRecord["kind"];
  readonly authority: {
    readonly owner: "server";
    readonly clientCallable: true;
  };
  readonly generated: {
    readonly clientExport: string | null;
    readonly serverRegistry: true;
  };
  readonly input: ActionContractSchema;
  readonly output: ActionContractSchema;
  readonly serialization: {
    readonly policy: "plain-data-v1";
  };
  readonly rateLimit: {
    readonly key: "player" | "global";
    readonly windowMs: number;
    readonly max: number;
  } | null;
  // Present (and true) only for an action declared `idempotent: true`, so the
  // snapshot of every other action is byte-stable with older baselines.
  readonly idempotent?: true;
  readonly warnings: readonly string[];
};

export type SignalContractRecord = {
  readonly id: string;
  readonly source: string;
  readonly moduleKind: ModuleRecord["kind"];
  readonly direction: "server-to-client";
  readonly payload: ActionContractSchema;
  readonly serialization: {
    readonly policy: "plain-data-v1";
  };
  // Present only for `wire: "binary"`, so other signals' snapshots stay
  // byte-stable.
  readonly wire?: "binary";
  // The largest binary frame for the payload, header included; present only
  // when the payload schema is bounded.
  readonly maxEncodedBytes?: number;
  readonly warnings: readonly string[];
};

// A persisted store. The contract that matters here is not client/server (a
// store never crosses the wire) but old code/new code: records a previous build
// wrote stay in the DataStore and the next build has to read them.
export type StoreContractRecord = {
  readonly id: string;
  readonly source: string;
  readonly kind: StoreRecord["kind"];
  readonly version: number;
  readonly scope: string | null;
  readonly hasMigrate: boolean;
  readonly schema: ActionContractSchema;
  readonly warnings: readonly string[];
};

export type ActionContractSnapshot = {
  readonly version: 1;
  readonly project: ActionContractProjectMetadata;
  readonly actions: readonly ActionContractRecord[];
  // Omitted when the project declares no signals, keeping action-only snapshots
  // byte-stable with pre-signal baselines.
  readonly signals?: readonly SignalContractRecord[];
  // Omitted when the project declares no stores, for the same reason.
  readonly stores?: readonly StoreContractRecord[];
  readonly diagnostics: readonly Diagnostic[];
  readonly generatedAt: null;
};

function normalizePath(text: string): string {
  return text.split(path.sep).join("/");
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function sortWarnings(warnings: readonly string[]): string[] {
  return [...new Set(warnings)].sort(compareStrings);
}

function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((left, right) => {
    return (
      compareStrings(left.code, right.code) ||
      compareStrings(left.file ?? "", right.file ?? "") ||
      compareStrings(left.name, right.name) ||
      compareStrings(left.message, right.message) ||
      compareStrings(left.details ?? "", right.details ?? "") ||
      compareStrings(left.suggestion ?? "", right.suggestion ?? "")
    );
  });
}

function lookupModuleKind(output: CompilerOutput, file: string): ModuleRecord["kind"] {
  return output.manifest.modules.find((module) => module.path === file)?.kind ?? "unknown";
}

function summarizeGeneratedExport(action: ActionRecord): string | null {
  return action.exportName.length > 0 ? action.exportName : null;
}

function summarizeAction(
  output: CompilerOutput,
  action: ActionRecord,
): ActionContractRecord {
  const input = formatActionSchemaSummary(action.inputSchema);
  // hasOutputSchema is false for actions that never declare `output` (void
  // return) — that's a deliberate absence, not missing metadata, so it must
  // not be rendered as "unknown (metadata unavailable)" or warn.
  const outputSchema = action.hasOutputSchema
    ? formatActionSchemaSummary(action.outputSchema)
    : { summary: "void", warnings: [] as readonly string[] };
  const warnings = sortWarnings([...input.warnings, ...outputSchema.warnings]);

  return {
    id: action.id,
    source: normalizePath(action.file),
    moduleKind: lookupModuleKind(output, action.file),
    authority: {
      owner: "server",
      clientCallable: true,
    },
    generated: {
      clientExport: summarizeGeneratedExport(action),
      serverRegistry: true,
    },
    input: {
      summary: input.summary,
      schema: action.inputSchema ?? null,
    },
    output: {
      summary: outputSchema.summary,
      schema: action.outputSchema ?? null,
    },
    serialization: {
      policy: action.serialization.policy,
    },
    rateLimit: action.rateLimit ?? null,
    ...(action.idempotent === true ? { idempotent: true as const } : {}),
    warnings,
  };
}

function summarizeSignal(
  output: CompilerOutput,
  signal: SignalRecord,
): SignalContractRecord {
  const payload = formatActionSchemaSummary(signal.payloadSchema);

  return {
    id: signal.id,
    source: normalizePath(signal.file),
    moduleKind: lookupModuleKind(output, signal.file),
    direction: "server-to-client",
    payload: {
      summary: payload.summary,
      schema: signal.payloadSchema ?? null,
    },
    serialization: {
      policy: signal.serialization.policy,
    },
    ...(signal.wire === "binary" ? { wire: "binary" as const } : {}),
    ...(signal.maxEncodedBytes !== undefined ? { maxEncodedBytes: signal.maxEncodedBytes } : {}),
    warnings: sortWarnings(payload.warnings),
  };
}

function summarizeStore(store: StoreRecord): StoreContractRecord {
  const schema = formatActionSchemaSummary(store.schema);

  return {
    id: store.id,
    source: normalizePath(store.file),
    kind: store.kind,
    version: store.version,
    scope: store.scope ?? null,
    hasMigrate: store.hasMigrate === true,
    schema: {
      summary: schema.summary,
      schema: store.schema ?? null,
    },
    warnings: sortWarnings(schema.warnings),
  };
}

export function buildActionContractSnapshot(output: CompilerOutput): ActionContractSnapshot {
  const generatedDir = normalizePath(output.config.generatedDir);
  const actions = [...output.manifest.actions]
    .sort(
      (left, right) =>
        compareStrings(left.id, right.id) ||
        compareStrings(left.file, right.file) ||
        compareStrings(left.exportName, right.exportName),
    )
    .map((action) => summarizeAction(output, action));

  const signals = [...(output.manifest.signals ?? [])]
    .sort(
      (left, right) =>
        compareStrings(left.id, right.id) ||
        compareStrings(left.file, right.file) ||
        compareStrings(left.exportName, right.exportName),
    )
    .map((signal) => summarizeSignal(output, signal));

  const stores = [...(output.manifest.stores ?? [])]
    .sort(
      (left, right) =>
        compareStrings(left.id, right.id) ||
        compareStrings(left.scope ?? "", right.scope ?? "") ||
        compareStrings(left.file, right.file),
    )
    .map((store) => summarizeStore(store));

  return {
    version: 1,
    project: {
      root: normalizePath(path.relative(process.cwd(), output.projectRoot)) || ".",
      generatedDir,
      manifest: normalizePath(output.config.manifestOutput),
    },
    actions,
    ...(signals.length > 0 ? { signals } : {}),
    ...(stores.length > 0 ? { stores } : {}),
    diagnostics: sortDiagnostics(output.diagnostics),
    generatedAt: null,
  };
}
