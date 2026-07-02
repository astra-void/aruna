import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRebuildScheduler, shouldRebuildOnChange } from "../src/cli/watch.js";

const GENERATED = { generatedDir: "src/.aruna" };

describe("shouldRebuildOnChange", () => {
  it("triggers on project source changes", () => {
    expect(shouldRebuildOnChange("src/domains/shop/actions.ts", GENERATED)).toBe(true);
    expect(shouldRebuildOnChange("aruna.config.ts", GENERATED)).toBe(true);
    expect(shouldRebuildOnChange("tsconfig.json", GENERATED)).toBe(true);
  });

  it("ignores the generatedDir so the build's own writes never re-trigger it", () => {
    expect(shouldRebuildOnChange("src/.aruna/manifest.json", GENERATED)).toBe(false);
    expect(
      shouldRebuildOnChange("src/.aruna/shared/actions.client.generated.ts", GENERATED),
    ).toBe(false);
    expect(shouldRebuildOnChange("src/.aruna", GENERATED)).toBe(false);
  });

  it("does not ignore a sibling that merely shares the generatedDir prefix", () => {
    expect(shouldRebuildOnChange("src/.aruna-notes/todo.ts", GENERATED)).toBe(true);
  });

  it("ignores emitted and vendor trees", () => {
    expect(shouldRebuildOnChange("out/domains/shop/actions.luau", GENERATED)).toBe(false);
    expect(shouldRebuildOnChange("include/RuntimeLib.lua", GENERATED)).toBe(false);
    expect(shouldRebuildOnChange("node_modules/aruna/package.json", GENERATED)).toBe(false);
    expect(shouldRebuildOnChange(".git/index", GENERATED)).toBe(false);
    expect(shouldRebuildOnChange("dist/cli.js", GENERATED)).toBe(false);
  });

  it("handles platform separators", () => {
    const platformPath = ["src", ".aruna", "manifest.json"].join(path.sep);
    expect(shouldRebuildOnChange(platformPath, GENERATED)).toBe(false);
  });

  it("ignores empty paths", () => {
    expect(shouldRebuildOnChange("", GENERATED)).toBe(false);
  });
});

describe("createRebuildScheduler", () => {
  it("coalesces a burst of notifications into one run", async () => {
    let runs = 0;
    const timers: Array<() => void> = [];
    const scheduler = createRebuildScheduler(
      async () => {
        runs += 1;
      },
      0,
      (callback) => {
        timers.push(callback);
        return 0;
      },
    );

    scheduler.notify();
    scheduler.notify();
    scheduler.notify();
    expect(timers).toHaveLength(1);
    timers[0]!();
    await scheduler.idle();
    expect(runs).toBe(1);
  });

  it("queues exactly one follow-up when a change lands mid-build", async () => {
    let runs = 0;
    let releaseFirst: (() => void) | undefined;
    const timers: Array<() => void> = [];
    const scheduler = createRebuildScheduler(
      () => {
        runs += 1;
        if (runs === 1) {
          return new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return Promise.resolve();
      },
      0,
      (callback) => {
        timers.push(callback);
        return 0;
      },
    );

    scheduler.notify();
    timers[0]!(); // first run starts and blocks
    expect(runs).toBe(1);

    // Three changes land while the first build is in flight.
    scheduler.notify();
    timers[1]!();
    scheduler.notify();
    scheduler.notify();

    releaseFirst!();
    await scheduler.idle();
    expect(runs).toBe(2);
  });

  it("keeps watching after a failed build", async () => {
    let runs = 0;
    const timers: Array<() => void> = [];
    const scheduler = createRebuildScheduler(
      () => {
        runs += 1;
        return runs === 1 ? Promise.reject(new Error("boom")) : Promise.resolve();
      },
      0,
      (callback) => {
        timers.push(callback);
        return 0;
      },
    );

    scheduler.notify();
    timers[0]!();
    await scheduler.idle();
    expect(runs).toBe(1);

    scheduler.notify();
    timers[1]!();
    await scheduler.idle();
    expect(runs).toBe(2);
  });
});
