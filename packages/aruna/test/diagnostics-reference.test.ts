// docs/diagnostics.md is the user's reference for every code. It is written by
// hand, so this keeps it honest against the sources: the compiler's table in
// diagnostics.rs, the codes the CLI emits itself, and the public DiagnosticCode
// type. A code the compiler emits without a table entry would surface as
// `internal-compiler-error`, which is how aruna::563 went unnamed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relative: string): string => fs.readFileSync(path.join(repoRoot, relative), "utf8");

type Entry = { readonly name: string; readonly severity: string };

function compilerTable(): Map<string, Entry> {
  const source = read("crates/aruna_compiler/src/diagnostics.rs");
  const table = new Map<string, Entry>();
  for (const match of source.matchAll(
    /"(aruna::\d{3})" => Some\(\(\s*"([a-z-]+)",\s*DiagnosticSeverity::(\w+)/g,
  )) {
    table.set(match[1]!, { name: match[2]!, severity: match[3]!.toLowerCase() });
  }
  return table;
}

// Codes the CLI reports on its own, outside the compiler.
function cliTable(): Map<string, Entry> {
  const table = new Map<string, Entry>();
  const dir = path.join(repoRoot, "packages/aruna/src/cli");
  for (const file of fs.readdirSync(dir)) {
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    for (const match of source.matchAll(
      /code: "(aruna::\d{3})",\s*name: "([a-z-]+)",\s*severity: "(\w+)"/g,
    )) {
      table.set(match[1]!, { name: match[2]!, severity: match[3]! });
    }
  }
  return table;
}

function emittedCompilerCodes(): Set<string> {
  const codes = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".rs") && entry.name !== "toy.rs" && entry.name !== "tests.rs") {
        // toy.rs is a test-only primitive with its own throwaway code.
        for (const match of fs.readFileSync(full, "utf8").matchAll(/"(aruna::\d{3})"/g)) {
          codes.add(match[1]!);
        }
      }
    }
  };
  walk(path.join(repoRoot, "crates/aruna_compiler/src"));
  return codes;
}

function documented(): Map<string, Entry> {
  const table = new Map<string, Entry>();
  for (const match of read("packages/aruna/docs/diagnostics.md").matchAll(
    /^\| `(aruna::\d{3})` \| `([a-z-]+)` \| (\w+) \|/gm,
  )) {
    expect(table.has(match[1]!), `${match[1]} is listed twice`).toBe(false);
    table.set(match[1]!, { name: match[2]!, severity: match[3]! });
  }
  return table;
}

describe("diagnostics reference", () => {
  const all = new Map([...compilerTable(), ...cliTable()]);

  it("names every code the compiler emits", () => {
    const table = compilerTable();
    const unnamed = [...emittedCompilerCodes()].filter((code) => !table.has(code)).sort();
    expect(unnamed).toEqual([]);
  });

  it("documents every code with its name and default severity, and nothing else", () => {
    const docs = documented();
    expect([...docs.keys()].sort()).toEqual([...all.keys()].sort());
    for (const [code, entry] of all) {
      expect(docs.get(code), code).toEqual(entry);
    }
  });

  it("lists exactly those codes in the public DiagnosticCode type", () => {
    const source = read("packages/core/src/index.ts");
    const union = /export type DiagnosticCode =([^;]+);/.exec(source)?.[1] ?? "";
    const codes = [...union.matchAll(/"(aruna::\d{3})"/g)].map((match) => match[1]!).sort();
    expect(codes).toEqual([...all.keys()].sort());
  });
});
