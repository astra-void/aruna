// `pnpm api:report` — writes the public API report: one rolled-up `.d.ts` per
// public entry point of the `aruna` package, under api/. `pnpm api:check`
// (`--check`) regenerates it in memory and fails when the committed report is
// out of date, so every change to an exported name or type shows up in review
// as a diff of api/*.d.ts. See docs/stability.md.
//
// Each report holds the declarations the entry exports, sorted by name, then
// every declaration they reference that the entry does not export — a public
// signature that names an internal type exposes that type's shape too, so a
// change to it is an API change. Declarations from outside the Aruna packages
// (the TypeScript lib, @rbxts globals) are referenced, not copied.
//
// Needs `pnpm build` first: it reads the shipped declarations (dist/).
import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";

const repoRoot = path.resolve(__dirname, "..");
const packageRoot = path.join(repoRoot, "packages", "aruna");
const reportRoot = path.join(repoRoot, "api");
const check = process.argv.includes("--check");

type Entry = { readonly specifier: string; readonly file: string; readonly roblox: boolean };

const ENTRIES: readonly Entry[] = [
  // The config and compiler surface, including the `Config` type.
  { specifier: "aruna", file: "dist/index.d.ts", roblox: false },
  { specifier: "aruna/server", file: "server.d.ts", roblox: true },
  { specifier: "aruna/client", file: "client.d.ts", roblox: true },
  { specifier: "aruna/roblox", file: "roblox.d.ts", roblox: true },
  { specifier: "aruna/schema", file: "schema.d.ts", roblox: true },
  { specifier: "aruna/testing", file: "testing.d.ts", roblox: true },
  { specifier: "aruna/ui", file: "ui.d.ts", roblox: true },
];

// Declarations in these files belong to Aruna's public surface; anything else is
// an external reference.
const OWNED_ROOTS = ["aruna", "core", "compiler"].map((name) =>
  path.join(repoRoot, "packages", name),
);

function isOwned(fileName: string): boolean {
  const resolved = fs.existsSync(fileName) ? fs.realpathSync(fileName) : fileName;
  return (
    resolved.endsWith(".d.ts") &&
    !resolved.includes(`${path.sep}node_modules${path.sep}`) &&
    OWNED_ROOTS.some((root) => resolved.startsWith(root + path.sep))
  );
}

function createProgram(entry: Entry): ts.Program {
  const options: ts.CompilerOptions = entry.roblox
    ? {
        noLib: true,
        types: ["@rbxts/types", "@rbxts/compiler-types"],
        typeRoots: [
          path.join(packageRoot, "node_modules"),
          path.join(packageRoot, "node_modules", "@rbxts"),
        ],
        moduleResolution: ts.ModuleResolutionKind.Node10,
        module: ts.ModuleKind.CommonJS,
      }
    : {
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        module: ts.ModuleKind.NodeNext,
        types: [],
      };
  return ts.createProgram([path.join(packageRoot, entry.file)], {
    ...options,
    target: ts.ScriptTarget.ESNext,
    skipLibCheck: true,
    noEmit: true,
  });
}

// The statement a declaration is printed as: a variable's whole statement, the
// declaration itself otherwise.
function printableNode(declaration: ts.Declaration): ts.Node {
  if (ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)) {
    return declaration.parent.parent;
  }
  return declaration;
}

const DECLARE_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
]);

// The declaration's own text with its `export` / `declare` modifiers replaced by
// the report's, so the same declaration prints the same whichever file it
// came from.
function printDeclaration(node: ts.Node, exported: boolean): string {
  const text = node
    .getText()
    .replace(/^(export\s+)?(default\s+)?(declare\s+)?/, "")
    .replace(/\r\n/g, "\n");
  const prefix = `${exported ? "export " : ""}${DECLARE_KINDS.has(node.kind) ? "declare " : ""}`;
  return `${prefix}${text}`;
}

function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

// Owned symbols `node` refers to by name: type references, `extends` clauses,
// `typeof` queries.
function referencedSymbols(checker: ts.TypeChecker, node: ts.Node): ts.Symbol[] {
  const found: ts.Symbol[] = [];
  const visit = (child: ts.Node): void => {
    let name: ts.EntityName | ts.Expression | undefined;
    if (ts.isTypeReferenceNode(child)) {
      name = child.typeName;
    } else if (ts.isExpressionWithTypeArguments(child)) {
      name = child.expression;
    } else if (ts.isTypeQueryNode(child)) {
      name = child.exprName;
    }
    if (name !== undefined) {
      const symbol = checker.getSymbolAtLocation(ts.isQualifiedName(name) ? name.right : name);
      if (symbol !== undefined) {
        found.push(resolveAlias(checker, symbol));
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function ownedDeclarations(symbol: ts.Symbol): ts.Declaration[] {
  return (symbol.declarations ?? []).filter((declaration) =>
    isOwned(declaration.getSourceFile().fileName),
  );
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function buildReport(entry: Entry): string {
  const program = createProgram(entry);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(path.join(packageRoot, entry.file));
  const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) {
    throw new Error(`${entry.specifier}: ${entry.file} is not a module — run pnpm build first.`);
  }

  const exported = checker
    .getExportsOfModule(moduleSymbol)
    .slice()
    .sort((left, right) => compareNames(left.getName(), right.getName()));

  const printed = new Set<ts.Node>();
  const sections: string[] = [];
  const pending: ts.Symbol[] = [];

  for (const exportSymbol of exported) {
    const name = exportSymbol.getName();
    const target = resolveAlias(checker, exportSymbol);
    const declarations = ownedDeclarations(target);
    if (declarations.length === 0) {
      sections.push(`export { ${name} }; // re-exported from outside the Aruna packages`);
      continue;
    }
    const lines: string[] = [];
    for (const declaration of declarations) {
      const node = printableNode(declaration);
      if (printed.has(node)) {
        continue;
      }
      printed.add(node);
      lines.push(printDeclaration(node, true));
      pending.push(...referencedSymbols(checker, node));
    }
    // A rename (`export { a as b }`) shows under both names.
    if (target.getName() !== name && lines.length > 0) {
      lines.push(`export { ${target.getName()} as ${name} };`);
    }
    if (lines.length > 0) {
      sections.push(lines.join("\n"));
    }
  }

  // Referenced but not exported here, transitively.
  const internal: { name: string; text: string }[] = [];
  const exportedTargets = new Set(exported.map((symbol) => resolveAlias(checker, symbol)));
  const seen = new Set<ts.Symbol>(exportedTargets);
  while (pending.length > 0) {
    const symbol = pending.pop()!;
    if (seen.has(symbol)) {
      continue;
    }
    seen.add(symbol);
    for (const declaration of ownedDeclarations(symbol)) {
      const node = printableNode(declaration);
      if (printed.has(node) || ts.isTypeParameterDeclaration(node)) {
        continue;
      }
      printed.add(node);
      internal.push({ name: symbol.getName(), text: printDeclaration(node, false) });
      pending.push(...referencedSymbols(checker, node));
    }
  }
  internal.sort(
    (left, right) => compareNames(left.name, right.name) || compareNames(left.text, right.text),
  );

  const header = [
    `// API report for \`${entry.specifier}\`. Generated by \`pnpm api:report\` — do not edit.`,
    "// A diff here is a change to Aruna's public API; see docs/stability.md.",
    "",
  ];
  const body = [...sections];
  if (internal.length > 0) {
    body.push("// Referenced by the exports above, not exported from this entry:");
    body.push(...internal.map((entryText) => entryText.text));
  }
  return `${header.join("\n")}\n${body.join("\n\n")}\n`;
}

function reportFileName(specifier: string): string {
  return `${specifier.replace("/", "-")}.d.ts`;
}

let stale = 0;
for (const entry of ENTRIES) {
  const report = buildReport(entry);
  const target = path.join(reportRoot, reportFileName(entry.specifier));
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : undefined;
  if (check) {
    if (current !== report) {
      stale += 1;
      console.error(`api/${reportFileName(entry.specifier)} is out of date.`);
    }
  } else if (current !== report) {
    fs.mkdirSync(reportRoot, { recursive: true });
    fs.writeFileSync(target, report);
    console.log(`wrote api/${reportFileName(entry.specifier)}`);
  }
}

if (check && stale > 0) {
  console.error(
    "\nThe public API changed. Run `pnpm build && pnpm api:report`, review the diff of api/, and commit it" +
      " (with a CHANGELOG entry: docs/stability.md).",
  );
  process.exit(1);
}
if (check) {
  console.log("API report is up to date.");
}
