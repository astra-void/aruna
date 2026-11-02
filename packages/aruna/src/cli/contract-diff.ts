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
  type ActionContractError,
  type ActionContractRecord,
  type ActionContractSnapshot,
  type ResourceContractRecord,
  type SignalContractRecord,
  type StoreContractRecord,
} from "./action-contracts.js";
import { contractSnapshotPath, readCommittedSnapshot } from "./contract-gate.js";
import { contractPrimitives } from "./primitives.js";
import { formatActionSchemaSummary } from "./format-action-schema.js";
import {
  compareConstraints,
  constraintsEqual,
  NUMERIC_CONSTRAINT_FIELDS,
  withoutConstraints,
  type ConstraintChange,
} from "./schema-constraints.js";
import { formatBrandTitle, formatError, formatMuted } from "./theme.js";
import type { CliColorMode } from "./format.js";

// `warning` marks a change that is not breaking but can quietly lose data: a
// store field removed at the same version is still in every saved record, and
// nothing reads it any more.
export type ContractDiffSeverity = "breaking" | "warning" | "non-breaking" | "info";

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
  | "idempotent-added"
  | "idempotent-removed"
  | "authority-changed"
  | "generated-export-changed"
  | "signal-added"
  | "signal-removed"
  | "signal-source-changed"
  | "signal-payload-changed"
  | "signal-payload-field-added"
  | "signal-payload-field-removed"
  | "signal-payload-field-type-changed"
  | "signal-wire-changed"
  | "resource-added"
  | "resource-removed"
  | "resource-source-changed"
  | "resource-scope-changed"
  | "resource-authorize-changed"
  | "action-authorize-changed"
  | "resource-value-changed"
  | "resource-value-field-added"
  | "resource-value-field-removed"
  | "resource-value-field-type-changed"
  | "store-added"
  | "store-removed"
  | "store-source-changed"
  | "store-kind-changed"
  | "store-scope-changed"
  | "store-version-bumped"
  | "store-version-bumped-without-migrate"
  | "store-version-decreased"
  | "store-schema-changed"
  | "store-field-added-required"
  | "store-field-added-optional"
  | "store-field-removed"
  | "store-field-type-changed"
  | "store-bound-tightened"
  | "store-constraint-changed"
  // A bound on an action's input or output, a signal's payload, or a declared
  // error's data moved: tighter (`maxLength` lowered, `.int()` added), looser,
  // or changed in a way the compiler cannot judge (a `.refine()` predicate). The
  // severity depends on the direction the value travels.
  | "constraint-tightened"
  | "constraint-loosened"
  | "constraint-changed"
  // One side is a version 1 snapshot, which predates recorded constraints.
  | "constraints-not-compared"
  // An error the action declares (`errors`), and the data it carries.
  | "error-added"
  | "error-removed"
  | "error-data-changed"
  | "error-data-field-added"
  | "error-data-field-removed"
  | "error-data-field-type-changed"
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
    readonly warning: number;
    readonly nonBreaking: number;
    readonly info: number;
  };
  readonly entries: readonly ContractDiffEntry[];
};

type ContractDiffCommandMode =
  | {
      readonly kind: "project";
      readonly project: string;
      // Undefined: the project's committed snapshot (`contract.snapshot`).
      readonly baseline: string | undefined;
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

type ParsedResourceContractRecord = ResourceContractRecord & {
  readonly value: {
    readonly summary: string;
    readonly schema: SchemaMetadata | null;
  };
};

type ParsedActionContractSnapshot = Omit<
  ActionContractSnapshot,
  "actions" | "signals" | "stores" | "resources"
> & {
  readonly actions: readonly ParsedActionContractRecord[];
  readonly signals?: readonly ParsedSignalContractRecord[];
  readonly stores?: readonly StoreContractRecord[];
  readonly resources?: readonly ParsedResourceContractRecord[];
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
    case "warning":
      return 1;
    case "non-breaking":
      return 2;
    case "info":
      return 3;
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

  // Union and tuple members, and a number's width. Dropping them made a
  // snapshot read back from disk compare unequal to (or, for widths, blind to)
  // the schema it was written from.
  if ("members" in value && value["members"] !== undefined) {
    if (!Array.isArray(value["members"])) {
      throw new Error(`${location}.members must be an array.`);
    }

    parsed.members = value["members"].map((entry, index) =>
      parseSchemaMetadata(entry, `${location}.members[${index}]`),
    );
  }

  if ("numericFormat" in value && value["numericFormat"] !== undefined) {
    if (typeof value["numericFormat"] !== "string") {
      throw new Error(`${location}.numericFormat must be a string.`);
    }

    parsed.numericFormat = value["numericFormat"];
  }

  for (const bound of NUMERIC_CONSTRAINT_FIELDS) {
    if (bound in value && value[bound] !== undefined) {
      if (typeof value[bound] !== "number" || !Number.isFinite(value[bound])) {
        throw new Error(`${location}.${bound} must be a finite number.`);
      }
      parsed[bound] = value[bound];
    }
  }

  if ("int" in value && value["int"] !== undefined) {
    if (typeof value["int"] !== "boolean") {
      throw new Error(`${location}.int must be a boolean.`);
    }
    parsed.int = value["int"];
  }

  if ("dynamicConstraints" in value && value["dynamicConstraints"] !== undefined) {
    const dynamic = value["dynamicConstraints"];
    if (!Array.isArray(dynamic) || dynamic.some((entry) => typeof entry !== "string")) {
      throw new Error(`${location}.dynamicConstraints must be an array of strings.`);
    }
    parsed.dynamicConstraints = [...(dynamic as string[])];
  }

  if ("constraintsHash" in value && value["constraintsHash"] !== undefined) {
    if (typeof value["constraintsHash"] !== "string") {
      throw new Error(`${location}.constraintsHash must be a string.`);
    }
    parsed.constraintsHash = value["constraintsHash"];
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
  if (value["strategy"] !== undefined && value["strategy"] !== "tokenBucket") {
    throw new Error(`${location}.strategy must be "tokenBucket" when present.`);
  }

  return {
    key: value["key"] as "player",
    windowMs: value["windowMs"],
    max: value["max"],
    ...(value["strategy"] === "tokenBucket" ? { strategy: "tokenBucket" as const } : {}),
  };
}

export function parseActionRecord(value: unknown, location: string): ParsedActionContractRecord {
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
    ...(value["idempotent"] === true ? { idempotent: true as const } : {}),
    ...(value["authorized"] === true ? { authorized: true as const } : {}),
    ...(value["errors"] !== undefined
      ? { errors: parseActionErrors(value["errors"], `${location}.errors`) }
      : {}),
    warnings: parsedWarnings,
  };

  return parsed;
}

function parseActionErrors(value: unknown, location: string): ActionContractError[] {
  if (!Array.isArray(value)) {
    throw new Error(`${location} must be an array.`);
  }
  return value.map((entry, index) => {
    const at = `${location}[${index}]`;
    if (!isRecordLike(entry) || typeof entry["name"] !== "string") {
      throw new Error(`${at}.name must be a string.`);
    }
    const data = entry["data"];
    if (data === null || data === undefined) {
      return { name: entry["name"], data: null };
    }
    if (!isRecordLike(data) || typeof data["summary"] !== "string") {
      throw new Error(`${at}.data must be null or an object with a summary.`);
    }
    return {
      name: entry["name"],
      data: {
        summary: data["summary"],
        schema:
          data["schema"] === null || data["schema"] === undefined
            ? null
            : parseSchemaMetadata(data["schema"], `${at}.data.schema`),
      },
    };
  });
}

export function parseStoreRecord(value: unknown, location: string): StoreContractRecord {
  if (!isRecordLike(value)) {
    throw new Error(`${location} must be an object.`);
  }
  if (typeof value["id"] !== "string") {
    throw new Error(`${location}.id must be a string.`);
  }
  if (typeof value["source"] !== "string") {
    throw new Error(`${location}.source must be a string.`);
  }
  if (value["kind"] !== "store" && value["kind"] !== "playerStore") {
    throw new Error(`${location}.kind must be "store" or "playerStore".`);
  }
  if (typeof value["version"] !== "number" || !Number.isInteger(value["version"])) {
    throw new Error(`${location}.version must be an integer.`);
  }
  if (value["scope"] !== null && typeof value["scope"] !== "string") {
    throw new Error(`${location}.scope must be a string or null.`);
  }
  if (typeof value["hasMigrate"] !== "boolean") {
    throw new Error(`${location}.hasMigrate must be a boolean.`);
  }
  if (!isRecordLike(value["schema"])) {
    throw new Error(`${location}.schema must be an object.`);
  }
  if (typeof value["schema"]["summary"] !== "string") {
    throw new Error(`${location}.schema.summary must be a string.`);
  }
  const warnings = value["warnings"];
  if (!Array.isArray(warnings) || warnings.some((warning) => typeof warning !== "string")) {
    throw new Error(`${location}.warnings must be an array of strings.`);
  }

  return {
    id: value["id"],
    source: normalizePath(value["source"]),
    kind: value["kind"],
    version: value["version"],
    scope: value["scope"],
    hasMigrate: value["hasMigrate"],
    schema: {
      summary: value["schema"]["summary"],
      schema:
        value["schema"]["schema"] === null || value["schema"]["schema"] === undefined
          ? null
          : parseSchemaMetadata(value["schema"]["schema"], `${location}.schema.schema`),
    },
    warnings: warnings as string[],
  };
}

// A store is the DataStore it names: the same id under another scope is a
// different set of records.
export function storeIdentity(store: StoreContractRecord): string {
  return store.scope === null ? store.id : `${store.id}@${store.scope}`;
}

export function parseResourceRecord(value: unknown, location: string): ParsedResourceContractRecord {
  if (!isRecordLike(value)) {
    throw new Error(`${location} must be an object.`);
  }
  if (typeof value["id"] !== "string") {
    throw new Error(`${location}.id must be a string.`);
  }
  if (typeof value["source"] !== "string") {
    throw new Error(`${location}.source must be a string.`);
  }
  if (value["scope"] !== "player" && value["scope"] !== "global") {
    throw new Error(`${location}.scope must be "player" or "global".`);
  }
  if (!isRecordLike(value["value"]) || typeof value["value"]["summary"] !== "string") {
    throw new Error(`${location}.value must be an object with a summary.`);
  }
  if (!isRecordLike(value["serialization"]) || typeof value["serialization"]["policy"] !== "string") {
    throw new Error(`${location}.serialization.policy must be a string.`);
  }
  if (!Array.isArray(value["warnings"]) || value["warnings"].some((warning) => typeof warning !== "string")) {
    throw new Error(`${location}.warnings must be an array of strings.`);
  }
  return {
    id: value["id"],
    source: normalizePath(value["source"]),
    moduleKind:
      typeof value["moduleKind"] === "string"
        ? (value["moduleKind"] as ResourceContractRecord["moduleKind"])
        : "unknown",
    direction: "server-to-client",
    scope: value["scope"],
    ...(value["authorized"] === true ? { authorized: true as const } : {}),
    value: {
      summary: value["value"]["summary"],
      schema:
        value["value"]["schema"] === null || value["value"]["schema"] === undefined
          ? null
          : parseSchemaMetadata(value["value"]["schema"], `${location}.value.schema`),
    },
    serialization: {
      policy: value["serialization"]["policy"] as "plain-data-v1",
    },
    warnings: value["warnings"] as string[],
  };
}

export function parseSignalRecord(value: unknown, location: string): ParsedSignalContractRecord {
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
    ...(value["wire"] === "binary" ? { wire: "binary" as const } : {}),
    ...(typeof value["maxEncodedBytes"] === "number"
      ? { maxEncodedBytes: value["maxEncodedBytes"] }
      : {}),
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
  const version = value["version"];
  if (version !== 1 && version !== 2) {
    throw new Error(`${location}.version must be 1 or 2.`);
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
  // A required primitive's array is checked up front, before its records; an
  // optional one (the writer omits it when empty) only when present.
  const primitives = contractPrimitives();
  for (const primitive of primitives) {
    if (primitive.required && !Array.isArray(value[primitive.key])) {
      throw new Error(`${location}.${primitive.key} must be an array.`);
    }
  }
  if (!Array.isArray(value["diagnostics"])) {
    throw new Error(`${location}.diagnostics must be an array.`);
  }

  const records: Record<string, unknown[]> = {};
  for (const primitive of primitives) {
    const raw = value[primitive.key];
    if (raw === undefined) {
      continue;
    }
    if (!Array.isArray(raw)) {
      throw new Error(`${location}.${primitive.key} must be an array.`);
    }
    const parsed: unknown[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of raw.entries()) {
      const record = primitive.parseRecord(entry, `${location}.${primitive.key}[${index}]`);
      const identity = primitive.identity(record);
      if (seen.has(identity)) {
        throw new Error(primitive.duplicateMessage(`${location}.${primitive.key}`, record));
      }
      seen.add(identity);
      parsed.push(record);
    }
    records[primitive.key] = parsed;
  }

  const diagnostics: Diagnostic[] = [];
  for (const [index, diagnostic] of value["diagnostics"].entries()) {
    diagnostics.push(parseDiagnostic(diagnostic, `${location}.diagnostics[${index}]`));
  }

  if (value["generatedAt"] !== null && value["generatedAt"] !== undefined) {
    throw new Error(`${location}.generatedAt must be null.`);
  }

  return {
    version,
    project: {
      root: normalizePath(value["project"]["root"]),
      generatedDir: normalizePath(value["project"]["generatedDir"]),
      manifest: normalizePath(value["project"]["manifest"]),
    },
    ...records,
    diagnostics,
    generatedAt: null,
  } as unknown as ParsedActionContractSnapshot;
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

  if (left.kind !== right.kind || !constraintsEqual(left, right)) {
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

export function diffActions(
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
    diffIdempotent(actionId, previous.idempotent === true, current.idempotent === true, entries);
    // Who may call is the server's own policy: neither side of the wire is
    // built against it, so a change is reported, not judged.
    if ((previous.authorized === true) !== (current.authorized === true)) {
      makeEntry(
        {
          severity: "info",
          kind: "action-authorize-changed",
          actionId,
          path: "authorized",
          message: current.authorized === true
            ? `${actionId} now authorizes calls.`
            : `${actionId} no longer authorizes calls.`,
        },
        entries,
      );
    }
    diffSchema("input", actionId, previous.input.schema, current.input.schema, entries);
    diffSchema("output", actionId, previous.output.schema, current.output.schema, entries);
    diffErrors(actionId, previous.errors ?? [], current.errors ?? [], entries);
  }
}

// The errors a client is built to tell apart. A new one is a name an old client
// does not know, which it reads as any other failure; one removed only leaves
// an old client's handling of it unused. The data travels server → client, so
// it follows the output rules — except that data appearing where there was
// none is harmless to a client that never read it.
function diffErrors(
  actionId: string,
  before: readonly ActionContractError[],
  after: readonly ActionContractError[],
  entries: ContractDiffEntry[],
): void {
  const beforeByName = new Map(before.map((error) => [error.name, error] as const));
  const afterByName = new Map(after.map((error) => [error.name, error] as const));
  const names = [...new Set([...beforeByName.keys(), ...afterByName.keys()])].sort(compareStrings);

  for (const name of names) {
    const was = beforeByName.get(name);
    const now = afterByName.get(name);
    const path = `errors.${name}`;
    if (was === undefined && now !== undefined) {
      makeEntry(
        {
          severity: "non-breaking",
          kind: "error-added",
          actionId,
          path,
          message: `${actionId} error ${name} added${now.data !== null ? ` with data ${now.data.summary}` : ""}.`,
          ...(now.data !== null ? { after: now.data.summary } : {}),
        },
        entries,
      );
      continue;
    }
    if (was !== undefined && now === undefined) {
      makeEntry(
        {
          severity: "info",
          kind: "error-removed",
          actionId,
          path,
          message: `${actionId} error ${name} removed; a client's handling of it is no longer reached.`,
          ...(was.data !== null ? { before: was.data.summary } : {}),
        },
        entries,
      );
      continue;
    }
    if (was === undefined || now === undefined) {
      continue;
    }
    if (was.data === null && now.data !== null) {
      makeEntry(
        {
          severity: "non-breaking",
          kind: "error-data-changed",
          actionId,
          path: `${path}.data`,
          message: `${actionId} error ${name} now carries data ${now.data.summary}.`,
          after: now.data.summary,
        },
        entries,
      );
      continue;
    }
    if (was.data !== null && now.data === null) {
      makeEntry(
        {
          severity: "breaking",
          kind: "error-data-changed",
          actionId,
          path: `${path}.data`,
          message: `${actionId} error ${name} no longer carries data.`,
          before: was.data.summary,
        },
        entries,
      );
      continue;
    }
    if (was.data !== null && now.data !== null) {
      diffSchema("error", actionId, was.data.schema, now.data.schema, entries, `${path}.data`);
    }
  }
}

// Dropping `idempotent` is breaking: a client built against the old contract
// still retries a timed-out call, and the action no longer promises that a
// second run is harmless. Adding it only lets clients retry more.
function diffIdempotent(
  actionId: string,
  before: boolean,
  after: boolean,
  entries: ContractDiffEntry[],
): void {
  if (before === after) {
    return;
  }

  makeEntry(
    before
      ? {
          severity: "breaking",
          kind: "idempotent-removed",
          actionId,
          path: "idempotent",
          message: `${actionId} is no longer idempotent; clients that retry a timed-out call may run it twice.`,
          before: true,
          after: false,
        }
      : {
          severity: "non-breaking",
          kind: "idempotent-added",
          actionId,
          path: "idempotent",
          message: `${actionId} is now idempotent; a timed-out call may be retried.`,
          before: false,
          after: true,
        },
    entries,
  );
}

// A rate limit as the diff prints it. The default fixed window is not named, so
// its text is what it has always been.
function describeRateLimit(limit: NonNullable<ActionContractRecord["rateLimit"]>): string {
  const strategy = limit.strategy === "tokenBucket" ? " (token bucket)" : "";
  return `${limit.key}, max ${limit.max} / ${limit.windowMs}ms${strategy}`;
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
        message: `${actionId} rate limit added: ${describeRateLimit(after)}.`,
        after: `rate limit ${describeRateLimit(after)}`,
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
        before: `rate limit ${describeRateLimit(before)}`,
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

  // The strategy changes how a burst is counted, not how many calls a window
  // allows: a client that keeps to `max` in any `windowMs` is admitted by
  // either, so a change is reported but breaks nothing on its own.
  const beforeStrategy = before.strategy ?? "fixedWindow";
  const afterStrategy = after.strategy ?? "fixedWindow";
  if (beforeStrategy !== afterStrategy) {
    makeEntry(
      {
        severity: "info",
        kind: "metadata-changed",
        actionId,
        path: "rateLimit.strategy",
        message: `${actionId} rate limit strategy changed from ${beforeStrategy} to ${afterStrategy}.`,
        before: beforeStrategy,
        after: afterStrategy,
      },
      entries,
    );
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
        message: `${actionId} rate limit tightened: changed from ${describeRateLimit(before)} to ${describeRateLimit(after)}.`,
        before: `rate limit ${describeRateLimit(before)}`,
        after: `rate limit ${describeRateLimit(after)}`,
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
        message: `${actionId} rate limit loosened: changed from ${describeRateLimit(before)} to ${describeRateLimit(after)}.`,
        before: `rate limit ${describeRateLimit(before)}`,
        after: `rate limit ${describeRateLimit(after)}`,
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
        message: `${actionId} rate limit changed from ${describeRateLimit(before)} to ${describeRateLimit(after)}.`,
        before,
        after,
      },
      entries,
    );
  }
}

// Whose schema is compared: an action's input or output, a signal's payload, or
// the data of an error an action declares. Everything but input travels server
// → client and follows the output rules.
// `value` is a resource's value: like a signal payload, it travels server →
// client, so it follows the output rules.
type SchemaDiffRole = "input" | "output" | "payload" | "error" | "value";

// Where a role's schema starts: `input`, or `errors.<Name>.data` for an error.
function isSchemaRoot(role: SchemaDiffRole, path: string): boolean {
  return role === "error" ? /^errors\.[^.]+\.data$/.test(path) : path === role;
}

function diffSchema(
  role: SchemaDiffRole,
  actionId: string,
  before: ParsedSchema | null | undefined,
  after: ParsedSchema | null | undefined,
  entries: ContractDiffEntry[],
  pathPrefix: string = role,
): void {
  const atRoot = isSchemaRoot(role, pathPrefix);
  const kindForPath: ContractDiffKind = atRoot
    ? role === "input"
      ? "input-schema-changed"
      : role === "output"
        ? "output-schema-changed"
        : role === "error"
          ? "error-data-changed"
          : role === "value"
            ? "resource-value-changed"
            : "signal-payload-changed"
    : role === "input"
      ? "input-field-type-changed"
      : role === "output"
        ? "output-field-type-changed"
        : role === "error"
          ? "error-data-field-type-changed"
          : role === "value"
            ? "resource-value-field-type-changed"
            : "signal-payload-field-type-changed";
  const subject = role === "error" ? "error data" : role;

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
            ? `${actionId} ${subject} schema added with ${schemaSummary(after)}.`
            : `${actionId} ${subject} schema removed.`,
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
        message: `${actionId} ${subject} schema changed from ${schemaSummary(before)} to ${schemaSummary(after)}.`,
        before: schemaSummary(before),
        after: schemaSummary(after),
      },
      entries,
    );
    return;
  }

  diffConstraints(role, actionId, before, after, entries, pathPrefix);

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
            message: `${actionId} ${subject} schema changed from ${schemaSummary(before)} to ${schemaSummary(after)}.`,
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
            message: `${actionId} ${subject} schema changed from ${schemaSummary(before)} to ${schemaSummary(after)}.`,
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
            message: `${actionId} ${subject} schema changed from ${schemaSummary(before)} to ${schemaSummary(after)}.`,
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
          message: `${actionId} ${subject} schema changed from ${schemaSummary(before)} to ${schemaSummary(after)}.`,
          before: schemaSummary(before),
          after: schemaSummary(after),
        },
        entries,
      );
  }
}

// The severity of a bound that moved, by the direction the value travels. An
// input goes client → server: a tighter bound refuses what a client built
// against the old contract may still send, while a looser one only accepts
// more. An output, a signal payload, or an error's data goes the other way, so
// it is the looser bound that hands such a client a value outside what it was
// promised. A change the compiler cannot judge (a `.refine()` predicate) is a
// warning either way.
function constraintSeverity(
  role: SchemaDiffRole,
  change: ConstraintChange,
): ContractDiffSeverity {
  if (change.direction === "changed") {
    return "warning";
  }
  const refusesMore = change.direction === "tightened";
  return refusesMore === (role === "input") ? "breaking" : "non-breaking";
}

function diffConstraints(
  role: SchemaDiffRole,
  actionId: string,
  before: ParsedSchema,
  after: ParsedSchema,
  entries: ContractDiffEntry[],
  path: string,
): void {
  for (const change of compareConstraints(before, after)) {
    makeEntry(
      {
        severity: constraintSeverity(role, change),
        kind:
          change.direction === "tightened"
            ? "constraint-tightened"
            : change.direction === "loosened"
              ? "constraint-loosened"
              : "constraint-changed",
        actionId,
        path,
        message: `${actionId} ${path} ${change.description}.`,
        ...(change.before !== undefined ? { before: change.before } : {}),
        ...(change.after !== undefined ? { after: change.after } : {}),
      },
      entries,
    );
  }
}

function diffObjectSchema(
  // `payload` (a signal's push body) and `error` (a declared error's data)
  // follow `output` compatibility rules — all three travel server → client, so
  // an added field is ignored by old clients while a removed or retyped field
  // breaks them.
  role: SchemaDiffRole,
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
                : role === "error"
                  ? "error-data-field-added"
                  : role === "value"
                    ? "resource-value-field-added"
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
                : role === "error"
                  ? "error-data-field-removed"
                  : role === "value"
                    ? "resource-value-field-removed"
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

export function diffSignals(
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

    // A client built against the other encoding cannot read the payload.
    if ((previous.wire ?? "table") !== (current.wire ?? "table")) {
      makeEntry(
        {
          severity: "breaking",
          kind: "signal-wire-changed",
          actionId: signalId,
          path: "wire",
          message: `${signalId} wire changed from ${previous.wire ?? "table"} to ${current.wire ?? "table"}.`,
          before: previous.wire ?? "table",
          after: current.wire ?? "table",
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

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------
//
// A resource's value reaches subscribed clients, so it is diffed like a signal
// payload. Its id and its scope are what a client subscribes by and what the
// value means; changing either breaks a client built against the other.
export function diffResources(
  before: ActionContractSnapshot,
  after: ActionContractSnapshot,
  entries: ContractDiffEntry[],
): void {
  const beforeById = new Map((before.resources ?? []).map((resource) => [resource.id, resource] as const));
  const afterById = new Map((after.resources ?? []).map((resource) => [resource.id, resource] as const));
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort(compareStrings);

  for (const resourceId of ids) {
    const previous = beforeById.get(resourceId);
    const current = afterById.get(resourceId);
    if (!previous && current) {
      makeEntry(
        { severity: "non-breaking", kind: "resource-added", actionId: resourceId, message: `${resourceId} resource added.` },
        entries,
      );
      continue;
    }
    if (previous && !current) {
      // A subscribed client waits on a snapshot that never comes.
      makeEntry(
        { severity: "breaking", kind: "resource-removed", actionId: resourceId, message: `${resourceId} resource removed.` },
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
          kind: "resource-source-changed",
          actionId: resourceId,
          path: "source",
          message: `${resourceId} source path changed from ${previous.source} to ${current.source}.`,
          before: previous.source,
          after: current.source,
        },
        entries,
      );
    }
    if (previous.scope !== current.scope) {
      makeEntry(
        {
          severity: "breaking",
          kind: "resource-scope-changed",
          actionId: resourceId,
          path: "scope",
          message: `${resourceId} scope changed from ${previous.scope} to ${current.scope}.`,
          before: previous.scope,
          after: current.scope,
        },
        entries,
      );
    }
    if ((previous.authorized === true) !== (current.authorized === true)) {
      makeEntry(
        {
          severity: "info",
          kind: "resource-authorize-changed",
          actionId: resourceId,
          path: "authorized",
          message: current.authorized === true
            ? `${resourceId} now authorizes subscriptions.`
            : `${resourceId} no longer authorizes subscriptions.`,
        },
        entries,
      );
    }
    if (previous.serialization.policy !== current.serialization.policy) {
      makeEntry(
        {
          severity: "breaking",
          kind: "serialization-policy-changed",
          actionId: resourceId,
          path: "serialization.policy",
          message: `${resourceId} serialization policy changed from ${previous.serialization.policy} to ${current.serialization.policy}.`,
          before: previous.serialization.policy,
          after: current.serialization.policy,
        },
        entries,
      );
    }
    diffSchema("value", resourceId, previous.value.schema ?? null, current.value.schema ?? null, entries);
  }
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------
//
// The question for a store is not client/server but old code/new code: can
// this build read a record the previous build wrote? At the same version
// nothing converts the record on the way in, so the new schema has to accept
// everything the old one did — input-compatibility semantics, with the old
// schema as the writer and the new one as the reader. A version bump hands old
// records to `migrate` instead, so the schemas are not compared across it.

// The numbers each format accepts. Floats accept any finite number.
const NUMERIC_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  u8: [0, 255],
  u16: [0, 65_535],
  u32: [0, 4_294_967_295],
  i8: [-128, 127],
  i16: [-32_768, 32_767],
  i32: [-2_147_483_648, 2_147_483_647],
};

// Whether a number schema of `reader` format accepts every value one of
// `writer` format does.
function numericFormatAccepts(writer: string | undefined, reader: string | undefined): boolean {
  const readerRange = reader === undefined ? undefined : NUMERIC_RANGES[reader];
  if (readerRange === undefined) {
    return true;
  }
  const writerRange = writer === undefined ? undefined : NUMERIC_RANGES[writer];
  if (writerRange === undefined) {
    return false;
  }
  return writerRange[0] >= readerRange[0] && writerRange[1] <= readerRange[1];
}

function literalKind(literal: SchemaLiteralMetadata | undefined): string | undefined {
  return literal?.kind;
}

// Structural equality that, unlike `schemaNodesEqual`, also tells number
// formats apart: for a saved record, `u8` and `number` are not the same schema.
function storeSchemaNodesEqual(
  left: ParsedSchema | null | undefined,
  right: ParsedSchema | null | undefined,
): boolean {
  const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, entry: unknown) =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry)
        ? Object.fromEntries(
            Object.entries(entry as Record<string, unknown>).sort(([a], [b]) =>
              compareStrings(a, b),
            ),
          )
        : entry,
    );
  return canonical(left ?? null) === canonical(right ?? null);
}

// Whether a reader of one kind accepts every value a writer of another kind
// can produce. Covers the widenings worth recognizing (a literal or enum read
// as its primitive, a literal read through an enum or union that contains it);
// anything else across kinds is a change.
function crossKindAccepts(writer: ParsedSchema, reader: ParsedSchema): boolean {
  if (writer.kind === "literal") {
    const kind = literalKind(writer.literal);
    if (reader.kind === "string" || reader.kind === "boolean") {
      return kind === reader.kind;
    }
    if (reader.kind === "number") {
      return kind === "number" && reader.numericFormat === undefined;
    }
    if (reader.kind === "enum" && writer.literal !== undefined) {
      const literal = writer.literal;
      return (reader.values ?? []).some((value) => compareLiteralValues(value, literal) === 0);
    }
  }
  if (writer.kind === "enum" && (reader.kind === "string" || reader.kind === "number")) {
    return (writer.values ?? []).every(
      (value) => value.kind === reader.kind && reader.numericFormat === undefined,
    );
  }
  if (reader.kind === "union") {
    return (reader.members ?? []).some((member) => storeSchemaNodesEqual(writer, member));
  }
  return false;
}

function storeChange(
  storeId: string,
  severity: ContractDiffSeverity,
  kind: ContractDiffKind,
  path: string,
  message: string,
  before: ParsedSchema | null | undefined,
  after: ParsedSchema | null | undefined,
  entries: ContractDiffEntry[],
): void {
  makeEntry(
    {
      severity,
      kind,
      actionId: storeId,
      path,
      message,
      ...(before !== undefined && before !== null ? { before: schemaSummary(before) } : {}),
      ...(after !== undefined && after !== null ? { after: schemaSummary(after) } : {}),
    },
    entries,
  );
}

// A bound the reader adds or tightens (`maxLength` lowered, `.min(0)` or
// `.int()` or a `.refine()` added) refuses saved values the writer allowed, so
// it is breaking at the same version. Raising or dropping one is compatible.
// What the compiler cannot judge (a predicate, a bound computed at runtime) is
// a warning: saved records were never checked against it.
function diffStoreConstraints(
  storeId: string,
  writer: ParsedSchema,
  reader: ParsedSchema,
  entries: ContractDiffEntry[],
  path: string,
): void {
  for (const change of compareConstraints(writer, reader)) {
    if (change.direction === "loosened") {
      continue;
    }
    if (change.direction === "changed") {
      storeChange(
        storeId,
        "warning",
        "store-constraint-changed",
        path,
        `${storeId} ${path} constraint changed; saved records not verified. Check that every record saved under the old constraints still passes the new ones, or bump the version with a migrate.`,
        writer,
        reader,
        entries,
      );
      continue;
    }
    makeEntry(
      {
        severity: "breaking",
        kind: "store-bound-tightened",
        actionId: storeId,
        path,
        message: `${storeId} ${path} ${change.description}; saved records may not satisfy it and will fail to load.`,
        before: change.before ?? null,
        after: change.after ?? null,
      },
      entries,
    );
  }
}

// `writer` is the schema records were saved under, `reader` the one that will
// read them now.
function diffStoreSchema(
  storeId: string,
  writer: ParsedSchema | null | undefined,
  reader: ParsedSchema | null | undefined,
  entries: ContractDiffEntry[],
  path: string,
): void {
  if (storeSchemaNodesEqual(writer, reader)) {
    return;
  }
  const changeKind: ContractDiffKind =
    path === "schema" ? "store-schema-changed" : "store-field-type-changed";
  const breaking = (message: string): void => {
    storeChange(storeId, "breaking", changeKind, path, message, writer, reader, entries);
  };

  if (!writer || !reader) {
    breaking(`${storeId} ${path} schema metadata is unavailable on one side, so saved records cannot be checked.`);
    return;
  }

  // Optionality first: an absent value the writer allowed must still read.
  if (reader.kind === "optional") {
    diffStoreSchema(storeId, unwrapOptional(writer), reader.inner ?? null, entries, path);
    return;
  }
  if (writer.kind === "optional") {
    breaking(`${storeId} ${path} is now required, but saved records may not have it.`);
    return;
  }

  if (writer.kind !== reader.kind) {
    if (!crossKindAccepts(writer, reader)) {
      breaking(
        `${storeId} ${path} changed from ${schemaSummary(writer)} to ${schemaSummary(reader)}; saved records no longer match.`,
      );
    }
    return;
  }

  diffStoreConstraints(storeId, writer, reader, entries, path);

  switch (reader.kind) {
    case "string":
      return;
    case "number":
      if (!numericFormatAccepts(writer.numericFormat, reader.numericFormat)) {
        breaking(
          `${storeId} ${path} narrowed from ${schemaSummary(writer)} to ${schemaSummary(reader)}; saved values may fall outside it.`,
        );
      }
      return;
    case "literal":
      if (
        writer.literal === undefined ||
        reader.literal === undefined ||
        compareLiteralValues(writer.literal, reader.literal) !== 0
      ) {
        breaking(`${storeId} ${path} changed from ${schemaSummary(writer)} to ${schemaSummary(reader)}.`);
      }
      return;
    case "enum": {
      const readerValues = reader.values ?? [];
      const dropped = (writer.values ?? []).filter(
        (value) => !readerValues.some((candidate) => compareLiteralValues(candidate, value) === 0),
      );
      if (dropped.length > 0) {
        breaking(
          `${storeId} ${path} narrowed from ${schemaSummary(writer)} to ${schemaSummary(reader)}; saved records may hold a removed value.`,
        );
      }
      return;
    }
    case "union": {
      const readerMembers = reader.members ?? [];
      const unread = (writer.members ?? []).filter(
        (member) => !readerMembers.some((candidate) => storeSchemaNodesEqual(member, candidate)),
      );
      if (unread.length > 0) {
        breaking(
          `${storeId} ${path} narrowed from ${schemaSummary(writer)} to ${schemaSummary(reader)}; saved records may hold a removed member.`,
        );
      }
      return;
    }
    case "array":
      diffStoreSchema(storeId, writer.items ?? null, reader.items ?? null, entries, `${path}[]`);
      return;
    case "record":
      diffStoreSchema(storeId, writer.items ?? null, reader.items ?? null, entries, `${path}.value`);
      return;
    case "tuple": {
      const writerMembers = writer.members ?? [];
      const readerMembers = reader.members ?? [];
      if (writerMembers.length !== readerMembers.length) {
        breaking(`${storeId} ${path} changed from ${schemaSummary(writer)} to ${schemaSummary(reader)}.`);
        return;
      }
      for (let index = 0; index < readerMembers.length; index += 1) {
        diffStoreSchema(
          storeId,
          writerMembers[index] ?? null,
          readerMembers[index] ?? null,
          entries,
          `${path}.${index}`,
        );
      }
      return;
    }
    case "object": {
      const writerFields = writer.properties ?? {};
      const readerFields = reader.properties ?? {};
      const keys = [
        ...new Set([...Object.keys(writerFields), ...Object.keys(readerFields)]),
      ].sort(compareStrings);
      for (const key of keys) {
        const fieldPath = `${path}.${key}`;
        const written = writerFields[key];
        const read = readerFields[key];
        if (written === undefined && read !== undefined) {
          if (hasOptionalWrapper(read)) {
            storeChange(
              storeId,
              "non-breaking",
              "store-field-added-optional",
              fieldPath,
              `${storeId} ${fieldPath} added as optional (or with a .default()); saved records read without it.`,
              undefined,
              unwrapOptional(read),
              entries,
            );
          } else {
            storeChange(
              storeId,
              "breaking",
              "store-field-added-required",
              fieldPath,
              `${storeId} ${fieldPath} added as a required field with no .default(); every saved record lacks it and will fail to load. Add .default(...), or bump the version with a migrate.`,
              undefined,
              read,
              entries,
            );
          }
          continue;
        }
        if (written !== undefined && read === undefined) {
          storeChange(
            storeId,
            "warning",
            "store-field-removed",
            fieldPath,
            `${storeId} ${fieldPath} removed; saved records still hold it, and code that rebuilds the value will drop it on the next save.`,
            unwrapOptional(written),
            undefined,
            entries,
          );
          continue;
        }
        diffStoreSchema(storeId, written ?? null, read ?? null, entries, fieldPath);
      }
      return;
    }
    default:
      // boolean and the Roblox value kinds carry nothing beyond the kind.
      return;
  }
}

export function diffStores(
  before: ActionContractSnapshot,
  after: ActionContractSnapshot,
  entries: ContractDiffEntry[],
): void {
  const beforeByIdentity = new Map(
    (before.stores ?? []).map((store) => [storeIdentity(store), store] as const),
  );
  const afterByIdentity = new Map(
    (after.stores ?? []).map((store) => [storeIdentity(store), store] as const),
  );
  const identities = [...new Set([...beforeByIdentity.keys(), ...afterByIdentity.keys()])].sort(
    compareStrings,
  );

  for (const identity of identities) {
    const previous = beforeByIdentity.get(identity);
    const current = afterByIdentity.get(identity);

    if (!previous && current) {
      // Possibly the same store under a new scope: that is a different
      // DataStore, so the old scope's records are no longer reachable.
      const movedFrom = (before.stores ?? []).find(
        (store) => store.id === current.id && !afterByIdentity.has(storeIdentity(store)),
      );
      makeEntry(
        movedFrom !== undefined
          ? {
              severity: "breaking",
              kind: "store-scope-changed",
              actionId: current.id,
              path: "scope",
              message: `${current.id} moved from scope ${formatValue(movedFrom.scope)} to ${formatValue(current.scope)}; records saved under the old scope are no longer read.`,
              before: movedFrom.scope,
              after: current.scope,
            }
          : {
              severity: "non-breaking",
              kind: "store-added",
              actionId: current.id,
              message: `${current.id} store added.`,
            },
        entries,
      );
      continue;
    }

    if (previous && !current) {
      // Reported once, as the scope change, when the store only moved.
      if ((after.stores ?? []).some((store) => store.id === previous.id)) {
        continue;
      }
      makeEntry(
        {
          severity: "non-breaking",
          kind: "store-removed",
          actionId: previous.id,
          message: `${previous.id} store removed; its records stay in the DataStore, unread.`,
        },
        entries,
      );
      continue;
    }

    if (!previous || !current) {
      continue;
    }
    const storeId = current.id;

    if (previous.source !== current.source) {
      makeEntry(
        {
          severity: "info",
          kind: "store-source-changed",
          actionId: storeId,
          message: `${storeId} store source moved from ${previous.source} to ${current.source}.`,
          before: previous.source,
          after: current.source,
        },
        entries,
      );
    }

    if (previous.kind !== current.kind) {
      // A player store keys records by player and holds a session lock; a
      // plain store does neither, so the two do not read each other's records.
      makeEntry(
        {
          severity: "breaking",
          kind: "store-kind-changed",
          actionId: storeId,
          path: "kind",
          message: `${storeId} changed from ${previous.kind} to ${current.kind}.`,
          before: previous.kind,
          after: current.kind,
        },
        entries,
      );
    }

    if (current.version < previous.version) {
      makeEntry(
        {
          severity: "breaking",
          kind: "store-version-decreased",
          actionId: storeId,
          path: "version",
          message: `${storeId} version went down from ${previous.version} to ${current.version}; records saved at ${previous.version} are refused as newer than this build.`,
          before: previous.version,
          after: current.version,
        },
        entries,
      );
      continue;
    }

    if (current.version > previous.version) {
      makeEntry(
        current.hasMigrate
          ? {
              severity: "info",
              kind: "store-version-bumped",
              actionId: storeId,
              path: "version",
              message: `${storeId} version bumped from ${previous.version} to ${current.version}; migrate() converts older records.`,
              before: previous.version,
              after: current.version,
            }
          : {
              severity: "breaking",
              kind: "store-version-bumped-without-migrate",
              actionId: storeId,
              path: "version",
              message: `${storeId} version bumped from ${previous.version} to ${current.version} with no migrate(); every saved record will fail to load.`,
              before: previous.version,
              after: current.version,
            },
        entries,
      );
      continue;
    }

    diffStoreSchema(storeId, previous.schema.schema, current.schema.schema, entries, "schema");
  }
}

// A snapshot with every schema's constraints dropped.
function withoutSnapshotConstraints(snapshot: ActionContractSnapshot): ActionContractSnapshot {
  const strip = <T extends { readonly schema: SchemaMetadata | null }>(part: T): T => ({
    ...part,
    schema: part.schema === null ? null : withoutConstraints(part.schema),
  });
  return {
    ...snapshot,
    actions: snapshot.actions.map((action) => ({
      ...action,
      input: strip(action.input),
      output: strip(action.output),
      ...(action.errors !== undefined
        ? {
            errors: action.errors.map((error) => ({
              ...error,
              data: error.data === null ? null : strip(error.data),
            })),
          }
        : {}),
    })),
    ...(snapshot.signals !== undefined
      ? { signals: snapshot.signals.map((signal) => ({ ...signal, payload: strip(signal.payload) })) }
      : {}),
    ...(snapshot.stores !== undefined
      ? { stores: snapshot.stores.map((store) => ({ ...store, schema: strip(store.schema) })) }
      : {}),
    ...(snapshot.resources !== undefined
      ? { resources: snapshot.resources.map((resource) => ({ ...resource, value: strip(resource.value) })) }
      : {}),
  };
}

export function diffActionContractSnapshots(
  before: ActionContractSnapshot,
  after: ActionContractSnapshot,
): ContractDiffResult {
  const entries: ContractDiffEntry[] = [];

  // A version 1 snapshot predates recorded constraints: its schemas hold at
  // most a byte or item bound and a hash of the rest. Read against a version 2
  // one, every other bound would look newly added, so both sides are compared
  // without constraints instead.
  const comparable = before.version !== 1 && after.version !== 1;
  const left = comparable ? before : withoutSnapshotConstraints(before);
  const right = comparable ? after : withoutSnapshotConstraints(after);
  if (!comparable) {
    makeEntry(
      {
        severity: "info",
        kind: "constraints-not-compared",
        message:
          "A version 1 contract snapshot predates recorded schema constraints, so constraint changes were not compared. `aruna contract update` writes version 2.",
      },
      entries,
    );
  }

  diffProjectMetadata(left, right, entries);
  for (const primitive of contractPrimitives()) {
    primitive.diff(left, right, entries);
  }

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
    warning: entries.filter((entry) => entry.severity === "warning").length,
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
    ["warning", []],
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
  if (result.summary.warning > 0) {
    summaryParts.push(pluralize(result.summary.warning, "warning", "warnings"));
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
  for (const severity of ["breaking", "warning", "non-breaking", "info"] as const) {
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

  // No flags: the project in the current directory against its committed
  // snapshot.
  return { kind: "project", project: ".", baseline: undefined };
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
    const explicitBaseline =
      mode.baseline === undefined
        ? undefined
        : await readSnapshotFile(resolveWorkspacePath(mode.baseline));
    const output = await options.inspectProject({ root: projectRoot });
    const baselineLabel = mode.baseline ?? contractSnapshotPath(output).relative;
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
            baselineLabel: normalizePath(baselineLabel),
            currentLabel: normalizePath(mode.project),
          },
          output.diagnostics,
        )}\n`,
        stderr: "",
      };
    }

    let baseline = explicitBaseline;
    if (baseline === undefined) {
      const committed = await readCommittedSnapshot(output);
      if (committed.kind === "missing") {
        throw new Error(
          `No --baseline given and no committed contract snapshot at ${baselineLabel}. Run \`aruna contract update\` to create one, or pass --baseline.`,
        );
      }
      if (committed.kind === "invalid") {
        throw new Error(`${baselineLabel}: ${committed.message}`);
      }
      baseline = committed.snapshot;
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
        baselineLabel: normalizePath(baselineLabel),
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
