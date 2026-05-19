const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_VIOLATIONS = 20;

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
};

export class ActionSerializationError extends Error {
  override readonly name = "ActionSerializationError";
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

function createViolation(path: string, reason: string, value: unknown): SerializationPolicyViolation {
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
  path: string,
  state: {
    readonly maxDepth: number;
    readonly maxViolations: number;
    readonly seen: Set<object>;
    readonly violations: SerializationPolicyViolation[];
  },
  depth: number,
): void {
  if (state.violations.length >= state.maxViolations) {
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
    for (let index = 0; index < value.length; index += 1) {
      validateValue(value[index], appendArrayPath(path, index), state, depth + 1);
      if (state.violations.length >= state.maxViolations) {
        break;
      }
    }
    state.seen.delete(value);
    return;
  }

  if (typeof value === "object") {
    if (isRobloxInstanceLike(value)) {
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

    state.seen.add(value);
    for (const key of sortObjectKeys(value)) {
      validateValue(value[key], appendObjectPath(path, key), state, depth + 1);
      if (state.violations.length >= state.maxViolations) {
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
  const violations: SerializationPolicyViolation[] = [];

  validateValue(
    value,
    "$",
    {
      maxDepth,
      maxViolations,
      seen: new Set<object>(),
      violations,
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
