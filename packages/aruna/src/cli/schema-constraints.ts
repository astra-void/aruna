// The constraints a schema's chain declares (`.maxLength(20)`, `.min(0)`,
// `.refine(...)`), as the compiler records them in the contract, and how two
// versions of one schema compare: which bounds got tighter, which looser, and
// which changed in a way that cannot be judged.
//
// Tighter or looser is a property of the schema alone. What it means depends on
// who produces the value: a tighter input (or a store schema reading records an
// older build saved) refuses values the old one accepted, while a tighter output
// only promises the client less. The diff decides that; this module only
// compares.
import type { SchemaMetadata } from "@arunajs/core";

type BoundKey =
  | "minLength"
  | "maxLength"
  | "minChars"
  | "maxChars"
  | "min"
  | "max"
  | "minItems"
  | "maxItems"
  | "maxEntries";

// A lower bound is tighter when it rises, an upper bound when it falls.
const BOUNDS: ReadonlyArray<{ readonly key: BoundKey; readonly sense: "lower" | "upper" }> = [
  { key: "minLength", sense: "lower" },
  { key: "maxLength", sense: "upper" },
  { key: "minChars", sense: "lower" },
  { key: "maxChars", sense: "upper" },
  { key: "min", sense: "lower" },
  { key: "max", sense: "upper" },
  { key: "minItems", sense: "lower" },
  { key: "maxItems", sense: "upper" },
  { key: "maxEntries", sense: "upper" },
];

// The numeric fields the compiler writes for a chain: every bound, and the
// `.refine()` count.
export const NUMERIC_CONSTRAINT_FIELDS: ReadonlyArray<BoundKey | "refinements"> = [
  ...BOUNDS.map((bound) => bound.key),
  "refinements",
];

export type ConstraintDirection = "tightened" | "loosened" | "changed";

export type ConstraintChange = {
  // The bound (`maxLength`), `int`, `refinements`, or `opaque` for the part
  // only the hash covers.
  readonly constraint: string;
  readonly direction: ConstraintDirection;
  // "maxLength lowered from 50 to 20", "gained minLength 3", ...
  readonly description: string;
  readonly before?: unknown;
  readonly after?: unknown;
};

// The bounds a constraint the compiler could not read may have moved:
// `.length(n)` is both ends of a string's bytes or an array's items.
function boundsOf(kind: string, constraint: string): readonly string[] {
  if (constraint === "length") {
    return kind === "array" ? ["minItems", "maxItems"] : ["minLength", "maxLength"];
  }
  return [constraint];
}

function sortedDynamic(schema: SchemaMetadata): string[] {
  return [...(schema.dynamicConstraints ?? [])].sort();
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// Whether two schema nodes declare the same constraints. Only this node: the
// children are the caller's to compare.
export function constraintsEqual(left: SchemaMetadata, right: SchemaMetadata): boolean {
  return (
    BOUNDS.every((bound) => left[bound.key] === right[bound.key]) &&
    (left.int === true) === (right.int === true) &&
    (left.refinements ?? 0) === (right.refinements ?? 0) &&
    sameList(sortedDynamic(left), sortedDynamic(right)) &&
    left.constraintsHash === right.constraintsHash
  );
}

function describeBound(
  key: string,
  before: number | undefined,
  after: number | undefined,
): string {
  if (before === undefined) {
    return `gained ${key} ${after}`;
  }
  if (after === undefined) {
    return `${key} ${before} removed`;
  }
  return `${key} ${after > before ? "raised" : "lowered"} from ${before} to ${after}`;
}

// How `after` constrains values compared with `before`, for two nodes of the
// same kind. One change per bound that moved, plus one `opaque` change when the
// hashed part moved in a way the counts do not explain.
export function compareConstraints(
  before: SchemaMetadata,
  after: SchemaMetadata,
): ConstraintChange[] {
  const changes: ConstraintChange[] = [];
  const beforeDynamic = sortedDynamic(before);
  const afterDynamic = sortedDynamic(after);
  // A bound the compiler could not read on either side cannot be compared.
  const unreadable = new Set(
    [...beforeDynamic, ...afterDynamic].flatMap((constraint) => boundsOf(after.kind, constraint)),
  );

  for (const bound of BOUNDS) {
    const was = before[bound.key];
    const now = after[bound.key];
    if (was === now || unreadable.has(bound.key)) {
      continue;
    }
    const tighter =
      now !== undefined &&
      (was === undefined || (bound.sense === "upper" ? now < was : now > was));
    changes.push({
      constraint: bound.key,
      direction: tighter ? "tightened" : "loosened",
      description: describeBound(bound.key, was, now),
      ...(was !== undefined ? { before: was } : {}),
      ...(now !== undefined ? { after: now } : {}),
    });
  }

  const wasInt = before.int === true;
  const nowInt = after.int === true;
  if (wasInt !== nowInt) {
    changes.push({
      constraint: "int",
      direction: nowInt ? "tightened" : "loosened",
      description: nowInt ? "gained .int()" : ".int() removed",
    });
  }

  const wasRefined = before.refinements ?? 0;
  const nowRefined = after.refinements ?? 0;
  if (wasRefined !== nowRefined) {
    changes.push({
      constraint: "refinements",
      direction: nowRefined > wasRefined ? "tightened" : "loosened",
      description: `.refine() calls went from ${wasRefined} to ${nowRefined}`,
      before: wasRefined,
      after: nowRefined,
    });
  }

  // The hash covers every predicate and every unreadable bound. A count that
  // moved already accounts for a changed hash; anything else is a change the
  // compiler can see but not judge.
  const dynamicMoved = !sameList(beforeDynamic, afterDynamic);
  if (dynamicMoved || (before.constraintsHash !== after.constraintsHash && wasRefined === nowRefined)) {
    changes.push({
      constraint: "opaque",
      direction: "changed",
      description: "a .refine() predicate or a bound computed at runtime changed",
      ...(before.constraintsHash !== undefined ? { before: before.constraintsHash } : {}),
      ...(after.constraintsHash !== undefined ? { after: after.constraintsHash } : {}),
    });
  }
  return changes;
}

// A copy of `schema` with every recorded constraint dropped, at every level:
// what a contract snapshot from before constraints were recorded holds.
export function withoutConstraints(schema: SchemaMetadata): SchemaMetadata {
  const stripped: SchemaMetadata = { kind: schema.kind };
  if (schema.numericFormat !== undefined) {
    stripped.numericFormat = schema.numericFormat;
  }
  if (schema.properties !== undefined) {
    stripped.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, withoutConstraints(value)]),
    );
  }
  if (schema.items !== undefined) {
    stripped.items = withoutConstraints(schema.items);
  }
  if (schema.literal !== undefined) {
    stripped.literal = schema.literal;
  }
  if (schema.values !== undefined) {
    stripped.values = schema.values;
  }
  if (schema.inner !== undefined) {
    stripped.inner = withoutConstraints(schema.inner);
  }
  if (schema.members !== undefined) {
    stripped.members = schema.members.map(withoutConstraints);
  }
  return stripped;
}

// The constraints of one node as a short list, for a schema summary:
// `maxLength 20, int`. Empty when it declares none.
export function constraintSummary(schema: SchemaMetadata): string {
  const parts: string[] = [];
  for (const bound of BOUNDS) {
    const value = schema[bound.key];
    if (value !== undefined) {
      parts.push(`${bound.key} ${value}`);
    }
  }
  if (schema.int === true) {
    parts.push("int");
  }
  for (const constraint of schema.dynamicConstraints ?? []) {
    parts.push(`${constraint} computed`);
  }
  const refinements = schema.refinements ?? 0;
  if (refinements > 0) {
    parts.push(refinements === 1 ? "refine" : `refine ×${refinements}`);
  }
  return parts.join(", ");
}
