// The runtime subpaths (`aruna/server`, `client`, `roblox`, `schema`,
// `testing`) are type-only: a game compiles its vendored copy of the native
// runtime, and the package ships that runtime's declarations so a project sees
// the same types whether or not the doctor aliases are installed. These cases
// pin the package shape that makes that true. Needs `pnpm build` (dist/native).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeTypesRoot = path.join(packageRoot, "dist", "native");

const SUBPATHS = ["server", "client", "roblox", "schema", "testing"] as const;

const forbiddenFragments = [
  "node:fs",
  "node:path",
  "node:url",
  "commander",
  "gradient-string",
  "picocolors",
  "/cli/",
];

// Exported names of each module, resolved with the rbxts ambient types the native
// declarations are written against. One program for every file: the ambient
// types are the expensive part, and loading them per file is seconds each.
function exportNamesOf(absoluteFiles: readonly string[]): Map<string, string[]> {
  const program = ts.createProgram([...absoluteFiles], {
    noLib: true,
    skipLibCheck: true,
    types: ["@rbxts/types", "@rbxts/compiler-types"],
    typeRoots: [
      path.join(packageRoot, "node_modules"),
      path.join(packageRoot, "node_modules/@rbxts"),
    ],
    moduleResolution: ts.ModuleResolutionKind.Node10,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ESNext,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const names = new Map<string, string[]>();
  for (const absoluteFile of absoluteFiles) {
    const sourceFile = program.getSourceFile(absoluteFile);
    const moduleSymbol =
      sourceFile === undefined ? undefined : checker.getSymbolAtLocation(sourceFile);
    if (moduleSymbol === undefined) {
      throw new Error(`Not a module: ${absoluteFile}`);
    }
    names.set(
      absoluteFile,
      checker
        .getExportsOfModule(moduleSymbol)
        .map((symbol) => symbol.getName())
        .sort(),
    );
  }
  return names;
}

describe("public subpaths", () => {
  it("publishes each runtime subpath as types only", async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as {
      exports?: Record<string, Record<string, string>>;
      files?: string[];
    };

    expect(packageJson.files).toContain("dist");
    expect(packageJson.files).toContain("*.d.ts");
    expect(packageJson.files).not.toContain("*.js");
    // The root stays a Node entry: config and compiler.
    expect(packageJson.exports?.["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });
    for (const subpath of SUBPATHS) {
      expect(packageJson.exports?.[`./${subpath}`], subpath).toEqual({
        types: `./${subpath}.d.ts`,
      });
    }
  });

  it("points every subpath shim at the native runtime's declarations", async () => {
    for (const subpath of SUBPATHS) {
      const contents = await fs.readFile(path.join(packageRoot, `${subpath}.d.ts`), "utf8");
      expect(contents, subpath).toContain(`export * from "./dist/native/${subpath}.js";`);
      await expect(
        fs.access(path.join(nativeTypesRoot, `${subpath}.d.ts`)),
      ).resolves.toBeUndefined();
    }
  });

  it("gives a project without aliases the same exports as the vendored runtime", () => {
    const shim = (subpath: string) => path.join(packageRoot, `${subpath}.d.ts`);
    const vendored = (subpath: string) => path.join(packageRoot, "roblox", `${subpath}.ts`);
    const names = exportNamesOf(SUBPATHS.flatMap((subpath) => [shim(subpath), vendored(subpath)]));
    for (const subpath of SUBPATHS) {
      const throughPackage = names.get(shim(subpath)) ?? [];
      expect(throughPackage.length, subpath).toBeGreaterThan(0);
      expect({ subpath, names: throughPackage }).toEqual({
        subpath,
        names: names.get(vendored(subpath)),
      });
    }
  }, 60_000);

  it("keeps the shipped declarations free of CLI and Node-only imports", async () => {
    for (const entry of await fs.readdir(nativeTypesRoot)) {
      if (!entry.endsWith(".d.ts")) {
        continue;
      }
      const contents = await fs.readFile(path.join(nativeTypesRoot, entry), "utf8");
      for (const fragment of forbiddenFragments) {
        expect(contents, `dist/native/${entry} should not reference ${fragment}`).not.toContain(
          fragment,
        );
      }
    }
  });
});
