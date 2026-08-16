import fs from "node:fs";
import path from "node:path";
import {
  ARUNA_TSCONFIG_FRAGMENT_FILE,
  arunaTsconfigExtendsRef,
  arunaTsconfigFragmentContents,
} from "./tsconfig-paths.js";
import { partitionedRojoProject } from "./rojo-layout.js";
import {
  NODE_MODULES_PROJECT_FILE,
  arunaNodeModulesProjectContents,
  nodeModulesProjectMount,
} from "./rojo-node-modules.js";
import {
  ROJO_PROJECT_FILE,
  formatRojoProjectProblem,
  inspectRojoProject,
  type RojoProjectReport,
} from "./rojo-project.js";

export type InitOptions = {
  projectRoot: string;
  // Overwrite the scaffolded files instead of keeping what is already there.
  // The escape hatch for adopting Aruna inside an existing Rojo project, whose
  // project file mounts Luau sources rather than the compiled `out/` tree.
  force?: boolean | undefined;
};

export type InitResult = {
  projectRoot: string;
  created: string[];
  overwritten: string[];
  skipped: string[];
  // State of the Rojo project file after init. An `incomplete` report on a file
  // init kept is the silent-failure case worth shouting about: everything
  // downstream exits 0 and the built place holds none of the compiled code.
  rojoProject: RojoProjectReport;
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

  // Everything a roblox-ts + Aruna project needs and nobody chooses — the
  // compile contract, the src -> out layout, the @rbxts type roots, and the
  // aruna path aliases — comes from the generated fragment, so this file holds
  // only what the project actually decides. Any key here overrides the
  // fragment (TypeScript `extends` semantics), so `jsx` and friends stay the
  // project's call.
  const tsconfig = {
    extends: arunaTsconfigExtendsRef(tsconfigPath, GENERATED_DIR),
    compilerOptions: {},
  };

  return `${JSON.stringify(tsconfig, null, 2)}\n`;
}

function defaultProjectTemplate(): string {
  // The service-separated DataModel contract `aruna build` partitions `out/`
  // onto: server code → ServerScriptService (not replicated), client →
  // StarterPlayerScripts, shared (+ vendored runtime + client stubs) →
  // ReplicatedStorage.
  //
  // node_modules is mounted through the generated nested project file, so
  // adding a Roblox-facing dependency never means editing this file.
  return `${JSON.stringify(
    partitionedRojoProject({ nodeModulesProject: nodeModulesProjectMount(GENERATED_DIR) }),
    null,
    2,
  )}\n`;
}

export function runInit(options: InitOptions): InitResult {
  const fragmentName = path.posix.join(GENERATED_DIR, ARUNA_TSCONFIG_FRAGMENT_FILE);
  const files: Array<{ name: string; contents: string }> = [
    { name: "aruna.config.ts", contents: arunaConfigTemplate() },
    { name: "tsconfig.json", contents: tsconfigTemplate(options.projectRoot) },
    // The scaffolded tsconfig `extends` the fragment, so an initial copy must
    // exist before the first `aruna build` regenerates it.
    {
      name: fragmentName,
      contents: arunaTsconfigFragmentContents(options.projectRoot, GENERATED_DIR),
    },
    // Same reasoning as the tsconfig fragment: the scaffolded Rojo project
    // mounts it, so an initial copy must exist before the first `aruna build`
    // regenerates it from node_modules/.
    {
      name: path.posix.join(GENERATED_DIR, NODE_MODULES_PROJECT_FILE),
      contents: arunaNodeModulesProjectContents(options.projectRoot, GENERATED_DIR),
    },
    { name: ROJO_PROJECT_FILE, contents: defaultProjectTemplate() },
  ];

  const created: string[] = [];
  const overwritten: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const filePath = path.join(options.projectRoot, file.name);
    const exists = fs.existsSync(filePath);
    if (exists && !options.force) {
      skipped.push(file.name);
      continue;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, file.contents, "utf8");
    (exists ? overwritten : created).push(file.name);
  }

  return {
    projectRoot: options.projectRoot,
    created,
    overwritten,
    skipped,
    rojoProject: inspectRojoProject(options.projectRoot, undefined, GENERATED_DIR),
  };
}

export function formatInitReport(result: InitResult): string {
  const lines: string[] = ["aruna init", ""];

  if (result.created.length > 0) {
    lines.push("created");
    for (const name of result.created) {
      lines.push(`  + ${name}`);
    }
  }

  if (result.overwritten.length > 0) {
    if (result.created.length > 0) {
      lines.push("");
    }
    lines.push("overwritten (--force)");
    for (const name of result.overwritten) {
      lines.push(`  ! ${name}`);
    }
  }

  if (result.skipped.length > 0) {
    if (result.created.length > 0 || result.overwritten.length > 0) {
      lines.push("");
    }
    lines.push("kept existing");
    for (const name of result.skipped) {
      lines.push(`  = ${name}`);
    }
  }

  // Keeping an existing Rojo project file is the safe default, but it is only
  // correct when that file already mounts the compiled `out/` tree. Say so
  // loudly when it does not — nothing downstream fails on this.
  const rojoProblem = formatRojoProjectProblem(result.rojoProject);
  if (rojoProblem.length > 0) {
    lines.push("");
    lines.push("warning");
    for (const line of rojoProblem) {
      lines.push(`  ${line}`);
    }
  }

  lines.push("");
  lines.push("next steps");
  lines.push(
    "  1. add your actions under src/ (e.g. src/domains/<feature>/actions.ts, or actions/ once it grows)",
  );
  lines.push(
    "  2. aruna build   # generate stubs, vendor the Roblox runtime, and compile to Luau via rbxtsc",
  );
  lines.push(
    "     (--no-emit-luau stops after vendoring; --no-emit-runtime skips vendoring too)",
  );

  return lines.join("\n");
}
