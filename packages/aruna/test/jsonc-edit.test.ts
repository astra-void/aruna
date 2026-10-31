import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { createJsoncEditor } from "../src/cli/jsonc-edit.ts";

function edit(text: string, apply: (editor: ReturnType<typeof createJsoncEditor>) => void): string {
  const editor = createJsoncEditor(text);
  apply(editor);
  return editor.text();
}

describe("createJsoncEditor", () => {
  it("adds a key under the last one, with its indentation, and touches no other line", () => {
    const text = `{\n  "compilerOptions": {\n    "jsx": "react"\n  }\n}\n`;
    expect(edit(text, (editor) => editor.set(["compilerOptions", "strict"], true))).toBe(
      `{\n  "compilerOptions": {\n    "jsx": "react",\n    "strict": true\n  }\n}\n`,
    );
  });

  it("indents with tabs in a tab-indented file, and writes plain arrays inline", () => {
    expect(edit(`{\n\t"a": 1\n}\n`, (editor) => editor.set(["b"], [1, 2]))).toBe(
      `{\n\t"a": 1,\n\t"b": [1, 2]\n}\n`,
    );
  });

  it("keeps a trailing-comma style", () => {
    expect(edit(`{\n  "a": 1,\n}\n`, (editor) => editor.set(["b"], 2))).toBe(
      `{\n  "a": 1,\n  "b": 2,\n}\n`,
    );
  });

  it("puts the new comma before a comment that ends the last entry's line", () => {
    expect(edit(`{\n  "a": 1 // one\n}\n`, (editor) => editor.set(["b"], 2))).toBe(
      `{\n  "a": 1, // one\n  "b": 2\n}\n`,
    );
  });

  it("opens up an empty object and creates missing parents", () => {
    expect(edit(`{}\n`, (editor) => editor.set(["compilerOptions", "target"], "ESNext"))).toBe(
      `{\n  "compilerOptions": {\n    "target": "ESNext"\n  }\n}\n`,
    );
  });

  it("writes an object one key per line at the right depth", () => {
    expect(
      edit(`{\n  "a": 1\n}\n`, (editor) => editor.set(["paths"], { "@/*": ["./src/*"] })),
    ).toBe(`{\n  "a": 1,\n  "paths": {\n    "@/*": ["./src/*"]\n  }\n}\n`);
  });

  it("replaces a value in place", () => {
    const text = `{\n  "paths": {\n    "a": ["./x"], // keep\n    "b": ["./y"]\n  }\n}\n`;
    expect(edit(text, (editor) => editor.set(["paths", "a"], ["./z"]))).toBe(
      `{\n  "paths": {\n    "a": ["./z"], // keep\n    "b": ["./y"]\n  }\n}\n`,
    );
  });

  it("appends to an inline array inline, and to a multi-line array on its own line", () => {
    expect(
      edit(`{\n  "include": ["src/**/*"]\n}\n`, (editor) =>
        editor.append(["include"], "src/.aruna/**/*.ts"),
      ),
    ).toBe(`{\n  "include": ["src/**/*", "src/.aruna/**/*.ts"]\n}\n`);
    expect(
      edit(`{\n  "include": [\n    "src/**/*"\n  ]\n}\n`, (editor) =>
        editor.append(["include"], "src/.aruna/**/*.ts"),
      ),
    ).toBe(`{\n  "include": [\n    "src/**/*",\n    "src/.aruna/**/*.ts"\n  ]\n}\n`);
  });

  it("removes a key's whole line, and the comma it leaves behind on the last one", () => {
    expect(
      edit(`{\n  "extends": "./x.json",\n  "compilerOptions": {}\n}\n`, (editor) =>
        editor.remove(["extends"]),
      ),
    ).toBe(`{\n  "compilerOptions": {}\n}\n`);
    expect(edit(`{\n  "a": 1,\n  "b": 2\n}\n`, (editor) => editor.remove(["b"]))).toBe(
      `{\n  "a": 1\n}\n`,
    );
  });

  it("keeps CRLF line endings", () => {
    expect(edit(`{\r\n  "a": 1\r\n}\r\n`, (editor) => editor.set(["b"], 2))).toBe(
      `{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n`,
    );
  });

  it("opens up an inline object, keeping its entries as written", () => {
    const text = `{\n  "paths": { "@/*": ["./src/*"], "~/*": ["./*"] }\n}\n`;
    expect(edit(text, (editor) => editor.set(["paths", "$aruna/signals"], ["./x.ts"]))).toBe(
      `{\n  "paths": {\n    "@/*": ["./src/*"],\n    "~/*": ["./*"],\n    "$aruna/signals": ["./x.ts"]\n  }\n}\n`,
    );
  });

  it("still produces valid JSON for a layout it leaves to jsonc-parser", () => {
    const result = edit(`{ "a": 1 /* one */ }`, (editor) => editor.set(["b"], 2));
    expect(parse(result)).toEqual({ a: 1, b: 2 });
  });
});
