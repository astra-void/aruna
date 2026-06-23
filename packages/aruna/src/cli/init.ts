import fs from "node:fs";
import path from "node:path";
import {
  ARUNA_ACTION_PATHS,
  resolveArunaActionPaths,
  resolveArunaRuntimePaths,
  resolveArunaSignalPaths,
} from "./tsconfig-paths.js";
import { partitionedRojoProject } from "./rojo-layout.js";

export type InitOptions = {
  projectRoot: string;
};

export type InitResult = {
  projectRoot: string;
  created: string[];
  skipped: string[];
};

// Default generated dir; matches the compiler config default so the scaffolded
// tsconfig aliases line up with what `aruna build --emit-runtime` writes.
const GENERATED_DIR = "src/.aruna";

function arunaConfigTemplate(): string {
  return `import { defineConfig } from "aruna";

export default defineConfig({
  root: "src",
});
`;
}

function tsconfigTemplate(projectRoot: string): string {
  const tsconfigPath = path.join(projectRoot, "tsconfig.json");
  const actionPaths = resolveArunaActionPaths(tsconfigPath, GENERATED_DIR);
  const paths: Record<string, string[]> = {
    [ARUNA_ACTION_PATHS.client]: actionPaths.client,
    [ARUNA_ACTION_PATHS.server]: actionPaths.server,
    ...resolveArunaSignalPaths(tsconfigPath, GENERATED_DIR),
    ...resolveArunaRuntimePaths(tsconfigPath, GENERATED_DIR),
  };

  const tsconfig = {
    compilerOptions: {
      target: "ESNext",
      module: "CommonJS",
      moduleResolution: "Node",
      moduleDetection: "force",
      strict: true,
      noLib: true,
      baseUrl: ".",
      rootDir: "src",
      outDir: "out",
      jsx: "preserve",
      declaration: false,
      downlevelIteration: true,
      allowSyntheticDefaultImports: true,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
      noUncheckedIndexedAccess: true,
      verbatimModuleSyntax: false,
      typeRoots: ["./node_modules", "./node_modules/@rbxts"],
      types: ["@rbxts/types", "@rbxts/compiler-types"],
      paths,
    },
    include: ["src/**/*.ts", "src/**/*.tsx"],
    exclude: ["aruna.config.ts", "out", "node_modules"],
  };

  return `${JSON.stringify(tsconfig, null, 2)}\n`;
}

function defaultProjectTemplate(): string {
  // The service-separated DataModel contract `aruna build` partitions `out/`
  // onto: server code → ServerScriptService (not replicated), client →
  // StarterPlayerScripts, shared (+ vendored runtime + client stubs) →
  // ReplicatedStorage.
  return `${JSON.stringify(partitionedRojoProject(), null, 2)}\n`;
}

export function runInit(options: InitOptions): InitResult {
  const files: Array<{ name: string; contents: string }> = [
    { name: "aruna.config.ts", contents: arunaConfigTemplate() },
    { name: "tsconfig.json", contents: tsconfigTemplate(options.projectRoot) },
    { name: "default.project.json", contents: defaultProjectTemplate() },
  ];

  const created: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const filePath = path.join(options.projectRoot, file.name);
    if (fs.existsSync(filePath)) {
      skipped.push(file.name);
      continue;
    }
    fs.writeFileSync(filePath, file.contents, "utf8");
    created.push(file.name);
  }

  return { projectRoot: options.projectRoot, created, skipped };
}

export function formatInitReport(result: InitResult): string {
  const lines: string[] = ["aruna init", ""];

  if (result.created.length > 0) {
    lines.push("created");
    for (const name of result.created) {
      lines.push(`  + ${name}`);
    }
  }

  if (result.skipped.length > 0) {
    if (result.created.length > 0) {
      lines.push("");
    }
    lines.push("kept existing");
    for (const name of result.skipped) {
      lines.push(`  = ${name}`);
    }
  }

  lines.push("");
  lines.push("next steps");
  lines.push("  1. add your actions under src/ (e.g. src/domains/<feature>/actions.ts)");
  lines.push(
    "  2. aruna build   # generate stubs, vendor the Roblox runtime, and compile to Luau via rbxtsc",
  );
  lines.push(
    "     (--no-emit-luau stops after vendoring; --no-emit-runtime skips vendoring too)",
  );

  return lines.join("\n");
}
