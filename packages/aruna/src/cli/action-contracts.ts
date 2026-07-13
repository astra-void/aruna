import path from "node:path";
import type {
  ActionRecord,
  CompilerOutput,
  Diagnostic,
  ModuleRecord,
  SchemaMetadata,
  SignalRecord,
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
    readonly key: "player";
    readonly windowMs: number;
    readonly max: number;
  } | null;
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
  readonly warnings: readonly string[];
};

export type ActionContractSnapshot = {
  readonly version: 1;
  readonly project: ActionContractProjectMetadata;
  readonly actions: readonly ActionContractRecord[];
  // Omitted when the project declares no signals, keeping action-only snapshots
  // byte-stable with pre-signal baselines.
  readonly signals?: readonly SignalContractRecord[];
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
    warnings: sortWarnings(payload.warnings),
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

  return {
    version: 1,
    project: {
      root: normalizePath(path.relative(process.cwd(), output.projectRoot)) || ".",
      generatedDir,
      manifest: normalizePath(output.config.manifestOutput),
    },
    actions,
    ...(signals.length > 0 ? { signals } : {}),
    diagnostics: sortDiagnostics(output.diagnostics),
    generatedAt: null,
  };
}
