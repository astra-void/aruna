// The test framework consumers write specs against.
//
// A game project's specs cannot run under vitest: the modules under test are
// roblox-ts source compiled to Luau, and their runtime is the vendored native
// one. `aruna test` compiles the project and executes the compiled specs under
// Lune, so the collector and the assertions have to be part of the framework
// itself. This is the reference (Node) implementation; `roblox/testing.ts` is
// the byte-for-byte behavioural mirror that actually runs in a game project.
//
// Collection is module-global on purpose: a spec module registers its tests as
// a side effect of being required, exactly as it does under vitest or jest, so
// the runner only has to require every spec and then call `runTests()`.

export type TestBody = () => void | Promise<void>;

export type TestHook = () => void | Promise<void>;

type Suite = {
  readonly name: string;
  readonly parent: Suite | undefined;
  readonly beforeEach: TestHook[];
  readonly afterEach: TestHook[];
};

type TestCase = {
  readonly suite: Suite | undefined;
  readonly name: string;
  readonly body: TestBody;
  readonly skipped: boolean;
};

export type TestOutcome = {
  readonly name: string;
  readonly ok: boolean;
  readonly skipped: boolean;
  // Present only for a failure.
  readonly message?: string;
};

export type TestReport = {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly outcomes: readonly TestOutcome[];
};

export type RunTestsOptions = {
  // Called as each test settles, so a runner can stream progress instead of
  // holding every line until the suite finishes.
  readonly onTest?: (outcome: TestOutcome) => void;
};

const cases: TestCase[] = [];
let currentSuite: Suite | undefined;

// Reports a caller mistake (a hook outside any test, a bad matcher target)
// distinctly from an assertion failure, which is a fact about the code
// under test.
function usageError(message: string): Error {
  return new Error(`Aruna test framework: ${message}`);
}

export function describe(name: string, body: () => void): void {
  const suite: Suite = { name, parent: currentSuite, beforeEach: [], afterEach: [] };
  const previous = currentSuite;
  currentSuite = suite;
  try {
    body();
  } finally {
    currentSuite = previous;
  }
}

export function it(name: string, body: TestBody): void {
  cases.push({ suite: currentSuite, name, body, skipped: false });
}

// Registers the test but does not run it. Kept in the report as skipped rather
// than dropped, so a disabled spec stays visible instead of quietly vanishing.
export function itSkip(name: string, body: TestBody): void {
  cases.push({ suite: currentSuite, name, body, skipped: true });
}

export function beforeEach(hook: TestHook): void {
  if (currentSuite === undefined) {
    throw usageError("beforeEach must be called inside a describe block.");
  }
  currentSuite.beforeEach.push(hook);
}

export function afterEach(hook: TestHook): void {
  if (currentSuite === undefined) {
    throw usageError("afterEach must be called inside a describe block.");
  }
  currentSuite.afterEach.push(hook);
}

// Drops every collected test. The runner calls this between projects; a spec
// that tests the framework itself calls it to isolate its own registrations.
export function resetTests(): void {
  cases.length = 0;
  currentSuite = undefined;
}

export function collectedTestCount(): number {
  return cases.length;
}

function fullName(testCase: TestCase): string {
  const parts: string[] = [testCase.name];
  let suite = testCase.suite;
  while (suite !== undefined) {
    parts.unshift(suite.name);
    suite = suite.parent;
  }
  return parts.join(" › ");
}

// Outermost suite first for beforeEach, innermost first for afterEach — the
// order every test framework uses, so setup unwinds in reverse.
function hooksFor(testCase: TestCase): { before: TestHook[]; after: TestHook[] } {
  const chain: Suite[] = [];
  let suite = testCase.suite;
  while (suite !== undefined) {
    chain.unshift(suite);
    suite = suite.parent;
  }
  const before: TestHook[] = [];
  const after: TestHook[] = [];
  for (const entry of chain) {
    before.push(...entry.beforeEach);
  }
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const entry = chain[index];
    if (entry !== undefined) {
      after.push(...entry.afterEach);
    }
  }
  return { before, after };
}

// Both runtimes reject with different shapes — the reference runtime with
// `Error`, the native one with a plain table — so every message read goes
// through here rather than assuming `.message` or `instanceof Error`.
export function describeThrown(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return String(value);
}

export async function runTests(options?: RunTestsOptions): Promise<TestReport> {
  const outcomes: TestOutcome[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const testCase of cases) {
    const name = fullName(testCase);
    if (testCase.skipped) {
      skipped += 1;
      const outcome: TestOutcome = { name, ok: true, skipped: true };
      outcomes.push(outcome);
      options?.onTest?.(outcome);
      continue;
    }

    const { before, after } = hooksFor(testCase);
    let failure: string | undefined;
    try {
      for (const hook of before) {
        await hook();
      }
      await testCase.body();
    } catch (error) {
      failure = describeThrown(error);
    }

    // afterEach runs even when the test failed, so a harness a test created is
    // still disposed; a throwing afterEach only fails a test that otherwise passed.
    for (const hook of after) {
      try {
        await hook();
      } catch (error) {
        if (failure === undefined) {
          failure = describeThrown(error);
        }
      }
    }

    const outcome: TestOutcome =
      failure === undefined
        ? { name, ok: true, skipped: false }
        : { name, ok: false, skipped: false, message: failure };
    if (failure === undefined) {
      passed += 1;
    } else {
      failed += 1;
    }
    outcomes.push(outcome);
    options?.onTest?.(outcome);
  }

  return { passed, failed, skipped, outcomes };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function render(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

// Structural equality over plain values, arrays, and plain objects. Anything
// else (class instances, Maps, functions) compares by identity — deliberately,
// because the native mirror can only see tables and would otherwise disagree.
export function deepEquals(actual: unknown, expected: unknown): boolean {
  if (actual === expected) {
    return true;
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) {
      return false;
    }
    return actual.every((entry, index) => deepEquals(entry, expected[index]));
  }
  if (
    typeof actual !== "object" ||
    typeof expected !== "object" ||
    actual === null ||
    expected === null ||
    Object.getPrototypeOf(actual) !== Object.prototype ||
    Object.getPrototypeOf(expected) !== Object.prototype
  ) {
    return false;
  }
  const actualRecord = actual as Record<string, unknown>;
  const expectedRecord = expected as Record<string, unknown>;
  const actualKeys = Object.keys(actualRecord);
  const expectedKeys = Object.keys(expectedRecord);
  if (actualKeys.length !== expectedKeys.length) {
    return false;
  }
  return actualKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(expectedRecord, key) &&
      deepEquals(actualRecord[key], expectedRecord[key]),
  );
}

export type RejectsExpectation = {
  // Awaits the promise and asserts it rejected. `match` is a substring of the
  // rejection message, matched through `describeThrown` so it works against
  // both runtimes' rejection shapes.
  readonly toThrow: (match?: string) => Promise<void>;
};

export type Expectation = {
  readonly toBe: (expected: unknown) => void;
  readonly toEqual: (expected: unknown) => void;
  readonly toBeDefined: () => void;
  readonly toBeUndefined: () => void;
  readonly toBeTruthy: () => void;
  readonly toBeFalsy: () => void;
  // Substring for a string, membership for an array.
  readonly toContain: (item: unknown) => void;
  readonly toHaveLength: (length: number) => void;
  // The actual value must be a function; it is called here.
  readonly toThrow: (match?: string) => void;
  readonly rejects: RejectsExpectation;
  readonly not: NegatableExpectation;
};

export type NegatableExpectation = Omit<Expectation, "not" | "rejects">;

function assert(condition: boolean, negated: boolean, message: string): void {
  if (condition === negated) {
    throw new Error(negated ? `expected NOT ${message}` : `expected ${message}`);
  }
}

// Matchers are built without a `not` of their own — `expect()` assembles the
// negated set once, alongside the positive one. Building `not` recursively
// inside the matcher factory would never terminate.
function makeMatchers(actual: unknown, negated: boolean): NegatableExpectation {
  return {
    toBe(expected) {
      assert(actual === expected, negated, `${render(actual)} to be ${render(expected)}`);
    },
    toEqual(expected) {
      assert(
        deepEquals(actual, expected),
        negated,
        `${render(actual)} to deeply equal ${render(expected)}`,
      );
    },
    toBeDefined() {
      assert(actual !== undefined, negated, `${render(actual)} to be defined`);
    },
    toBeUndefined() {
      assert(actual === undefined, negated, `${render(actual)} to be undefined`);
    },
    toBeTruthy() {
      assert(Boolean(actual), negated, `${render(actual)} to be truthy`);
    },
    toBeFalsy() {
      assert(!actual, negated, `${render(actual)} to be falsy`);
    },
    toContain(item) {
      if (typeof actual === "string") {
        assert(
          typeof item === "string" && actual.includes(item),
          negated,
          `${render(actual)} to contain ${render(item)}`,
        );
        return;
      }
      if (!Array.isArray(actual)) {
        throw usageError("toContain expects a string or an array.");
      }
      assert(
        actual.some((entry) => deepEquals(entry, item)),
        negated,
        `${render(actual)} to contain ${render(item)}`,
      );
    },
    toHaveLength(length) {
      if (typeof actual !== "string" && !Array.isArray(actual)) {
        throw usageError("toHaveLength expects a string or an array.");
      }
      assert(actual.length === length, negated, `${render(actual)} to have length ${length}`);
    },
    toThrow(match) {
      if (typeof actual !== "function") {
        throw usageError("toThrow expects a function.");
      }
      let thrown: unknown;
      let didThrow = false;
      try {
        (actual as () => unknown)();
      } catch (error) {
        didThrow = true;
        thrown = error;
      }
      if (!didThrow) {
        assert(false, negated, `the call to throw${match !== undefined ? ` ${render(match)}` : ""}`);
        return;
      }
      const message = describeThrown(thrown);
      assert(
        match === undefined || message.includes(match),
        negated,
        `the thrown message ${render(message)} to contain ${render(match)}`,
      );
    },
  };
}

function makeRejects(actual: unknown, negated: boolean): RejectsExpectation {
  return {
    async toThrow(match) {
      if (
        typeof actual !== "object" ||
        actual === null ||
        typeof (actual as { then?: unknown }).then !== "function"
      ) {
        throw usageError("expect(...).rejects expects a promise.");
      }
      let thrown: unknown;
      let didReject = false;
      try {
        await (actual as Promise<unknown>);
      } catch (error) {
        didReject = true;
        thrown = error;
      }
      if (!didReject) {
        assert(
          false,
          negated,
          `the promise to reject${match !== undefined ? ` with ${render(match)}` : ""}`,
        );
        return;
      }
      const message = describeThrown(thrown);
      assert(
        match === undefined || message.includes(match),
        negated,
        `the rejection message ${render(message)} to contain ${render(match)}`,
      );
    },
  };
}

export function expect(actual: unknown): Expectation {
  return {
    ...makeMatchers(actual, false),
    rejects: makeRejects(actual, false),
    not: makeMatchers(actual, true),
  };
}
