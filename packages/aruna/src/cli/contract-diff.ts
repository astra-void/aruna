import fs from "node:fs/promises";
import path from "node:path";
import type {
  CompilerOutput,
  Diagnostic,
  SchemaLiteralMetadata,
  SchemaMetadata,
} from "@arunajs/core";
import {
  buildActionContractSnapshot,
  type ActionContractRecord,
  type ActionContractSnapshot,
  type SignalContractRecord,
} from "./action-contracts.js";
import { formatActionSchemaSummary } from "./format-action-schema.js";
import { formatBrandTitle, formatError, formatMuted } from "./theme.js";
import type { CliColorMode } from "./format.js";

export type ContractDiffSeverity = "breaking" | "non-breaking" | "info";

export type ContractDiffKind =
  | "action-added"
  | "action-removed"
  | "action-source-changed"
  | "input-schema-changed"
  | "input-field-added-required"
  | "input-field-added-optional"
  | "input-field-removed"
  | "input-field-type-changed"
  | "output-schema-changed"
  | "output-field-added"
  | "output-field-removed"
  | "output-field-type-changed"
  | "serialization-policy-changed"
  | "rate-limit-added"
  | "rate-limit-removed"
  | "rate-limit-tightened"
  | "rate-limit-loosened"
  | "authority-changed"
  | "generated-export-changed"
  | "signal-added"
  | "signal-removed"
  | "signal-source-changed"
  | "signal-payload-changed"
  | "signal-payload-field-added"
  | "signal-payload-field-removed"
  | "signal-payload-field-type-changed"
  | "metadata-changed";

export type ContractDiffEntry = {
  readonly severity: ContractDiffSeverity;
  readonly kind: ContractDiffKind;
  readonly actionId?: string;
  readonly path?: string;
  readonly message: string;
  readonly before?: unknown;
  readonly after?: unknown;
};

export type ContractDiffResult = {
  readonly version: 1;
  readonly summary: {
    readonly breaking: number;
    readonly nonBreaking: number;
    readonly info: number;
  };
  readonly entries: readonly ContractDiffEntry[];
};

type ContractDiffCommandMode =
  | {
      readonly kind: "project";
      readonly project: string;
      readonly baseline: string;
    }
  | {
      readonly kind: "files";
      readonly from: string;
      readonly to: string;
    };

type ContractDiffRenderContext = {
  readonly colors: CliColorMode;
  readonly baselineLabel: string;
  readonly currentLabel: string;
};

type ParsedSchema = SchemaMetadata;

type ParsedActionContractRecord = ActionContractRecord & {
  readonly input: {
    readonly summary: string;
    readonly schema: SchemaMetadata | null;
  };
  readonly output: {
    readonly summary: string;
    readonly schema: SchemaMetadata | null;
  };
};

type ParsedSignalContractRecord = SignalContractRecord & {
  readonly payload: {
    readonly summary: string;
    readonly schema: SchemaMetadata | null;
  };
};

type ParsedActionContractSnapshot = Omit<ActionContractSnapshot, "actions" | "signals"> & {
  readonly actions: readonly ParsedActionContractRecord[];
  readonly signals?: readonly ParsedSignalContractRecord[];
};

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function normalizePath(text: string): string {
  return text.split(path.sep).join("/");
}

function isRecordLike(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "unknown";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (value === undefined) {
    return "undefined";
  }

  if (value === null) {
    return "null";
  }

  return JSON.stringify(value);
}

function severityRank(severity: ContractDiffSeverity): number {
  switch (severity) {
    case "breaking":
      return 0;
    case "non-breaking":
      return 1;
    case "info":
      return 2;
  }
}

function isLiteralMetadata(value: unknown): value is SchemaLiteralMetadata {
  if (!isRecordLike(value) || typeof value["kind"] !== "string") {
    return false;
  }

  switch (value["kind"]) {
    case "string":
      return typeof value["value"] === "string";
    case "number":
      return typeof value["value"] === "string" || typeof value["value"] === "number";
    case "boolean":
      return typeof value["value"] === "boolean";
    case "undefined":
      return !("value" in value);
    default:
      return false;
  }
}

function parseLiteralMetadata(value: unknown, location: string): SchemaLiteralMetadata {
  if (!isLiteralMetadata(value)) {
    throw new Error(`${location} must be a schema literal metadata object.`);
  }

  return value;
}

function parseSchemaMetadata(value: unknown, location: string): ParsedSchema {
  if (!isRecordLike(value)) {
    throw new Error(`${location} must be a schema metadata object.`);
  }

  if (typeof value["kind"] !== "string") {
    throw new Error(`${location}.kind must be a string.`);
  }

  const parsed: ParsedSchema = {
    kind: value["kind"],
  };

  if ("properties" in value && value["properties"] !== undefined) {
    if (!isRecordLike(value["properties"])) {
      throw new Error(`${location}.properties must be an object.`);
    }

    const properties: Record<string, ParsedSchema> = {};
    for (const [key, child] of Object.entries(value["properties"])) {
      properties[key] = parseSchemaMetadata(child, `${location}.properties.${key}`);
    }

    parsed.properties = properties;
  }

  if ("items" in value && value["items"] !== undefined) {
    parsed.items = parseSchemaMetadata(value["items"], `${location}.items`);
  }

  if ("inner" in value && value["inner"] !== undefined) {
    parsed.inner = parseSchemaMetadata(value["inner"], `${location}.inner`);
  }

  if ("literal" in value && value["literal"] !== undefined) {
    parsed.literal = parseLiteralMetadata(value["literal"], `${location}.literal`);
  }

  if ("values" in value && value["values"] !== undefined) {
    if (!Array.isArray(value["values"])) {
      throw new Error(`${location}.values must be an array.`);
    }

    parsed.values = value["values"].map((entry, index) =>
      parseLiteralMetadata(entry, `${location}.values[${index}]`),
    );
  }

  return parsed;
}

function parseDiagnostic(value: unknown, location: string): Diagnostic {
  if (!isRecordLike(value)) {
    throw new Error(`${location} must be an object.`);
  }

  if (typeof value["code"] !== "string") {
    throw new Error(`${location}.code must be a string.`);
  }
  if (typeof value["name"] !== "string") {
    throw new Error(`${location}.name must be a string.`);
  }
  if (typeof value["severity"] !== "string") {
    throw new Error(`${location}.severity must be a string.`);
  }
  if (typeof value["message"] !== "string") {
    throw new Error(`${location}.message must be a string.`);
  }

  const parsed: Diagnostic = {
    code: value["code"] as Diagnostic["code"],
    name: value["name"],
    severity: value["severity"] as Diagnostic["severity"],
    message: value["message"],
  };

  if (typeof value["file"] === "string") {
    parsed.file = normalizePath(value["file"]);
  }

  if (value["span"] !== undefined) {
    if (!isRecordLike(value["span"])) {
      throw new Error(`${location}.span must be an object.`);
    }

    if (typeof value["span"]["start"] !== "number" || typeof value["span"]["end"] !== "number") {
      throw new Error(`${location}.span.start and ${location}.span.end must be numbers.`);
    }

    parsed.span = {
      start: value["span"]["start"],
      end: value["span"]["end"],
    };
  }

  if (typeof value["details"] === "string") {
    parsed.details = value["details"];
  }
  if (typeof value["suggestion"] === "string") {
    parsed.suggestion = value["suggestion"];
  }
  if (typeof value["docsUrl"] === "string") {
    parsed.docsUrl = value["docsUrl"];
  }

  return parsed;
}

function parseRateLimit(value: unknown, location: string): ParsedActionContractRecord["rateLimit"] {
  if (value === null) {
    return null;
  }

  if (!isRecordLike(value)) {
    throw new Error(`${location} must be null or an object.`);
  }

  if (typeof value["key"] !== "string") {
    throw new Error(`${location}.key must be a string.`);
  }
  if (typeof value["windowMs"] !== "number" || !Number.isFinite(value["windowMs"])) {
    throw new Error(`${location}.windowMs must be a finite number.`);
  }
  if (typeof value["max"] !== "number" || !Number.isFinite(value["max"])) {
    throw new Error(`${location}.max must be a finite number.`);
  }

  return {
    key: value["key"] as "player",
    windowMs: value["windowMs"],
    max: value["max"],
  };
}

function parseActionRecord(value: unknown, location: string): ParsedActionContractRecord {
  if (!isRecordLike(value)) {
    throw new Error(`${location} must be an object.`);
  }

  if (typeof value["id"] !== "string") {
    throw new Error(`${location}.id must be a string.`);
  }
  if (typeof value["source"] !== "string") {
    throw new Error(`${location}.source must be a string.`);
  }
  if (!isRecordLike(value["authority"])) {
    throw new Error(`${location}.authority must be an object.`);
  }
  if (typeof value["authority"]["owner"] !== "string") {
    throw new Error(`${location}.authority.owner must be a string.`);
  }
  if (typeof value["authority"]["clientCallable"] !== "boolean") {
    throw new Error(`${location}.authority.clientCallable must be a boolean.`);
  }
  if (!isRecordLike(value["generated"])) {
    throw new Error(`${location}.generated must be an object.`);
  }
  if (
    value["generated"]["clientExport"] !== null &&
    typeof value["generated"]["clientExport"] !== "string"
  ) {
    throw new Error(`${location}.generated.clientExport must be a string or null.`);
  }
  if (typeof value["generated"]["serverRegistry"] !== "boolean") {
    throw new Error(`${location}.generated.serverRegistry must be a boolean.`);
  }
  if (!isRecordLike(value["input"])) {
    throw new Error(`${location}.input must be an object.`);
  }
  if (typeof value["input"]["summary"] !== "string") {
    throw new Error(`${location}.input.summary must be a string.`);
  }
  if (!isRecordLike(value["output"])) {
    throw new Error(`${location}.output must be an object.`);
  }
  if (typeof value["output"]["summary"] !== "string") {
    throw new Error(`${location}.output.summary must be a string.`);
  }
  if (!isRecordLike(value["serialization"])) {
    throw new Error(`${location}.serialization must be an object.`);
  }
  if (typeof value["serialization"]["policy"] !== "string") {
    throw new Error(`${location}.serialization.policy must be a string.`);
  }
  if (!Array.isArray(value["warnings"])) {
    throw new Error(`${location}.warnings must be an array.`);
  }

  const parsedWarnings: string[] = [];
  for (const [index, warning] of value["warnings"].entries()) {
    if (typeof warning !== "string") {
      throw new Error(`${location}.warnings[${index}] must be a string.`);
    }
    parsedWarnings.push(warning);
  }

  const parsed: ParsedActionContractRecord = {
    id: value["id"],
    source: normalizePath(value["source"]),
    moduleKind:
      typeof value["moduleKind"] === "string"
        ? (value["moduleKind"] as ActionContractRecord["moduleKind"])
        : "unknown",
    authority: {
      owner: value["authority"]["owner"] as "server",
      clientCallable: value["authority"]["clientCallable"] as true,
    },
    generated: {
      clientExport: value["generated"]["clientExport"],
      serverRegistry: value["generated"]["serverRegistry"] as true,
    },
    input: {
      summary: value["input"]["summary"],
      schema:
        value["input"]["schema"] === null || value["input"]["schema"] === undefined
          ? null
          : parseSchemaMetadata(value["input"]["schema"], `${location}.input.schema`),
    },
    output: {
      summary: value["output"]["summary"],
      schema:
        value["output"]["schema"] === null || value["output"]["schema"] === undefined
          ? null
          : parseSchemaMetadata(value["output"]["schema"], `${location}.output.schema`),
    },
    serialization: {
      policy: value["serialization"]["policy"] as "plain-data-v1",
    },
    rateLimit:
      value["rateLimit"] === undefined
        ? null
        : parseRateLimit(value["rateLimit"], `${location}.rateLimit`),
    warnings: parsedWarnings,
  };

  return parsed;
}

function parseSignalRecord(value: unknown, location: string): ParsedSignalContractRecord {
  if (!isRecordLike(value)) {
    throw new Error(`${location} must be an object.`);
  }

  if (typeof value["id"] !== "string") {
    throw new Error(`${location}.id must be a string.`);
  }
  if (typeof value["source"] !== "string") {
    throw new Error(`${location}.source must be a string.`);
  }
  if (value["direction"] !== "server-to-client") {
    throw new Error(`${location}.direction must be "server-to-client".`);
  }
  if (!isRecordLike(value["payload"])) {
    throw new Error(`${location}.payload must be an object.`);
  }
  if (typeof value["payload"]["summary"] !== "string") {
    throw new Error(`${location}.payload.summary must be a string.`);
  }
  if (!isRecordLike(value["serialization"])) {
    throw new Error(`${location}.serialization must be an object.`);
  }
  if (typeof value["serialization"]["policy"] !== "string") {
    throw new Error(`${location}.serialization.policy must be a string.`);
  }
  if (!Array.isArray(value["warnings"])) {
    throw new Error(`${location}.warnings must be an array.`);
  }

  const parsedWarnings: string[] = [];
  for (const [index, warning] of value["warnings"].entries()) {
    if (typeof warning !== "string") {
      throw new Error(`${location}.warnings[${index}] must be a string.`);
    }
    parsedWarnings.push(warning);
  }

  return {
    id: value["id"],
    source: normalizePath(value["source"]),
    moduleKind:
      typeof value["moduleKind"] === "string"
        ? (value["moduleKind"] as SignalContractRecord["moduleKind"])
        : "unknown",
    direction: "server-to-client",
    payload: {
      summary: value["payload"]["summary"],
      schema:
        value["payload"]["schema"] === null || value["payload"]["schema"] === undefined
          ? null
          : parseSchemaMetadata(value["payload"]["schema"], `${location}.payload.schema`),
    },
    serialization: {
      policy: value["serialization"]["policy"] as "plain-data-v1",
    },
    warnings: parsedWarnings,
  };
}

function parseActionContractSnapshotJsonAtPath(
  value: unknown,
  location: string,
): ParsedActionContractSnapshot {
  if (!isRecordLike(value)) {
    throw new Error(`${location} must be an object.`);
  }
  if (value["version"] !== 1) {
    throw new Error(`${location}.version must be 1.`);
  }
  if (!isRecordLike(value["project"])) {
    throw new Error(`${location}.project must be an object.`);
  }
  if (typeof value["project"]["root"] !== "string") {
    throw new Error(`${location}.project.root must be a string.`);
  }
  if (typeof value["project"]["generatedDir"] !== "string") {
    throw new Error(`${location}.project.generatedDir must be a string.`);
  }
  if (typeof value["project"]["manifest"] !== "string") {
    throw new Error(`${location}.project.manifest must be a string.`);
  }
  if (!Array.isArray(value["actions"])) {
    throw new Error(`${location}.actions must be an array.`);
  }
  if (!Array.isArray(value["diagnostics"])) {
    throw new Error(`${location}.diagnostics must be an array.`);
  }

  const actions: ParsedActionContractRecord[] = [];
  const seenIds = new Set<string>();
  for (const [index, action] of value["actions"].entries()) {
    const parsed = parseActionRecord(action, `${location}.actions[${index}]`);
    if (seenIds.has(parsed.id)) {
      throw new Error(`${location}.actions contains a duplicate action id: ${parsed.id}.`);
    }
    seenIds.add(parsed.id);
    actions.push(parsed);
  }

  // `signals` is omitted from action-only snapshots (pre-signal baselines stay
  // parseable); when present it must be a well-formed array.
  let signals: ParsedSignalContractRecord[] | undefined;
  if (value["signals"] !== undefined) {
    if (!Array.isArray(value["signals"])) {
      throw new Error(`${location}.signals must be an array.`);
    }
    signals = [];
    const seenSignalIds = new Set<string>();
    for (const [index, signal] of value["signals"].entries()) {
      const parsed = parseSignalRecord(signal, `${location}.signals[${index}]`);
      if (seenSignalIds.has(parsed.id)) {
        throw new Error(`${location}.signals contains a duplicate signal id: ${parsed.id}.`);
      }
      seenSignalIds.add(parsed.id);
      signals.push(parsed);
    }
  }

  const diagnostics: Diagnostic[] = [];
  for (const [index, diagnostic] of value["diagnostics"].entries()) {
    diagnostics.push(parseDiagnostic(diagnostic, `${location}.diagnostics[${index}]`));
  }

  if (value["generatedAt"] !== null && value["generatedAt"] !== undefined) {
    throw new Error(`${location}.generatedAt must be null.`);
  }

  return {
    version: 1,
    project: {
      root: normalizePath(value["project"]["root"]),
      generatedDir: normalizePath(value["project"]["generatedDir"]),
      manifest: normalizePath(value["project"]["manifest"]),
    },
    actions,
    ...(signals !== undefined ? { signals } : {}),
    diagnostics,
    generatedAt: null,
  };
}

export function parseActionContractSnapshotJson(value: unknown): ActionContractSnapshot {
  return parseActionContractSnapshotJsonAtPath(value, "snapshot");
}

function schemaSummary(schema: ParsedSchema | null | undefined): string {
  return formatActionSchemaSummary(schema ?? undefined).summary;
}

function hasOptionalWrapper(schema: ParsedSchema | null | undefined): boolean {
  return schema?.kind === "optional";
}

function unwrapOptional(schema: ParsedSchema | null | undefined): ParsedSchema | null {
  if (!schema) {
    return null;
  }

  return schema.kind === "optional" ? (schema.inner ?? null) : schema;
}

function compareLiteralValues(
  left: SchemaLiteralMetadata | undefined,
  right: SchemaLiteralMetadata | undefined,
): number {
  if (!left && !right) {
    return 0;
  }

  if (!left) {
    return -1;
  }

  if (!right) {
    return 1;
  }

  return compareStrings(JSON.stringify(left), JSON.stringify(right));
}

function normalizeEnumValues(schema: ParsedSchema | null | undefined): string[] {
  if (!schema || schema.kind !== "enum" || !schema.values) {
    return [];
  }

  return schema.values.map((value) => JSON.stringify(value)).sort(compareStrings);
}

function schemaNodesEqual(
  left: ParsedSchema | null | undefined,
  right: ParsedSchema | null | undefined,
): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "string":
    case "number":
    case "boolean":
      return true;
    case "literal":
      return compareLiteralValues(left.literal, right.literal) === 0;
    case "enum":
      return compareArrays(normalizeEnumValues(left), normalizeEnumValues(right));
    case "array":
    // A record's value schema rides the `items` slot, so it compares like array.
    case "record":
      return schemaNodesEqual(left.items ?? null, right.items ?? null);
    case "optional":
      return schemaNodesEqual(left.inner ?? null, right.inner ?? null);
    case "tuple": {
      const leftMembers = left.members ?? [];
      const rightMembers = right.members ?? [];
      if (leftMembers.length !== rightMembers.length) {
        return false;
      }
      return leftMembers.every((member, index) =>
        schemaNodesEqual(member, rightMembers[index] ?? null),
      );
    }
    case "object": {
      const leftProperties = left.properties ?? {};
      const rightProperties = right.properties ?? {};
      const keys = new Set([...Object.keys(leftProperties), ...Object.keys(rightProperties)]);
      for (const key of keys) {
        if (!schemaNodesEqual(leftProperties[key] ?? null, rightProperties[key] ?? null)) {
          return false;
        }
      }
      return true;
    }
    default:
      return JSON.stringify(left) === JSON.stringify(right);
  }
}

function compareArrays(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function makeEntry(entry: ContractDiffEntry, entries: ContractDiffEntry[]): void {
  entries.push(entry);
}

function diffProjectMetadata(
  before: ActionContractSnapshot,
  after: ActionContractSnapshot,
  entries: ContractDiffEntry[],
): void {
  const fields = ["generatedDir", "manifest"] as const;

  for (const field of fields) {
    const beforeValue = before.project[field];
    const afterValue = after.project[field];
    if (beforeValue === afterValue) {
      continue;
    }

    makeEntry(
      {
        severity: "info",
        kind: "metadata-changed",
        path: `project.${field}`,
        message: `project.${field} changed from ${beforeValue} to ${afterValue}.`,
        before: beforeValue,
        after: afterValue,
      },
      entries,
    );
  }
}

function diffActions(
  before: ActionContractSnapshot,
  after: ActionContractSnapshot,
  entries: ContractDiffEntry[],
): void {
  const beforeById = new Map(before.actions.map((action) => [action.id, action] as const));
  const afterById = new Map(after.actions.map((action) => [action.id, action] as const));
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort(compareStrings);

  for (const actionId of ids) {
    const previous = beforeById.get(actionId);
    const current = afterById.get(actionId);
    if (!previous || !current) {
      if (!previous && current) {
        makeEntry(
          {
            severity: "non-breaking",
            kind: "action-added",
            actionId,
            message: `${actionId} added.`,
          },
          entries,
        );
      } else if (previous && !current) {
        makeEntry(
          {
            severity: "breaking",
            kind: "action-removed",
            actionId,
            message: `${actionId} removed.`,
          },
          entries,
        );
      }

      continue;
    }

    if (previous.source !== current.source) {
      makeEntry(
        {
          severity: "non-breaking",
          kind: "action-source-changed",
          actionId,
          path: "source",
          message: `${actionId} source path changed from ${previous.source} to ${current.source}.`,
          before: previous.source,
          after: current.source,
        },
        entries,
      );
    }

    if (previous.moduleKind !== current.moduleKind) {
      makeEntry(
        {
          severity: "info",
          kind: "metadata-changed",
          actionId,
          path: "moduleKind",
          message: `${actionId} module classification changed from ${previous.moduleKind} to ${current.moduleKind}.`,
          before: previous.moduleKind,
          after: current.moduleKind,
        },
        entries,
      );
    }

    if (previous.generated.clientExport !== current.generated.clientExport) {
      const severity =
        previous.generated.clientExport === null && current.generated.clientExport !== null
          ? "non-breaking"
          : "breaking";
      makeEntry(
        {
          severity,
          kind: "generated-export-changed",
          actionId,
          path: "generated.clientExport",
          message:
            previous.generated.clientExport === null
              ? `${actionId} generated client export added as ${current.generated.clientExport}.`
              : current.generated.clientExport === null
                ? `${actionId} generated client export removed.`
                : `${actionId} generated client export changed from ${previous.generated.clientExport} to ${current.generated.clientExport}.`,
          before: previous.generated.clientExport,
          after: current.generated.clientExport,
        },
        entries,
      );
    }

    if (previous.generated.serverRegistry !== current.generated.serverRegistry) {
      makeEntry(
        {
          severity: "info",
          kind: "metadata-changed",
          actionId,
          path: "generated.serverRegistry",
          message: `${actionId} server registry flag changed from ${previous.generated.serverRegistry} to ${current.generated.serverRegistry}.`,
          before: previous.generated.serverRegistry,
          after: current.generated.serverRegistry,
        },
        entries,
      );
    }

    if (
      previous.authority.owner !== current.authority.owner ||
      previous.authority.clientCallable !== current.authority.clientCallable
    ) {
      const ownerChanged = previous.authority.owner !== current.authority.owner;
      const clientCallableChanged =
        previous.authority.clientCallable !== current.authority.clientCallable;
      const breaking =
        (ownerChanged &&
          previous.authority.owner === "server" &&
          current.authority.owner !== "server") ||
        (clientCallableChanged &&
          previous.authority.clientCallable === true &&
          current.authority.clientCallable === false);

      const beforeParts: string[] = [];
      const afterParts: string[] = [];
      if (ownerChanged) {
        beforeParts.push(`owner=${previous.authority.owner}`);
        afterParts.push(`owner=${current.authority.owner}`);
      }
      if (clientCallableChanged) {
        beforeParts.push(`clientCallable=${String(previous.authority.clientCallable)}`);
        afterParts.push(`clientCallable=${String(current.authority.clientCallable)}`);
      }

      makeEntry(
        {
          severity: breaking ? "breaking" : "info",
          kind: "authority-changed",
          actionId,
          path: "authority",
          message: `${actionId} authority changed from ${beforeParts.join(", ")} to ${afterParts.join(", ")}.`,
          before: beforeParts.join(", "),
          after: afterParts.join(", "),
        },
        entries,
      );
    }

    if (previous.serialization.policy !== current.serialization.policy) {
      makeEntry(
        {
          severity: "breaking",
          kind: "serialization-policy-changed",
          actionId,
          path: "serialization.policy",
          message: `${actionId} serialization policy changed from ${previous.serialization.policy} to ${current.serialization.policy}.`,
          before: previous.serialization.policy,
          after: current.serialization.policy,
        },
        entries,
      );
    }

    diffRateLimit(actionId, previous.rateLimit, current.rateLimit, entries);
    diffSchema("input", actionId, previous.input.schema, current.input.schema, entries);
    diffSchema("output", actionId, previous.output.schema, current.output.schema, entries);
  }
}

function diffRateLimit(
  actionId: string,
  before: ActionContractRecord["rateLimit"],
  after: ActionContractRecord["rateLimit"],
  entries: ContractDiffEntry[],
): void {
  if (!before && !after) {
    return;
  }

  if (!before && after) {
    makeEntry(
      {
        severity: "non-breaking",
        kind: "rate-limit-added",
        actionId,
        path: "rateLimit",
        message: `${actionId} rate limit added: ${after.key}, max ${after.max} / ${after.windowMs}ms.`,
        after: `rate limit ${after.key}, max ${after.max} / ${after.windowMs}ms`,
      },
      entries,
    );
    return;
  }

  if (before && !after) {
    makeEntry(
      {
        severity: "info",
        kind: "rate-limit-removed",
        actionId,
        path: "rateLimit",
        message: `${actionId} rate limit removed.`,
        before: `rate limit ${before.key}, max ${before.max} / ${before.windowMs}ms`,
      },
      entries,
    );
    return;
  }

  if (!before || !after) {
    return;
  }

  if (before.key !== after.key) {
    makeEntry(
      {
        severity: "breaking",
        kind: "metadata-changed",
        actionId,
        path: "rateLimit.key",
        message: `${actionId} rate limit key changed from ${before.key} to ${after.key}.`,
        before: before.key,
        after: after.key,
      },
      entries,
    );
    return;
  }

  const beforeThroughput = before.max / before.windowMs;
  const afterThroughput = after.max / after.windowMs;
  if (afterThroughput < beforeThroughput) {
    makeEntry(
      {
        severity: "breaking",
        kind: "rate-limit-tightened",
        actionId,
        path: "rateLimit",
        message: `${actionId} rate limit tightened: changed from ${before.key}, max ${before.max} / ${before.windowMs}ms to ${after.key}, max ${after.max} / ${after.windowMs}ms.`,
        before: `rate limit ${before.key}, max ${before.max} / ${before.windowMs}ms`,
        after: `rate limit ${after.key}, max ${after.max} / ${after.windowMs}ms`,
      },
      entries,
    );
    return;
  }

  if (afterThroughput > beforeThroughput) {
    makeEntry(
      {
        severity: "non-breaking",
        kind: "rate-limit-loosened",
        actionId,
        path: "rateLimit",
        message: `${actionId} rate limit loosened: changed from ${before.key}, max ${before.max} / ${before.windowMs}ms to ${after.key}, max ${after.max} / ${after.windowMs}ms.`,
        before: `rate limit ${before.key}, max ${before.max} / ${before.windowMs}ms`,
        after: `rate limit ${after.key}, max ${after.max} / ${after.windowMs}ms`,
      },
      entries,
    );
    return;
  }

  if (before.max !== after.max || before.windowMs !== after.windowMs) {
    makeEntry(
      {
        severity: "info",
        kind: "metadata-changed",
        actionId,
        path: "rateLimit",
        message: `${actionId} rate limit changed from ${before.key}, max ${before.max} / ${before.windowMs}ms to ${after.key}, max ${after.max} / ${after.windowMs}ms.`,
        before,
        after,
      },
      entries,
    );
  }
}

function diffSchema(
  role: "input" | "output" | "payload",
  actionId: string,
  before: ParsedSchema | null | undefined,
  after: ParsedSchema | null | undefined,
  entries: ContractDiffEntry[],
  pathPrefix: string = role,
): void {
  const kindForPath: ContractDiffKind =
    pathPrefix === role
      ? role === "input"
        ? "input-schema-changed"
        : role === "output"
          ? "output-schema-changed"
          : "signal-payload-changed"
      : role === "input"
        ? "input-field-type-changed"
        : role === "output"
          ? "output-field-type-changed"
          : "signal-payload-field-type-changed";

  if (schemaNodesEqual(before, after)) {
    return;
  }

  if (!before && !after) {
    return;
  }

  if (!before || !after) {
    makeEntry(
      {
        severity: "breaking",
        kind: kindForPath,
        actionId,
        path: pathPrefix,
        message:
          !before && after
            ? `${actionId} ${role} schema added with ${schemaSummary(after)}.`
            : `${actionId} ${role} schema removed.`,
        before: before ? schemaSummary(before) : undefined,
        after: after ? schemaSummary(after) : undefined,
      },
      entries,
    );
    return;
  }

  if (before.kind !== after.kind) {
    makeEntry(
      {
        severity: "breaking",
        kind: kindForPath,
        actionId,
        path: pathPrefix,
        message: `${actionId} ${role} schema changed from ${schemaSummary(before)} to ${schemaSummary(after)}.`,
        before: schemaSummary(before),
        after: schemaSummary(after),
      },
      entries,
    );
    return;
  }

  switch (before.kind) {
    case "string":
    case "number":
    case "boolean":
      return;
    case "literal":
      if (compareLiteralValues(before.literal, after.literal) !== 0) {
        makeEntry(
          {
            severity: "breaking",
            kind: kindForPath,
            actionId,
            path: pathPrefix,
            message: `${actionId} ${role} schema changed from ${schemaSummary(before)} to ${schemaSummary(after)}.`,
            before: schemaSummary(before),
            after: schemaSummary(after),
          },
          entries,
        );
      }
      return;
    case "enum": {
      if (!compareArrays(normalizeEnumValues(before), normalizeEnumValues(after))) {
        makeEntry(
          {
            severity: "breaking",
            kind: kindForPath,
            actionId,
            path: pathPrefix,
            message: `${actionId} ${role} schema changed from ${schemaSummary(before)} to ${schemaSummary(after)}.`,
            before: schemaSummary(before),
            after: schemaSummary(after),
          },
          entries,
        );
      }
      return;
    }
    case "array":
      diffSchema(
        role,
        actionId,
        before.items ?? null,
        after.items ?? null,
        entries,
        `${pathPrefix}.items`,
      );
      return;
    case "record":
      // The value schema rides the `items` slot; a value-type change hits every
      // entry of the map, so it reports at `<path>.value`.
      diffSchema(
        role,
        actionId,
        before.items ?? null,
        after.items ?? null,
        entries,
        `${pathPrefix}.value`,
      );
      return;
    case "tuple": {
      const beforeMembers = before.members ?? [];
      const afterMembers = after.members ?? [];
      if (beforeMembers.length !== afterMembers.length) {
        // A length change re-shapes the whole value — report once at the tuple.
        makeEntry(
          {
            severity: "breaking",
            kind: kindForPath,
            actionId,
            path: pathPrefix,
            message: `${actionId} ${role} schema changed from ${schemaSummary(before)} to ${schemaSummary(after)}.`,
            before: schemaSummary(before),
            after: schemaSummary(after),
          },
          entries,
        );
        return;
      }
      for (let index = 0; index < beforeMembers.length; index += 1) {
        diffSchema(
          role,
          actionId,
          beforeMembers[index] ?? null,
          afterMembers[index] ?? null,
          entries,
          `${pathPrefix}.${index}`,
        );
      }
      return;
    }
    case "optional": {
      const beforeInner = before.inner ?? null;
      const afterInner = after.inner ?? null;
      diffSchema(role, actionId, beforeInner, afterInner, entries, pathPrefix);
      return;
    }
    case "object": {
      diffObjectSchema(role, actionId, before, after, entries, pathPrefix);
      return;
    }
    default:
      makeEntry(
        {
          severity: "breaking",
          kind: kindForPath,
          actionId,
          path: pathPrefix,
          message: `${actionId} ${role} schema changed from ${schemaSummary(before)} to ${schemaSummary(after)}.`,
          before: schemaSummary(before),
          after: schemaSummary(after),
        },
        entries,
      );
  }
}

function diffObjectSchema(
  // `payload` (a signal's push body) follows `output` compatibility rules — both
  // travel server → client, so an added field is ignored by old clients while a
  // removed or retyped field breaks them.
  role: "input" | "output" | "payload",
  actionId: string,
  before: ParsedSchema,
  after: ParsedSchema,
  entries: ContractDiffEntry[],
  pathPrefix: string,
): void {
  const beforeProperties = before.properties ?? {};
  const afterProperties = after.properties ?? {};
  const keys = [
    ...new Set([...Object.keys(beforeProperties), ...Object.keys(afterProperties)]),
  ].sort(compareStrings);

  for (const key of keys) {
    const beforeProperty = beforeProperties[key];
    const afterProperty = afterProperties[key];
    const fieldPath = `${pathPrefix}.${key}`;
    const beforeOptional = hasOptionalWrapper(beforeProperty);
    const afterOptional = hasOptionalWrapper(afterProperty);
    const beforeInner = unwrapOptional(beforeProperty);
    const afterInner = unwrapOptional(afterProperty);

    if (!beforeProperty && afterProperty) {
      makeEntry(
        {
          severity: role === "input" && !afterOptional ? "breaking" : "non-breaking",
          kind:
            role === "input"
              ? afterOptional
                ? "input-field-added-optional"
                : "input-field-added-required"
              : role === "output"
                ? "output-field-added"
                : "signal-payload-field-added",
          actionId,
          path: fieldPath,
          message:
            role === "input"
              ? afterOptional
                ? `${actionId} ${fieldPath} added as an optional field with type ${schemaSummary(afterInner)}.`
                : `${actionId} ${fieldPath} added as a required field with type ${schemaSummary(afterInner)}.`
              : `${actionId} ${fieldPath} added with type ${schemaSummary(afterInner)}.`,
          after: schemaSummary(afterInner),
        },
        entries,
      );
      continue;
    }

    if (beforeProperty && !afterProperty) {
      makeEntry(
        {
          severity: role === "input" ? "info" : "breaking",
          kind:
            role === "input"
              ? "input-field-removed"
              : role === "output"
                ? "output-field-removed"
                : "signal-payload-field-removed",
          actionId,
          path: fieldPath,
          message:
            role === "input"
              ? `${actionId} ${fieldPath} removed; unknown input fields are still ignored at runtime.`
              : `${actionId} ${fieldPath} removed.`,
          before: schemaSummary(beforeInner),
        },
        entries,
      );
      continue;
    }

    if (!beforeProperty || !afterProperty) {
      continue;
    }

    if (beforeOptional !== afterOptional) {
      if (role === "input") {
        makeEntry(
          {
            severity: afterOptional ? "info" : "breaking",
            kind: afterOptional ? "metadata-changed" : "input-field-added-required",
            actionId,
            path: fieldPath,
            message: afterOptional
              ? `${actionId} ${fieldPath} is now optional.`
              : `${actionId} ${fieldPath} is now required.`,
            before: schemaSummary(beforeInner),
            after: schemaSummary(afterInner),
          },
          entries,
        );
      } else {
        makeEntry(
          {
            severity: afterOptional ? "breaking" : "info",
            kind: "metadata-changed",
            actionId,
            path: fieldPath,
            message: afterOptional
              ? `${actionId} ${fieldPath} is now optional.`
              : `${actionId} ${fieldPath} is now required.`,
            before: schemaSummary(beforeInner),
            after: schemaSummary(afterInner),
          },
          entries,
        );
      }
    }

    diffSchema(role, actionId, beforeInner, afterInner, entries, fieldPath);
  }
}

function diffSignals(
  before: ActionContractSnapshot,
  after: ActionContractSnapshot,
  entries: ContractDiffEntry[],
): void {
  const beforeById = new Map((before.signals ?? []).map((signal) => [signal.id, signal] as const));
  const afterById = new Map((after.signals ?? []).map((signal) => [signal.id, signal] as const));
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort(compareStrings);

  for (const signalId of ids) {
    const previous = beforeById.get(signalId);
    const current = afterById.get(signalId);

    if (!previous && current) {
      makeEntry(
        {
          severity: "non-breaking",
          kind: "signal-added",
          actionId: signalId,
          message: `${signalId} signal added.`,
        },
        entries,
      );
      continue;
    }

    if (previous && !current) {
      // Subscribed clients keep waiting on a push that will never arrive.
      makeEntry(
        {
          severity: "breaking",
          kind: "signal-removed",
          actionId: signalId,
          message: `${signalId} signal removed.`,
        },
        entries,
      );
      continue;
    }

    if (!previous || !current) {
      continue;
    }

    if (previous.source !== current.source) {
      makeEntry(
        {
          severity: "non-breaking",
          kind: "signal-source-changed",
          actionId: signalId,
          path: "source",
          message: `${signalId} source path changed from ${previous.source} to ${current.source}.`,
          before: previous.source,
          after: current.source,
        },
        entries,
      );
    }

    if (previous.moduleKind !== current.moduleKind) {
      makeEntry(
        {
          severity: "info",
          kind: "metadata-changed",
          actionId: signalId,
          path: "moduleKind",
          message: `${signalId} module classification changed from ${previous.moduleKind} to ${current.moduleKind}.`,
          before: previous.moduleKind,
          after: current.moduleKind,
        },
        entries,
      );
    }

    if (previous.serialization.policy !== current.serialization.policy) {
      makeEntry(
        {
          severity: "breaking",
          kind: "serialization-policy-changed",
          actionId: signalId,
          path: "serialization.policy",
          message: `${signalId} serialization policy changed from ${previous.serialization.policy} to ${current.serialization.policy}.`,
          before: previous.serialization.policy,
          after: current.serialization.policy,
        },
        entries,
      );
    }

    diffSchema(
      "payload",
      signalId,
      previous.payload.schema ?? null,
      current.payload.schema ?? null,
      entries,
    );
  }
}

export function diffActionContractSnapshots(
  before: ActionContractSnapshot,
  after: ActionContractSnapshot,
): ContractDiffResult {
  const entries: ContractDiffEntry[] = [];

  diffProjectMetadata(before, after, entries);
  diffActions(before, after, entries);
  diffSignals(before, after, entries);

  entries.sort(
    (left, right) =>
      severityRank(left.severity) - severityRank(right.severity) ||
      compareStrings(left.actionId ?? "", right.actionId ?? "") ||
      compareStrings(left.kind, right.kind) ||
      compareStrings(left.path ?? "", right.path ?? "") ||
      compareStrings(left.message, right.message),
  );

  const summary = {
    breaking: entries.filter((entry) => entry.severity === "breaking").length,
    nonBreaking: entries.filter((entry) => entry.severity === "non-breaking").length,
    info: entries.filter((entry) => entry.severity === "info").length,
  };

  return {
    version: 1,
    summary,
    entries,
  };
}

function commandTitle(command: string, colors: CliColorMode): string {
  return formatBrandTitle(`aruna ${command}`, colors);
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function groupEntries(
  entries: readonly ContractDiffEntry[],
): Map<ContractDiffSeverity, ContractDiffEntry[]> {
  const grouped = new Map<ContractDiffSeverity, ContractDiffEntry[]>([
    ["breaking", []],
    ["non-breaking", []],
    ["info", []],
  ]);

  for (const entry of entries) {
    grouped.get(entry.severity)?.push(entry);
  }

  return grouped;
}

function renderEntryBlock(entry: ContractDiffEntry): string[] {
  const lines: string[] = [];
  const label = entry.actionId ?? "project";
  lines.push(`    ${label}`);
  lines.push(`      ${entry.message}`);

  if (entry.before !== undefined || entry.after !== undefined) {
    if (entry.before !== undefined) {
      lines.push(`      before: ${formatValue(entry.before)}`);
    }
    if (entry.after !== undefined) {
      lines.push(`      after: ${formatValue(entry.after)}`);
    }
  }

  return lines;
}

export function formatContractDiffReport(
  result: ContractDiffResult,
  context: ContractDiffRenderContext,
): string {
  const lines: string[] = [commandTitle("contract diff", context.colors), ""];
  lines.push(`  baseline: ${context.baselineLabel}`);
  lines.push(`  current: ${context.currentLabel}`);
  lines.push("");

  if (result.entries.length === 0) {
    lines.push("  no contract changes");
    return lines.join("\n");
  }

  const summaryParts: string[] = [];
  if (result.summary.breaking > 0) {
    summaryParts.push(pluralize(result.summary.breaking, "breaking change", "breaking changes"));
  }
  if (result.summary.nonBreaking > 0) {
    summaryParts.push(
      pluralize(result.summary.nonBreaking, "non-breaking change", "non-breaking changes"),
    );
  }
  if (result.summary.info > 0) {
    summaryParts.push(pluralize(result.summary.info, "info change", "info changes"));
  }

  for (const part of summaryParts) {
    lines.push(`  ${part}`);
  }
  lines.push("");

  const groupedEntries = groupEntries(result.entries);
  for (const severity of ["breaking", "non-breaking", "info"] as const) {
    const grouped = groupedEntries.get(severity) ?? [];
    if (grouped.length === 0) {
      continue;
    }

    lines.push(`  ${severity}`);
    for (const entry of grouped) {
      lines.push(...renderEntryBlock(entry));
      lines.push("");
    }
    if (lines[lines.length - 1] === "") {
      lines.pop();
    }
    lines.push("");
  }

  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  if (result.summary.breaking > 0) {
    lines.push("");
    lines.push("  result: breaking changes detected");
  } else {
    lines.push("");
    lines.push("  result: compatible");
  }

  return lines.join("\n").trimEnd();
}

function formatContractDiffFailure(
  message: string,
  context: ContractDiffRenderContext,
  diagnostics?: readonly Diagnostic[],
): string {
  const lines: string[] = [commandTitle("contract diff", context.colors), ""];
  lines.push(`  baseline: ${context.baselineLabel}`);
  lines.push(`  current: ${context.currentLabel}`);
  lines.push("");
  lines.push(`  ${message}`);

  if (diagnostics && diagnostics.length > 0) {
    lines.push("");
    lines.push(formatMuted("  diagnostics", context.colors));
    for (const diagnostic of diagnostics) {
      lines.push(`  ${diagnostic.severity} ${diagnostic.code} ${diagnostic.name}`);
      if (diagnostic.file) {
        lines.push(`    ${diagnostic.file}`);
      }
      lines.push(`    ${diagnostic.message}`);
      if (diagnostic.details) {
        lines.push("    details");
        for (const line of diagnostic.details.split("\n")) {
          lines.push(`    ${line}`);
        }
      }
      if (diagnostic.suggestion) {
        lines.push("    suggested fix");
        lines.push(`    ${diagnostic.suggestion}`);
      }
      lines.push("");
    }
    if (lines[lines.length - 1] === "") {
      lines.pop();
    }
  }

  return lines.join("\n").trimEnd();
}

async function readSnapshotFile(filePath: string): Promise<ActionContractSnapshot> {
  const contents = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(contents) as unknown;
  return parseActionContractSnapshotJson(parsed);
}

function resolveWorkspacePath(
  input: string,
  cwd = process.env["INIT_CWD"] ?? process.cwd(),
): string {
  return path.resolve(cwd, input);
}

function validateCommandMode(
  options: Readonly<{
    project?: string;
    baseline?: string;
    from?: string;
    to?: string;
  }>,
): ContractDiffCommandMode {
  const hasBaselineMode = options.project !== undefined || options.baseline !== undefined;
  const hasFileMode = options.from !== undefined || options.to !== undefined;

  if (hasBaselineMode && hasFileMode) {
    throw new Error("Do not mix --project / --baseline with --from / --to.");
  }

  if (hasBaselineMode) {
    if (options.project === undefined) {
      throw new Error("--baseline requires --project.");
    }
    if (options.baseline === undefined) {
      throw new Error("--project requires --baseline.");
    }
    return {
      kind: "project",
      project: options.project,
      baseline: options.baseline,
    };
  }

  if (hasFileMode) {
    if (options.from === undefined) {
      throw new Error("--from requires --to.");
    }
    if (options.to === undefined) {
      throw new Error("--to requires --from.");
    }
    return {
      kind: "files",
      from: options.from,
      to: options.to,
    };
  }

  throw new Error("Use either --project with --baseline, or --from with --to.");
}

export async function runContractDiffCommand(options: {
  readonly project?: string;
  readonly baseline?: string;
  readonly from?: string;
  readonly to?: string;
  readonly json?: boolean;
  readonly noColor?: boolean;
  readonly color?: boolean;
  readonly quiet?: boolean;
  readonly verbose?: boolean;
  readonly warningsAsErrors?: boolean;
  readonly resolveColorMode: (input: {
    readonly json?: boolean;
    readonly noColor?: boolean;
    readonly color?: boolean;
  }) => CliColorMode;
  readonly inspectProject: (input: {
    readonly root: string;
    readonly configPath?: string;
  }) => Promise<CompilerOutput>;
}): Promise<{ readonly status: number; readonly stdout?: string; readonly stderr?: string }> {
  const mode = validateCommandMode(options);
  const colors = options.resolveColorMode(options);

  try {
    if (mode.kind === "files") {
      const before = await readSnapshotFile(resolveWorkspacePath(mode.from));
      const after = await readSnapshotFile(resolveWorkspacePath(mode.to));
      const result = diffActionContractSnapshots(before, after);
      if (options.json) {
        return {
          status: result.summary.breaking > 0 ? 1 : 0,
          stdout: `${JSON.stringify(result, null, 2)}\n`,
          stderr: "",
        };
      }

      return {
        status: result.summary.breaking > 0 ? 1 : 0,
        stdout: `${formatContractDiffReport(result, {
          colors,
          baselineLabel: normalizePath(mode.from),
          currentLabel: normalizePath(mode.to),
        })}\n`,
        stderr: "",
      };
    }

    const projectRoot = resolveWorkspacePath(mode.project);
    const baseline = await readSnapshotFile(resolveWorkspacePath(mode.baseline));
    const output = await options.inspectProject({ root: projectRoot });
    if (!output.ok) {
      if (options.json) {
        return {
          status: 2,
          stdout: `${JSON.stringify(output, null, 2)}\n`,
          stderr: "",
        };
      }

      return {
        status: 2,
        stdout: `${formatContractDiffFailure(
          "unable to compare: current project has compiler errors.",
          {
            colors,
            baselineLabel: normalizePath(mode.baseline),
            currentLabel: normalizePath(mode.project),
          },
          output.diagnostics,
        )}\n`,
        stderr: "",
      };
    }

    const current = buildActionContractSnapshot(output);
    const result = diffActionContractSnapshots(baseline, current);
    if (options.json) {
      return {
        status: result.summary.breaking > 0 ? 1 : 0,
        stdout: `${JSON.stringify(result, null, 2)}\n`,
        stderr: "",
      };
    }

    return {
      status: result.summary.breaking > 0 ? 1 : 0,
      stdout: `${formatContractDiffReport(result, {
        colors,
        baselineLabel: normalizePath(mode.baseline),
        currentLabel: normalizePath(mode.project),
      })}\n`,
      stderr: "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 2,
      stdout: "",
      stderr: `${formatError(message, colors)}\n`,
    };
  }
}
