import { describe, expect, it } from "vitest";
import { canaryVersion, withVersion } from "../../../scripts/canary-version.ts";

describe("canary versions", () => {
  it("is the next patch's prerelease, tagged with the commit and run", () => {
    expect(canaryVersion("0.6.0", "ABCDEF0123456789", 42)).toBe("0.6.1-canary.abcdef0.42");
    expect(canaryVersion("1.9.9", "0123456", "7")).toBe("1.9.10-canary.0123456.7");
  });

  it("refuses a version that is already a prerelease, a non-sha, or a non-number run", () => {
    expect(() => canaryVersion("0.6.1-canary.abcdef0.1", "abcdef0", 2)).toThrow("release version");
    expect(() => canaryVersion("0.6.0", "main", 2)).toThrow("commit sha");
    expect(() => canaryVersion("0.6.0", "abcdef0", "x")).toThrow("run number");
  });

  it("rewrites only the version field, keeping the file's formatting", () => {
    const original = `{\n  "name": "@arunajs/aruna",\n  "version": "0.6.0",\n  "dependencies": {\n    "@arunajs/core": "workspace:*"\n  }\n}\n`;
    expect(withVersion(original, "0.6.1-canary.abcdef0.42")).toBe(
      original.replace('"version": "0.6.0"', '"version": "0.6.1-canary.abcdef0.42"'),
    );
  });
});
