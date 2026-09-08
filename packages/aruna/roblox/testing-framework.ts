// Aruna roblox-ts native runtime — the test framework specs are written against.
//
// The behavioural mirror of src/testing/framework.ts. It exists separately
// because a project's specs are roblox-ts source: they compile to Luau with the
// rest of the project and run under Lune, where no host test runner exists. So
// collection, hooks, sequencing, and the matchers all ship here.
//
// Style follows the rest of this runtime: Promise chains rather than async/await,
// pcall rather than try/catch, and no named function expressions (roblox-ts
// rejects them).

export type TestBody = () => unknown;

export type TestHook = () => unknown;

interface Suite {
	readonly name: string;
	readonly parent: Suite | undefined;
	readonly beforeEach: Array<TestHook>;
	readonly afterEach: Array<TestHook>;
}

interface TestCase {
	readonly suite: Suite | undefined;
	readonly name: string;
	readonly body: TestBody;
	readonly skipped: boolean;
}

export interface TestOutcome {
	readonly name: string;
	readonly ok: boolean;
	readonly skipped: boolean;
	// Present only for a failure.
	readonly message?: string;
}

export interface TestReport {
	readonly passed: number;
	readonly failed: number;
	readonly skipped: number;
	readonly outcomes: ReadonlyArray<TestOutcome>;
}

export interface RunTestsOptions {
	// Called as each test settles, so a runner can stream progress instead of
	// holding every line until the suite finishes.
	readonly onTest?: (outcome: TestOutcome) => void;
}

const cases = new Array<TestCase>();
let currentSuite: Suite | undefined;

// Reports a caller mistake (a hook outside any test, a bad matcher target)
// distinctly from an assertion failure, which is a fact about the code under test.
const usageError = (message: string): string => `Aruna test framework: ${message}`;

export function describe(name: string, body: () => void): void {
	const suite: Suite = {
		name,
		parent: currentSuite,
		beforeEach: new Array<TestHook>(),
		afterEach: new Array<TestHook>(),
	};
	const previous = currentSuite;
	currentSuite = suite;
	const [ok, failure] = pcall(() => {
		body();
	});
	currentSuite = previous;
	if (!ok) {
		error(failure);
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
		error(usageError("beforeEach must be called inside a describe block."));
	}
	currentSuite.beforeEach.push(hook);
}

export function afterEach(hook: TestHook): void {
	if (currentSuite === undefined) {
		error(usageError("afterEach must be called inside a describe block."));
	}
	currentSuite.afterEach.push(hook);
}

// Drops every collected test. The runner calls this between projects; a spec that
// tests the framework itself calls it to isolate its own registrations.
export function resetTests(): void {
	cases.clear();
	currentSuite = undefined;
}

export function collectedTestCount(): number {
	return cases.size();
}

const fullName = (testCase: TestCase): string => {
	const parts = new Array<string>();
	parts.push(testCase.name);
	let suite = testCase.suite;
	while (suite !== undefined) {
		parts.unshift(suite.name);
		suite = suite.parent;
	}
	return parts.join(" > ");
};

// Outermost suite first for beforeEach, innermost first for afterEach — the order
// every test framework uses, so setup unwinds in reverse.
const hooksFor = (testCase: TestCase): { before: Array<TestHook>; after: Array<TestHook> } => {
	const chain = new Array<Suite>();
	let suite = testCase.suite;
	while (suite !== undefined) {
		chain.unshift(suite);
		suite = suite.parent;
	}
	const before = new Array<TestHook>();
	const after = new Array<TestHook>();
	for (const entry of chain) {
		for (const hook of entry.beforeEach) {
			before.push(hook);
		}
	}
	for (let index = chain.size() - 1; index >= 0; index -= 1) {
		const entry = chain[index];
		if (entry === undefined) {
			continue;
		}
		for (const hook of entry.afterEach) {
			after.push(hook);
		}
	}
	return { before, after };
};

// Both runtimes reject with different shapes — this one with a plain table or a
// string, the Node reference runtime with an Error — so every message read goes
// through here rather than assuming a field.
export function describeThrown(value: unknown): string {
	if (typeIs(value, "string")) {
		return value;
	}
	if (typeIs(value, "table")) {
		const message = (value as { message?: unknown }).message;
		if (typeIs(message, "string")) {
			return message;
		}
	}
	return tostring(value);
}

const isPromiseLike = (value: unknown): boolean =>
	typeIs(value, "table") && typeIs((value as { andThen?: unknown }).andThen, "function");

// Normalizes a hook or test body's return value into a promise, so a body may be
// synchronous, may yield (task.wait), or may return a promise.
const settle = (value: unknown): Promise<void> => {
	if (isPromiseLike(value)) {
		return (value as Promise<unknown>).then(() => undefined);
	}
	return Promise.resolve(undefined);
};

// Runs a hook chain in order. Each link resolves before the next one starts.
const runHooks = (hooks: ReadonlyArray<TestHook>): Promise<void> => {
	let chain = Promise.resolve(undefined) as Promise<void>;
	for (const hook of hooks) {
		chain = chain.then(() => settle(hook()));
	}
	return chain;
};

// afterEach runs even when the test failed, so a harness a test created is still
// disposed; a throwing afterEach only fails a test that otherwise passed.
const runAfterHooks = (
	hooks: ReadonlyArray<TestHook>,
	failure: string | undefined,
): Promise<string | undefined> => {
	let chain = Promise.resolve(failure);
	for (const hook of hooks) {
		chain = chain.then((current) =>
			settle(hook())
				.then(() => current)
				.catch((caught) => (current !== undefined ? current : describeThrown(caught))),
		);
	}
	return chain;
};

export function runTests(options?: RunTestsOptions): Promise<TestReport> {
	const outcomes = new Array<TestOutcome>();
	let passed = 0;
	let failed = 0;
	let skipped = 0;

	const record = (outcome: TestOutcome): void => {
		outcomes.push(outcome);
		if (options !== undefined && options.onTest !== undefined) {
			options.onTest(outcome);
		}
	};

	let chain = Promise.resolve(undefined) as Promise<void>;
	for (const testCase of cases) {
		chain = chain.then(() => {
			const name = fullName(testCase);
			if (testCase.skipped) {
				skipped += 1;
				record({ name, ok: true, skipped: true });
				return Promise.resolve(undefined);
			}

			const hooks = hooksFor(testCase);
			return runHooks(hooks.before)
				.then(() => settle(testCase.body()))
				.then(() => undefined as string | undefined)
				.catch((caught) => describeThrown(caught))
				.then((failure) => runAfterHooks(hooks.after, failure))
				.then((failure) => {
					if (failure === undefined) {
						passed += 1;
						record({ name, ok: true, skipped: false });
					} else {
						failed += 1;
						record({ name, ok: false, skipped: false, message: failure });
					}
				});
		});
	}

	return chain.then(() => ({ passed, failed, skipped, outcomes }));
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

// Forward-declared so the table branch can recurse: a `const` arrow cannot see
// itself in Luau.
let renderValue: (value: unknown, depth: number) => string;

renderValue = (value: unknown, depth: number): string => {
	if (typeIs(value, "string")) {
		return `"${value}"`;
	}
	if (value === undefined) {
		return "undefined";
	}
	if (!typeIs(value, "table")) {
		return tostring(value);
	}
	if (depth > 2) {
		return "{...}";
	}

	const parts = new Array<string>();
	const asArray = value as Array<unknown>;
	if (asArray.size() > 0) {
		for (const entry of asArray) {
			parts.push(renderValue(entry, depth + 1));
		}
		return `[${parts.join(", ")}]`;
	}

	const keys = new Array<string>();
	for (const [key] of pairs(value as { [key: string]: unknown })) {
		keys.push(tostring(key));
	}
	// Sorted so a failure message is stable across runs — Luau table iteration
	// order is not.
	keys.sort();
	for (const key of keys) {
		parts.push(`${key}: ${renderValue((value as { [key: string]: unknown })[key], depth + 1)}`);
	}
	return parts.size() > 0 ? `{ ${parts.join(", ")} }` : "{}";
};

const render = (value: unknown): string => renderValue(value, 0);

const containsSubstring = (haystack: string, needle: string): boolean => {
	const [at] = haystack.find(needle, 1, true);
	return at !== undefined;
};

// Structural equality over tables, compared in both directions so a missing key
// on either side fails. Anything that is not a table compares by identity.
export function deepEquals(actual: unknown, expected: unknown): boolean {
	if (actual === expected) {
		return true;
	}
	if (!typeIs(actual, "table") || !typeIs(expected, "table")) {
		return false;
	}
	const left = actual as { [key: string]: unknown };
	const right = expected as { [key: string]: unknown };
	for (const [key, value] of pairs(left)) {
		if (!deepEquals(value, right[key as string])) {
			return false;
		}
	}
	for (const [key] of pairs(right)) {
		if (left[key as string] === undefined) {
			return false;
		}
	}
	return true;
}

export interface RejectsExpectation {
	// Awaits the promise and asserts it rejected. `match` is a substring of the
	// rejection message, read through `describeThrown` so it works against both
	// runtimes' rejection shapes.
	readonly toThrow: (match?: string) => Promise<void>;
}

export interface NegatableExpectation {
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
}

export interface Expectation extends NegatableExpectation {
	readonly rejects: RejectsExpectation;
	readonly not: NegatableExpectation;
}

// Named `assertMatch`: roblox-ts reserves the identifier `assert`.
const assertMatch = (condition: boolean, negated: boolean, message: string): void => {
	if (condition === negated) {
		error(negated ? `expected NOT ${message}` : `expected ${message}`);
	}
};

// Matchers are built without a `not` of their own — `expect()` assembles the
// negated set alongside the positive one. Building `not` inside the factory
// would never terminate.
const makeMatchers = (actual: unknown, negated: boolean): NegatableExpectation => ({
	toBe: (expected) => {
		assertMatch(actual === expected, negated, `${render(actual)} to be ${render(expected)}`);
	},
	toEqual: (expected) => {
		assertMatch(
			deepEquals(actual, expected),
			negated,
			`${render(actual)} to deeply equal ${render(expected)}`,
		);
	},
	toBeDefined: () => {
		assertMatch(actual !== undefined, negated, `${render(actual)} to be defined`);
	},
	toBeUndefined: () => {
		assertMatch(actual === undefined, negated, `${render(actual)} to be undefined`);
	},
	toBeTruthy: () => {
		// Luau truthiness: only nil and false are falsy — 0 and "" are truthy.
		assertMatch(actual !== undefined && actual !== false, negated, `${render(actual)} to be truthy`);
	},
	toBeFalsy: () => {
		assertMatch(actual === undefined || actual === false, negated, `${render(actual)} to be falsy`);
	},
	toContain: (item) => {
		if (typeIs(actual, "string")) {
			assertMatch(
				typeIs(item, "string") && containsSubstring(actual, item),
				negated,
				`${render(actual)} to contain ${render(item)}`,
			);
			return;
		}
		if (!typeIs(actual, "table")) {
			error(usageError("toContain expects a string or an array."));
		}
		let found = false;
		for (const entry of actual as Array<unknown>) {
			if (deepEquals(entry, item)) {
				found = true;
				break;
			}
		}
		assertMatch(found, negated, `${render(actual)} to contain ${render(item)}`);
	},
	toHaveLength: (length) => {
		if (typeIs(actual, "string")) {
			assertMatch(actual.size() === length, negated, `${render(actual)} to have length ${length}`);
			return;
		}
		if (!typeIs(actual, "table")) {
			error(usageError("toHaveLength expects a string or an array."));
		}
		assertMatch(
			(actual as Array<unknown>).size() === length,
			negated,
			`${render(actual)} to have length ${length}`,
		);
	},
	toThrow: (match) => {
		if (!typeIs(actual, "function")) {
			error(usageError("toThrow expects a function."));
		}
		const [ok, caught] = pcall(actual as () => unknown);
		if (ok) {
			assertMatch(false, negated, `the call to throw${match !== undefined ? ` ${render(match)}` : ""}`);
			return;
		}
		const message = describeThrown(caught);
		assertMatch(
			match === undefined || containsSubstring(message, match),
			negated,
			`the thrown message ${render(message)} to contain ${render(match)}`,
		);
	},
});

const makeRejects = (actual: unknown, negated: boolean): RejectsExpectation => ({
	toThrow: (match) => {
		if (!isPromiseLike(actual)) {
			error(usageError("expect(...).rejects expects a promise."));
		}
		return (actual as Promise<unknown>)
			.then(() => ({ rejected: false, caught: undefined as unknown }))
			.catch((caught) => ({ rejected: true, caught }))
			.then((result) => {
				if (!result.rejected) {
					assertMatch(
						false,
						negated,
						`the promise to reject${match !== undefined ? ` with ${render(match)}` : ""}`,
					);
					return;
				}
				const message = describeThrown(result.caught);
				assertMatch(
					match === undefined || containsSubstring(message, match),
					negated,
					`the rejection message ${render(message)} to contain ${render(match)}`,
				);
			});
	},
});

export function expect(actual: unknown): Expectation {
	const positive = makeMatchers(actual, false);
	return {
		toBe: positive.toBe,
		toEqual: positive.toEqual,
		toBeDefined: positive.toBeDefined,
		toBeUndefined: positive.toBeUndefined,
		toBeTruthy: positive.toBeTruthy,
		toBeFalsy: positive.toBeFalsy,
		toContain: positive.toContain,
		toHaveLength: positive.toHaveLength,
		toThrow: positive.toThrow,
		rejects: makeRejects(actual, false),
		not: makeMatchers(actual, true),
	};
}
