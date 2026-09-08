// The framework a project's specs are written against. It has to run under Lune
// with no test runner around it, so collection, hook order, async bodies, and
// the matchers are all its own — and all covered here.
import { afterEach, describe, expect, it } from "vitest";
import {
  afterEach as arunaAfterEach,
  beforeEach as arunaBeforeEach,
  describe as arunaDescribe,
  it as arunaIt,
  itSkip as arunaItSkip,
  collectedTestCount,
  deepEquals,
  describeThrown,
  expect as arunaExpect,
  resetTests,
  runTests,
} from "../src/testing.js";

afterEach(() => {
  resetTests();
});

describe("collection and running", () => {
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
    expect(report.outcomes[0]?.name).toBe("math › adds");
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
        await Promise.reject(new Error("boom"));
      });
    });

    const report = await runTests();
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.outcomes[1]?.message).toBe("boom");
  });

  it("runs hooks outermost-in and afterEach even when the test failed", async () => {
    resetTests();
    const order: string[] = [];
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
          throw new Error("nope");
        });
      });
    });

    const report = await runTests();
    expect(report.failed).toBe(1);
    expect(order).toEqual([
      "outer:before",
      "inner:before",
      "test",
      "inner:after",
      "outer:after",
    ]);
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
    expect(report.outcomes[0]).toEqual({ name: "suite › not yet", ok: true, skipped: true });
  });

  it("streams outcomes to onTest as they settle", async () => {
    resetTests();
    arunaDescribe("suite", () => {
      arunaIt("one", () => undefined);
      arunaIt("two", () => undefined);
    });

    const seen: string[] = [];
    await runTests({ onTest: (outcome) => seen.push(outcome.name) });
    expect(seen).toEqual(["suite › one", "suite › two"]);
  });

  it("rejects a hook registered outside a describe block", () => {
    resetTests();
    expect(() => arunaBeforeEach(() => undefined)).toThrow(/inside a describe block/);
  });
});

describe("matchers", () => {
  it("compares structurally with toEqual and by identity with toBe", () => {
    arunaExpect({ a: [1, { b: 2 }] }).toEqual({ a: [1, { b: 2 }] });
    expect(() => arunaExpect({ a: 1 }).toBe({ a: 1 })).toThrow(/to be/);
    expect(() => arunaExpect({ a: 1 }).toEqual({ a: 2 })).toThrow(/deeply equal/);
  });

  it("negates through .not", () => {
    arunaExpect(1).not.toBe(2);
    expect(() => arunaExpect(1).not.toBe(1)).toThrow(/expected NOT/);
  });

  it("covers presence, truthiness, containment, and length", () => {
    arunaExpect(undefined).toBeUndefined();
    arunaExpect(0).toBeDefined();
    arunaExpect("").toBeFalsy();
    arunaExpect("hello").toContain("ell");
    arunaExpect([{ a: 1 }]).toContain({ a: 1 });
    arunaExpect([1, 2, 3]).toHaveLength(3);
    expect(() => arunaExpect([1]).toHaveLength(2)).toThrow(/to have length 2/);
    expect(() => arunaExpect(42).toContain("4")).toThrow(/expects a string or an array/);
  });

  it("asserts throws and rejections through both runtimes' error shapes", async () => {
    arunaExpect(() => {
      throw new Error("kaboom");
    }).toThrow("kaboom");
    // The native runtime rejects with a plain table, not an Error.
    await arunaExpect(Promise.reject({ message: "rate limited", name: "ActionRateLimitError" })).rejects.toThrow(
      "rate limited",
    );
    await arunaExpect(Promise.reject("plain string")).rejects.toThrow("plain string");
    expect(() => arunaExpect(1).toThrow()).toThrow(/expects a function/);
  });

  it("reads a message out of every rejection shape", () => {
    expect(describeThrown(new Error("a"))).toBe("a");
    expect(describeThrown("b")).toBe("b");
    expect(describeThrown({ message: "c" })).toBe("c");
    expect(describeThrown(7)).toBe("7");
  });

  it("deepEquals compares plain values but not class instances", () => {
    expect(deepEquals([1, { a: undefined }], [1, { a: undefined }])).toBe(true);
    expect(deepEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEquals(new Error("x"), new Error("x"))).toBe(false);
  });
});
