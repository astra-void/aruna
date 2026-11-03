// The framework a project's specs are written against. It has to run under Lune
// with no test runner around it, so collection, hook order, async bodies, and
// the matchers are all its own — and all covered here.
//
// Port of packages/aruna/test/testing-framework.test.ts. This spec runs INSIDE
// the very framework it tests: `aruna/testing` keeps one module-global list of
// collected cases, and the runner's own `runTests()` walks that list. Cases that
// need a private collection (`resetTests` + `runTests` on their own set) are
// therefore guarded:
//
//   - `beforeEach` waits one scheduler frame before the body runs. The outer
//     `runTests()` builds its promise chain by iterating the shared list
//     synchronously, and a run of synchronous tests executes *during* that loop;
//     clearing the list there would truncate (or hijack) the outer run. Once any
//     test yields, the loop has finished queueing every case, and each queued
//     case holds its own reference — so the list can then be cleared safely.
//   - `afterEach` calls `resetTests()`, as the vitest suite's global afterEach
//     does, so a private collection never lingers. The runner calls `runTests()`
//     once and never reads the list again.
//
// The "matchers" suite never touches the collection, so it needs neither guard
// (and must not reset: its cases may run while the outer loop is still going).
import {
  afterEach as arunaAfterEach,
  beforeEach as arunaBeforeEach,
  describe as arunaDescribe,
  expect as arunaExpect,
  it as arunaIt,
  itSkip as arunaItSkip,
} from "aruna/testing";
import {
  collectedTestCount,
  deepEquals,
  describeThrown,
  resetTests,
  runTests,
} from "aruna/internal/testing-framework";

// The outer suite is written with the same framework; the aliases above are the
// "under test" side, these the "asserting" side — mirroring the vitest file.
const describe = arunaDescribe;
const it = arunaIt;
const expect = arunaExpect;
const beforeEach = arunaBeforeEach;
const afterEach = arunaAfterEach;

const nextFrame = (): Promise<void> =>
  new Promise<void>((resolve) => {
    task.delay(0, () => resolve());
  });

// The native analog of an Error instance: a class instance carrying a message.
class ThrownError {
  constructor(readonly message: string) {}
}

describe("collection and running", () => {
  beforeEach(() => nextFrame());
  afterEach(() => {
    resetTests();
  });

  it("runs collected tests and reports pass/fail counts", async () => {
    resetTests();
    arunaDescribe("math", () => {
      arunaIt("adds", () => {
        arunaExpect(1 + 1).toBe(2);
      });
      arunaIt("fails loudly", () => {
        arunaExpect(1).toBe(2);
      });
    });

    expect(collectedTestCount()).toBe(2);
    const report = await runTests();

    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.outcomes[0]?.name).toBe("math > adds"); // The retired Node runtime joined names with " › ".
    expect(report.outcomes[1]?.message).toContain("expected 1 to be 2");
  });

  it("awaits async bodies and records rejections as failures", async () => {
    resetTests();
    arunaDescribe("async", () => {
      arunaIt("resolves", async () => {
        await Promise.resolve();
        arunaExpect(true).toBeTruthy();
      });
      arunaIt("rejects", async () => {
        await Promise.reject({ message: "boom" });
      });
    });

    const report = await runTests();
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.outcomes[1]?.message).toBe("boom");
  });

  it("runs hooks outermost-in and afterEach even when the test failed", async () => {
    resetTests();
    const order = new Array<string>();
    arunaDescribe("outer", () => {
      arunaBeforeEach(() => {
        order.push("outer:before");
      });
      arunaAfterEach(() => {
        order.push("outer:after");
      });
      arunaDescribe("inner", () => {
        arunaBeforeEach(() => {
          order.push("inner:before");
        });
        arunaAfterEach(() => {
          order.push("inner:after");
        });
        arunaIt("fails", () => {
          order.push("test");
          throw "nope";
        });
      });
    });

    const report = await runTests();
    expect(report.failed).toBe(1);
    expect(order).toEqual(["outer:before", "inner:before", "test", "inner:after", "outer:after"]);
  });

  it("keeps skipped tests visible in the report without running them", async () => {
    resetTests();
    let ran = false;
    arunaDescribe("suite", () => {
      arunaItSkip("not yet", () => {
        ran = true;
      });
    });

    const report = await runTests();
    expect(ran).toBe(false);
    expect(report.skipped).toBe(1);
    // The retired Node runtime joined names with " › ".
    expect(report.outcomes[0]).toEqual({ name: "suite > not yet", ok: true, skipped: true });
  });

  it("streams outcomes to onTest as they settle", async () => {
    resetTests();
    arunaDescribe("suite", () => {
      arunaIt("one", () => undefined);
      arunaIt("two", () => undefined);
    });

    const seen = new Array<string>();
    await runTests({ onTest: (outcome) => seen.push(outcome.name) });
    expect(seen).toEqual(["suite > one", "suite > two"]); // The retired Node runtime joined names with " › ".
  });

  it("rejects a hook registered outside a describe block", () => {
    resetTests();
    expect(() => arunaBeforeEach(() => undefined)).toThrow("inside a describe block");
  });
});

describe("matchers", () => {
  it("compares structurally with toEqual and by identity with toBe", () => {
    arunaExpect({ a: [1, { b: 2 }] }).toEqual({ a: [1, { b: 2 }] });
    expect(() => arunaExpect({ a: 1 }).toBe({ a: 1 })).toThrow("to be");
    expect(() => arunaExpect({ a: 1 }).toEqual({ a: 2 })).toThrow("deeply equal");
  });

  it("negates through .not", () => {
    arunaExpect(1).not.toBe(2);
    expect(() => arunaExpect(1).not.toBe(1)).toThrow("expected NOT");
  });

  it("covers presence, truthiness, containment, and length", () => {
    arunaExpect(undefined).toBeUndefined();
    arunaExpect(0).toBeDefined();
    arunaExpect("hello").toContain("ell");
    arunaExpect([{ a: 1 }]).toContain({ a: 1 });
    arunaExpect([1, 2, 3]).toHaveLength(3);
    expect(() => arunaExpect([1]).toHaveLength(2)).toThrow("to have length 2");
    expect(() => arunaExpect(42).toContain("4")).toThrow("expects a string or an array");
    // Luau truthiness: "" is truthy (the retired Node runtime used JS truthiness, where "" is falsy).
    arunaExpect("").toBeTruthy();
    arunaExpect(undefined).toBeFalsy();
    arunaExpect(false).toBeFalsy();
  });

  it("asserts throws and rejections through both runtimes' error shapes", async () => {
    arunaExpect(() => {
      throw new ThrownError("kaboom");
    }).toThrow("kaboom");
    // The native runtime rejects with a plain table, not an Error.
    await arunaExpect(
      Promise.reject({ message: "rate limited", name: "ActionRateLimitError" }),
    ).rejects.toThrow("rate limited");
    await arunaExpect(Promise.reject("plain string")).rejects.toThrow("plain string");
    expect(() => arunaExpect(1).toThrow()).toThrow("expects a function");
  });

  it("reads a message out of every rejection shape", () => {
    expect(describeThrown(new ThrownError("a"))).toBe("a");
    expect(describeThrown("b")).toBe("b");
    expect(describeThrown({ message: "c" })).toBe("c");
    expect(describeThrown(7)).toBe("7");
  });

  it("deepEquals compares plain values but not class instances", () => {
    expect(deepEquals([1, { a: undefined }], [1, { a: undefined }])).toBe(true);
    expect(deepEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    // Tables compare structurally, metatable ignored (the retired Node runtime returned false for class instances).
    expect(deepEquals(new ThrownError("x"), new ThrownError("x"))).toBe(true);
  });
});
