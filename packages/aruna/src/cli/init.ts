import fs from "node:fs";
import path from "node:path";
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
import {
  formatTsconfigSetup,
  setUpTsconfig,
  tsconfigSetupSummary,
} from "./tsconfig-setup.js";

export type InitOptions = {
  projectRoot: string;
  // Overwrite the scaffolded files instead of keeping what is already there.
  // The escape hatch for adopting Aruna inside an existing Rojo project, whose
  // project file mounts Luau sources rather than the compiled `out/` tree.
  // tsconfig.json is never overwritten: it gets the upkeep either way.
  force?: boolean | undefined;
};

export type InitResult = {
  projectRoot: string;
  created: string[];
  overwritten: string[];
  skipped: string[];
  // tsconfig.json is not a template: like `aruna build`, init creates it or
  // adds what it lacks and keeps everything else. It shows up in `created`
  // when it was created and in `skipped` when it needed nothing.
  tsconfig: ReturnType<typeof tsconfigSetupSummary>;
  // State of the Rojo project file after init. An `incomplete` report on a file
  // init kept is the silent-failure case worth shouting about: everything
  // downstream exits 0 and the built place holds none of the compiled code.
  rojoProject: RojoProjectReport;
};

// Default generated dir; matches the compiler config default so the tsconfig
// aliases line up with what `aruna build --emit-runtime` writes.
const GENERATED_DIR = "src/.aruna";

function arunaConfigTemplate(): string {
  return `import { defineConfig } from "aruna";

export default defineConfig({
  root: "src",
});
`;
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
  const created: string[] = [];
  const overwritten: string[] = [];
  const skipped: string[] = [];

  const scaffold = (name: string, contents: string): void => {
    const filePath = path.join(options.projectRoot, name);
    const exists = fs.existsSync(filePath);
    if (exists && !options.force) {
      skipped.push(name);
      return;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, "utf8");
    (exists ? overwritten : created).push(name);
  };

  scaffold("aruna.config.ts", arunaConfigTemplate());

  const tsconfig = setUpTsconfig({ projectRoot: options.projectRoot, generatedDir: GENERATED_DIR });
  if (tsconfig.status === "create") {
    created.push("tsconfig.json");
  } else if (tsconfig.status !== "update") {
    skipped.push("tsconfig.json");
  }

  // The scaffolded Rojo project mounts it, so an initial copy must exist
  // before the first `aruna build` regenerates it from node_modules/.
  scaffold(
    path.posix.join(GENERATED_DIR, NODE_MODULES_PROJECT_FILE),
    arunaNodeModulesProjectContents(options.projectRoot, GENERATED_DIR),
  );
  scaffold(ROJO_PROJECT_FILE, defaultProjectTemplate());

  return {
    projectRoot: options.projectRoot,
    created,
    overwritten,
    skipped,
    tsconfig: tsconfigSetupSummary(tsconfig),
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

  const [, ...tsconfigChanges] = formatTsconfigSetup(result.tsconfig, "applied");
  if (result.tsconfig.status === "update") {
    if (result.created.length > 0 || result.overwritten.length > 0) {
      lines.push("");
    }
    lines.push("reconfigured (your settings kept)");
    lines.push("  ~ tsconfig.json");
    for (const line of tsconfigChanges) {
      lines.push(line === "" ? "" : `  ${line}`);
    }
  }

  if (result.skipped.length > 0) {
    if (
      result.created.length > 0 ||
      result.overwritten.length > 0 ||
      result.tsconfig.status === "update"
    ) {
      lines.push("");
    }
    lines.push("kept existing");
    for (const name of result.skipped) {
      lines.push(`  = ${name}`);
    }
  }

  if (result.tsconfig.status === "unreadable") {
    lines.push("");
    lines.push("warning");
    lines.push(
      `  tsconfig.json was left as it is: ${result.tsconfig.error ?? "it could not be read"}.`,
    );
    lines.push("  Fix it, then run `aruna init` or `aruna build` again to configure it.");
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
