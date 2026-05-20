import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serializeJson } from "../src/cli.js";

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`);
const fixturesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures",
);
const builtCliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");

function runContractInspect(args: string[]): ReturnType<typeof spawnSync> {
  expect(fs.existsSync(builtCliPath)).toBe(true);

  const env = { ...process.env };
  delete env.CI;
  delete env.NO_COLOR;

  return spawnSync(process.execPath, [builtCliPath, "inspect", "contract", ...args], {
    encoding: "utf8",
    env,
  });
}

function relativeFixturePath(name: string): string {
  return path
    .relative(process.cwd(), path.join(fixturesRoot, name, "input"))
    .split(path.sep)
    .join("/");
}

describe("inspect contract", () => {
  it("emits stable JSON for the rate-limit fixture", () => {
    const result = runContractInspect([
      "--json",
      "--project",
      path.join(fixturesRoot, "action-rate-limit", "input"),
    ]);

    const expected = JSON.parse(
      fs.readFileSync(
        path.join(fixturesRoot, "action-rate-limit", "expected", "contract.snapshot.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expected.project = {
      ...(expected.project as Record<string, unknown>),
      root: relativeFixturePath("action-rate-limit"),
    };
    const expectedJson = `${serializeJson(expected)}\n`;

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(expectedJson);
    expect(result.stdout).not.toMatch(ANSI_PATTERN);

    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      version: 1,
      project: {
        root: relativeFixturePath("action-rate-limit"),
        generatedDir: "src/.aruna",
        manifest: "src/.aruna/manifest.json",
      },
      generatedAt: null,
      diagnostics: [],
    });
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions[0]).toMatchObject({
      id: "shop.purchaseItem",
      source: "src/domains/shop/actions.ts",
      moduleKind: "serverAction",
      authority: {
        owner: "server",
        clientCallable: true,
      },
      generated: {
        clientExport: "purchaseItem",
        serverRegistry: true,
      },
      input: {
        summary: "object { itemId: string }",
        schema: {
          kind: "object",
          properties: {
            itemId: {
              kind: "string",
            },
          },
        },
      },
      output: {
        summary: "object { ok: boolean }",
        schema: {
          kind: "object",
          properties: {
            ok: {
              kind: "boolean",
            },
          },
        },
      },
      serialization: {
        policy: "plain-data-v1",
      },
      rateLimit: {
        key: "player",
        windowMs: 1000,
        max: 5,
      },
      warnings: [],
    });
  });

  it("sorts actions and preserves nested schema metadata", () => {
    const result = runContractInspect([
      "--json",
      "--project",
      path.join(fixturesRoot, "action-generated-output", "input"),
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(ANSI_PATTERN);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.actions.map((action: { readonly id: string }) => action.id)).toEqual([
      "inventory.restockItem",
      "shop.purchaseItem",
    ]);

    expect(parsed.actions[0]).toMatchObject({
      input: {
        summary: "object { itemId: string, note?: string, quantity: number, tags: string[] }",
        schema: {
          kind: "object",
          properties: {
            itemId: {
              kind: "string",
            },
            note: {
              kind: "optional",
              inner: {
                kind: "string",
              },
            },
            quantity: {
              kind: "number",
            },
            tags: {
              kind: "array",
              items: {
                kind: "string",
              },
            },
          },
        },
      },
      output: {
        summary: "object { ok: boolean, warnings: string[] }",
      },
      rateLimit: null,
    });
  });

  it("prints a concise human summary without ANSI escapes when color is disabled", () => {
    const result = runContractInspect([
      "--no-color",
      "--project",
      path.join(fixturesRoot, "action-basic", "input"),
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("aruna inspect contract");
    expect(result.stdout).toContain("1 action contract");
    expect(result.stdout).toContain("serialization policy: plain-data-v1");
    expect(result.stdout).toContain("Use --json to emit a deterministic contract snapshot.");
    expect(result.stdout).not.toMatch(ANSI_PATTERN);
    expect(result.stderr).toBe("");
  });

  it("returns non-zero and surfaces diagnostics for invalid projects", () => {
    const result = runContractInspect([
      "--no-color",
      "--project",
      path.join(fixturesRoot, "invalid-action-rate-limit", "input"),
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("aruna inspect contract");
    expect(result.stdout).toContain("error");
    expect(result.stdout).toContain("aruna::560");
    expect(result.stdout).not.toMatch(ANSI_PATTERN);
    expect(result.stderr).toBe("");
  });

  it("returns non-zero JSON with diagnostics for invalid projects", () => {
    const result = runContractInspect([
      "--json",
      "--project",
      path.join(fixturesRoot, "invalid-action-rate-limit", "input"),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toMatch(ANSI_PATTERN);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.diagnostics.length).toBeGreaterThan(0);
    expect(parsed.generatedAt).toBeNull();
  });

  it("emits byte-stable JSON across repeated runs", () => {
    const first = runContractInspect([
      "--json",
      "--project",
      path.join(fixturesRoot, "action-rate-limit", "input"),
    ]);
    const second = runContractInspect([
      "--json",
      "--project",
      path.join(fixturesRoot, "action-rate-limit", "input"),
    ]);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.stdout).toBe(second.stdout);
  });
});
