// `aruna inspect network`: the traffic policy the contract declares, read
// statically. It answers "what may cross the wire, how often, and how big at
// most" — never "what did cross it": measured traffic comes from the runtime's
// `createNetworkMetrics()`, and nothing here is a measurement.
import type { CompilerOutput } from "@arunajs/core";
import { buildActionContractSnapshot } from "./action-contracts.js";
import type { CliColorMode } from "./format.js";
import { formatBrandTitle, formatMuted, formatStrong } from "./theme.js";

// The runtime defaults for the per-player request budget in front of dispatch
// (request-guard.ts). The budget is a `createServerApp` option, not config, so
// the compiler cannot see an override.
const REQUEST_BUDGET_DEFAULTS = { burst: 60, perSecond: 30, maxInFlight: 32 } as const;

export type NetworkInspectionReport = {
  readonly kind: "static";
  readonly note: string;
  readonly requestBudget: typeof REQUEST_BUDGET_DEFAULTS & { readonly source: "runtime default" };
  readonly defaultRateLimit: CompilerOutput["config"]["actions"]["defaultRateLimit"];
  readonly actions: ReadonlyArray<{
    readonly id: string;
    readonly delivery: "request-response" | "fire-and-forget";
    readonly idempotent: boolean;
    readonly rateLimit: { readonly key: string; readonly windowMs: number; readonly max: number; readonly strategy: string };
    readonly rateLimitSource: "declared" | "defaultRateLimit";
    readonly inputBounded: boolean;
    readonly declaredErrors: readonly string[];
  }>;
  readonly signals: ReadonlyArray<{
    readonly id: string;
    readonly remote: "reliable" | "unreliable";
    readonly encoding: "table" | "binary";
    // Schema-derived; exact for binary, a floor for the table encoding.
    readonly estimatedMaxPayloadBytes: number | null;
  }>;
  readonly resources: ReadonlyArray<{
    readonly id: string;
    readonly scope: "player" | "global";
    readonly authorized: boolean;
  }>;
};

export function buildNetworkInspectionReport(output: CompilerOutput): NetworkInspectionReport {
  const snapshot = buildActionContractSnapshot(output);
  const unbounded = new Set(
    output.diagnostics
      .filter((diagnostic) => diagnostic.code === "aruna::514")
      .map((diagnostic) => /^Server action (\S+) accepts input/.exec(diagnostic.message)?.[1])
      .filter((id): id is string => id !== undefined),
  );
  const fallback = output.config.actions.defaultRateLimit;
  const manifestActions = new Map(output.manifest.actions.map((action) => [action.id, action] as const));
  return {
    kind: "static",
    note: "Declared policy and schema-derived estimates. For measured traffic, use createNetworkMetrics() at runtime.",
    requestBudget: { ...REQUEST_BUDGET_DEFAULTS, source: "runtime default" },
    defaultRateLimit: fallback,
    actions: snapshot.actions.map((action) => {
      const record = manifestActions.get(action.id);
      const declared = action.rateLimit;
      return {
        id: action.id,
        delivery: record?.fireAndForget === true ? "fire-and-forget" : "request-response",
        idempotent: action.idempotent === true,
        rateLimit: declared
          ? { ...declared, strategy: declared.strategy ?? "fixedWindow" }
          : { ...fallback, strategy: fallback.strategy ?? "fixedWindow" },
        rateLimitSource: declared ? "declared" : "defaultRateLimit",
        inputBounded: !unbounded.has(action.id),
        declaredErrors: (action.errors ?? []).map((error) => error.name),
      };
    }),
    signals: (output.manifest.signals ?? []).map((signal) => ({
      id: signal.id,
      remote: signal.unreliable === true ? "unreliable" : "reliable",
      encoding: signal.wire === "binary" ? "binary" : "table",
      estimatedMaxPayloadBytes: signal.maxEncodedBytes ?? null,
    })),
    resources: (snapshot.resources ?? []).map((resource) => ({
      id: resource.id,
      scope: resource.scope,
      authorized: resource.authorized === true,
    })),
  };
}

export function formatNetworkInspection(output: CompilerOutput, colors: CliColorMode): string {
  const report = buildNetworkInspectionReport(output);
  const lines: string[] = [
    formatBrandTitle("aruna inspect network", colors),
    "",
    `  ${formatMuted("static policy from the contract — not measured traffic (use createNetworkMetrics() at runtime)", colors)}`,
    "",
    `  request budget per player: ${report.requestBudget.burst} burst, ${report.requestBudget.perSecond}/s, ${report.requestBudget.maxInFlight} in flight (${report.requestBudget.source}; createServerApp({ requestBudget }) overrides)`,
    "",
  ];
  for (const action of report.actions) {
    const limit = action.rateLimit;
    lines.push(`  ${formatStrong(action.id, colors)}  ${action.delivery}${action.idempotent ? ", idempotent" : ""}`);
    lines.push(
      `    rate limit: ${limit.max} per ${limit.windowMs}ms by ${limit.key} (${limit.strategy}, ${action.rateLimitSource})`,
    );
    lines.push(`    input: ${action.inputBounded ? "bounded" : "unbounded (aruna::514)"}`);
    if (action.declaredErrors.length > 0) {
      lines.push(`    declared errors: ${action.declaredErrors.join(", ")}`);
    }
  }
  for (const signal of report.signals) {
    lines.push(`  ${formatStrong(signal.id, colors)}  signal, ${signal.remote}, ${signal.encoding}`);
    lines.push(
      `    estimated max payload: ${
        signal.estimatedMaxPayloadBytes === null
          ? "unbounded"
          : `${signal.estimatedMaxPayloadBytes} bytes (schema bound${signal.encoding === "binary" ? ", exact" : ", a floor for the table encoding"})`
      }`,
    );
  }
  for (const resource of report.resources) {
    lines.push(
      `  ${formatStrong(resource.id, colors)}  resource, ${resource.scope} scope${resource.authorized ? ", authorized" : ""}, snapshots on the reliable channel`,
    );
  }
  lines.push("");
  lines.push("Use --json for machine-readable output.");
  return lines.join("\n");
}
