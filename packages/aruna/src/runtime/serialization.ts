import type { Schema } from "../schema/index.js";

const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_VIOLATIONS = 20;
// Values a single walk may visit. Depth alone does not bound the work: a flat
// array of a million numbers is one level deep. Mirrors the native runtime.
export const DEFAULT_MAX_WIRE_NODES = 2048;

export type SerializableActionValue =
  | undefined
  | string
  | number
  | boolean
  | readonly SerializableActionValue[]
  | { readonly [key: string]: SerializableActionValue };

export type SerializationPolicyViolation = {
  readonly path: string;
  readonly reason: string;
  readonly valueKind: string;
};

export type SerializationPolicyResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly violations: readonly SerializationPolicyViolation[];
    };

export type SerializationPolicyOptions = {
  readonly maxDepth?: number;
  readonly maxViolations?: number;
  // Total values visited before the walk gives up and rejects. Default
  // DEFAULT_MAX_WIRE_NODES; pass Infinity for a server-authored value.
  readonly maxNodes?: number;
  // The value's declared schema. An Instance is a reference into the
  // DataModel, not data, so it is accepted only where this says
  // `schema.instance()`; without a schema, never.
  readonly schema?: Schema;
};

// The schemas a value at one position may be checked against: optional and
// default wrappers peeled, and every member of a union. A union is never
// narrowed by validating the value against its members — that walks the
// value's whole subtree outside the node budget, and over again for each
// nested union — so all of them stay candidates, and the validation that runs
// after this walk enforces the exact shape. Mirrors the native runtime.
function expandCandidates(schemas: readonly Schema[]): Schema[] {
  const expanded: Schema[] = [];
  const visited = new Set<Schema>();
  const pending = [...schemas];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    if (current.kind === "optional" || current.kind === "default") {
      pending.push(current.inner);
    } else if (current.kind === "union") {
      pending.push(...current.members);
    } else {
      expanded.push(current);
    }
  }
  return expanded;
}

// The schemas for one entry of a container, from every candidate that
// declares it. Empty for a key none of them declares, which is where an
// Instance is refused.
function childCandidates(schemas: readonly Schema[], key: string | number): Schema[] {
  const children: Schema[] = [];
  for (const candidate of schemas) {
    const child = childSchema(candidate, key);
    if (child !== undefined) {
      children.push(child);
    }
  }
  return children;
}

function childSchema(schema: Schema, key: string | number): Schema | undefined {
  switch (schema.kind) {
    case "object":
      return typeof key === "string" ? schema.shape[key] : undefined;
    case "array":
      return schema.item;
    case "record":
      return schema.value;
    case "tuple":
      return typeof key === "number" ? schema.items[key] : undefined;
    default:
      return undefined;
  }
}

export class ActionSerializationError extends Error {
  override readonly name = "ActionSerializationError";
  // Marks a framework error as public: its name and message reach the client.
  readonly __arunaActionError = true as const;
  readonly actionId: string;
  readonly role: "input" | "output";
  readonly violations: readonly SerializationPolicyViolation[];

  constructor(
    message: string,
    options: {
      readonly actionId: string;
      readonly role: "input" | "output";
      readonly violations: readonly SerializationPolicyViolation[];
    },
  ) {
    super(message);
    this.actionId = options.actionId;
    this.role = options.role;
    this.violations = options.violations;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return Math.floor(value);
}

function escapeObjectKey(key: string): string {
  return key.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isIdentifierKey(key: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}

function appendObjectPath(path: string, key: string): string {
  if (isIdentifierKey(key)) {
    return `${path}.${key}`;
  }

  return `${path}["${escapeObjectKey(key)}"]`;
}

function appendArrayPath(path: string, index: number): string {
  return `${path}[${index}]`;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isRobloxInstanceLike(value: object): boolean {
  const candidate = value as {
    readonly IsA?: unknown;
    readonly ClassName?: unknown;
  };

  return typeof candidate.IsA === "function" && typeof candidate.ClassName === "string";
}

function valueKind(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }

  if (value === null) {
    return "null";
  }

  const valueType = typeof value;
  if (valueType !== "object") {
    return valueType;
  }

  if (Array.isArray(value)) {
    return "array";
  }

  if (isRobloxInstanceLike(value)) {
    return "Roblox Instance-like object";
  }

  return isPlainObject(value) ? "plain object" : "non-plain object";
}

function createViolation(
  path: string,
  reason: string,
  value: unknown,
): SerializationPolicyViolation {
  return {
    path,
    reason,
    valueKind: valueKind(value),
  };
}

function addViolation(
  violations: SerializationPolicyViolation[],
  maxViolations: number,
  path: string,
  reason: string,
  value: unknown,
): void {
  if (violations.length >= maxViolations) {
    return;
  }

  violations.push(createViolation(path, reason, value));
}

function sortObjectKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort();
}

function validateValue(
  value: unknown,
  schemas: readonly Schema[],
  path: string,
  state: {
    readonly maxDepth: number;
    readonly maxViolations: number;
    readonly maxNodes: number;
    readonly seen: Set<object>;
    readonly violations: SerializationPolicyViolation[];
    nodes: number;
    exhausted: boolean;
  },
  depth: number,
): void {
  if (state.exhausted || state.violations.length >= state.maxViolations) {
    return;
  }

  state.nodes += 1;
  if (state.nodes > state.maxNodes) {
    // One violation, then stop: everything left would only add to the cost.
    addViolation(
      state.violations,
      state.maxViolations,
      path,
      `more than ${state.maxNodes} values cannot cross action boundaries`,
      value,
    );
    state.exhausted = true;
    return;
  }

  if (value === undefined || typeof value === "string" || typeof value === "boolean") {
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      addViolation(
        state.violations,
        state.maxViolations,
        path,
        "non-finite numbers cannot cross action boundaries",
        value,
      );
    }
    return;
  }

  if (value === null) {
    addViolation(
      state.violations,
      state.maxViolations,
      path,
      "null values cannot cross action boundaries",
      value,
    );
    return;
  }

  if (typeof value === "function") {
    addViolation(
      state.violations,
      state.maxViolations,
      path,
      "functions cannot cross action boundaries",
      value,
    );
    return;
  }

  if (typeof value === "symbol") {
    addViolation(
      state.violations,
      state.maxViolations,
      path,
      "symbol values cannot cross action boundaries",
      value,
    );
    return;
  }

  if (typeof value === "bigint") {
    addViolation(
      state.violations,
      state.maxViolations,
      path,
      "bigint values cannot cross action boundaries",
      value,
    );
    return;
  }

  if (Array.isArray(value)) {
    if (depth >= state.maxDepth) {
      addViolation(state.violations, state.maxViolations, path, "max depth exceeded", value);
      return;
    }

    if (state.seen.has(value)) {
      addViolation(state.violations, state.maxViolations, path, "cyclic reference", value);
      return;
    }

    state.seen.add(value);
    const arraySchemas = expandCandidates(schemas);
    for (let index = 0; index < value.length; index += 1) {
      validateValue(
        value[index],
        childCandidates(arraySchemas, index),
        appendArrayPath(path, index),
        state,
        depth + 1,
      );
      if (state.exhausted || state.violations.length >= state.maxViolations) {
        break;
      }
    }
    state.seen.delete(value);
    return;
  }

  if (typeof value === "object") {
    if (isRobloxInstanceLike(value)) {
      if (expandCandidates(schemas).some((candidate) => candidate.kind === "instance")) {
        return;
      }
      addViolation(
        state.violations,
        state.maxViolations,
        path,
        "Roblox Instance-like values cannot cross action boundaries",
        value,
      );
      return;
    }

    if (!isPlainObject(value)) {
      addViolation(
        state.violations,
        state.maxViolations,
        path,
        "class instances and non-plain objects cannot cross action boundaries",
        value,
      );
      return;
    }

    if (depth >= state.maxDepth) {
      addViolation(state.violations, state.maxViolations, path, "max depth exceeded", value);
      return;
    }

    if (state.seen.has(value)) {
      addViolation(state.violations, state.maxViolations, path, "cyclic reference", value);
      return;
    }

    const objectSchemas = expandCandidates(schemas);
    state.seen.add(value);
    for (const key of sortObjectKeys(value)) {
      validateValue(
        value[key],
        childCandidates(objectSchemas, key),
        appendObjectPath(path, key),
        state,
        depth + 1,
      );
      if (state.exhausted || state.violations.length >= state.maxViolations) {
        break;
      }
    }
    state.seen.delete(value);
    return;
  }

  addViolation(
    state.violations,
    state.maxViolations,
    path,
    "unsupported value type cannot cross action boundaries",
    value,
  );
}

function buildMessage(
  actionId: string,
  role: "input" | "output",
  violations: readonly SerializationPolicyViolation[],
): string {
  const prefix = `Action ${actionId} ${role} is not serializable across the Aruna action boundary.`;
  const firstViolation = violations[0];

  if (firstViolation === undefined) {
    return prefix;
  }

  return `${prefix} ${firstViolation.path}: ${firstViolation.reason}`;
}

export function validateSerializableActionValue(
  value: unknown,
  options?: SerializationPolicyOptions,
): SerializationPolicyResult {
  const maxDepth = normalizePositiveInteger(options?.maxDepth, DEFAULT_MAX_DEPTH);
  const maxViolations = normalizePositiveInteger(options?.maxViolations, DEFAULT_MAX_VIOLATIONS);
  const maxNodes =
    options?.maxNodes === Infinity
      ? Infinity
      : normalizePositiveInteger(options?.maxNodes, DEFAULT_MAX_WIRE_NODES);
  const violations: SerializationPolicyViolation[] = [];

  validateValue(
    value,
    options?.schema !== undefined ? [options.schema] : [],
    "$",
    {
      maxDepth,
      maxViolations,
      maxNodes,
      seen: new Set<object>(),
      violations,
      nodes: 0,
      exhausted: false,
    },
    0,
  );

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

export function assertSerializableActionValue(
  value: unknown,
  role: "input" | "output",
  actionId: string,
  options?: SerializationPolicyOptions,
): void {
  const result = validateSerializableActionValue(value, options);

  if (result.ok) {
    return;
  }

  throw new ActionSerializationError(buildMessage(actionId, role, result.violations), {
    actionId,
    role,
    violations: result.violations,
  });
}
