import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const distRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const entrypoints = [
  "client.js",
  "server.js",
  "schema.js",
  "roblox.js",
  "actions/define-action.js",
] as const;

const publicShims = [
  "client.js",
  "client.d.ts",
  "roblox.js",
  "roblox.d.ts",
  "schema.js",
  "schema.d.ts",
  "server.js",
  "server.d.ts",
] as const;

const forbiddenFragments = [
  "node:fs",
  "node:path",
  "node:url",
  "commander",
  "gradient-string",
  "picocolors",
  "./cli/",
  "../cli/",
];

function resolveRelativeImports(filePath: string, contents: string): string[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isCallExpression(node) ||
      ts.isImportTypeNode(node)
    ) {
      const maybeSpecifier = ts.isCallExpression(node)
        ? node.arguments[0]
        : ts.isImportTypeNode(node)
          ? node.argument
          : node.moduleSpecifier;

      if (maybeSpecifier && ts.isStringLiteralLike(maybeSpecifier)) {
        const text = maybeSpecifier.text;
        if (text.startsWith(".")) {
          specifiers.push(text);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

async function resolveReachableFiles(): Promise<Set<string>> {
  const reachable = new Set<string>();
  const queue = entrypoints.map((entrypoint) => path.join(distRoot, entrypoint));

  while (queue.length > 0) {
    const filePath = queue.pop();
    if (!filePath || reachable.has(filePath)) {
      continue;
    }

    const contents = await fs.readFile(filePath, "utf8");
    reachable.add(filePath);

    for (const specifier of resolveRelativeImports(filePath, contents)) {
      const candidates = [
        path.resolve(path.dirname(filePath), specifier),
        path.resolve(path.dirname(filePath), `${specifier}.js`),
        path.resolve(path.dirname(filePath), `${specifier}.mjs`),
        path.resolve(path.dirname(filePath), `${specifier}.cjs`),
        path.resolve(path.dirname(filePath), specifier, "index.js"),
      ];

      let nextFile: string | undefined;
      for (const candidate of candidates) {
        try {
          await fs.access(candidate);
          nextFile = candidate;
          break;
        } catch {
          continue;
        }
      }

      if (nextFile) {
        queue.push(nextFile);
      }
    }
  }

  return reachable;
}

describe("public subpath reachability", () => {
  it("keeps the package-root public shims pointed at dist", async () => {
    const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")) as {
      exports?: Record<string, { import?: string; types?: string }>;
      files?: string[];
    };

    expect(packageJson.files).toContain("dist");
    expect(packageJson.files).toContain("*.js");
    expect(packageJson.files).toContain("*.d.ts");

    expect(packageJson.exports?.["./client"]).toEqual({
      types: "./client.d.ts",
      import: "./client.js",
    });
    expect(packageJson.exports?.["./server"]).toEqual({
      types: "./server.d.ts",
      import: "./server.js",
    });
    expect(packageJson.exports?.["./roblox"]).toEqual({
      types: "./roblox.d.ts",
      import: "./roblox.js",
    });
    expect(packageJson.exports?.["./schema"]).toEqual({
      types: "./schema.d.ts",
      import: "./schema.js",
    });

    for (const fileName of publicShims) {
      const contents = await fs.readFile(path.join(packageRoot, fileName), "utf8");
      expect(contents.trim().length, fileName).toBeGreaterThan(0);
      expect(contents).toContain(`./dist/${fileName.replace(/\.d\.ts$/, ".js")}`);
      for (const fragment of forbiddenFragments) {
        expect(contents, `${fileName} should not reference ${fragment}`).not.toContain(fragment);
      }
    }
  });

  it("keeps Roblox-facing exports away from CLI and Node-only imports", async () => {
    const reachableFiles = await resolveReachableFiles();

    for (const filePath of reachableFiles) {
      const contents = await fs.readFile(filePath, "utf8");
      for (const fragment of forbiddenFragments) {
        expect(contents, `${path.relative(distRoot, filePath)} should not reference ${fragment}`).not.toContain(fragment);
      }
    }
  });
});
