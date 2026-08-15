import fs from "node:fs";
import path from "node:path";
import { loadProjectConfig } from "@arunajs/compiler";
import type { Diagnostic } from "@arunajs/core";
import {
  ARUNA_ACTION_PATHS,
  ARUNA_TSCONFIG_FRAGMENT_FILE,
  addFragmentToExtends,
  arunaTsconfigExtendsRef,
  arunaTsconfigFragmentContents,
  extendsIncludesFragment,
  inspectArunaActionPaths,
  isArunaOwnedAlias,
  resolveArunaActionPaths,
  resolveArunaRuntimePaths,
  resolveArunaSignalPaths,
  updateArunaActionPaths,
  updateArunaRuntimePaths,
} from "./tsconfig-paths.js";
import {
  formatRojoProjectProblem,
  inspectRojoProject,
  type RojoProjectReport,
} from "./rojo-project.js";

export type DoctorOptions = {
  projectRoot: string;
  configPath?: string | undefined;
  fix?: boolean | undefined;
  emitRuntime?: boolean | undefined;
};

// roblox-ts pins the exact TypeScript version it can drive (it taps compiler
// internals), so an installed typescript that drifts from the pin fails at
// rbxtsc time with confusing errors — the classic rbxts setup trap. Doctor
// surfaces the mismatch directly.
export type ToolchainReport = {
  robloxTsVersion?: string | undefined;
  typescriptVersion?: string | undefined;
  // roblox-ts's own typescript dependency declaration (the pin).
  expectedTypescript?: string | undefined;
  status: "ok" | "skew" | "unknown";
};

export type DoctorReport = {
  projectRoot: string;
  configPath?: string | undefined;
  tsconfigPath: string;
  generatedDir: string;
  generatedDirResolved: string;
  manifestOutput: string;
  manifestOutputResolved: string;
  configDiagnostics: Diagnostic[];
  tsconfigDiagnostics: Diagnostic[];
  // "extends": the tsconfig references the generated fragment and inherits all
  // aruna aliases from it. "inline": aliases are managed inside the tsconfig
  // itself (legacy layout, or a project with its own compilerOptions.paths).
  aliasMode: "extends" | "inline";
  fragment: {
    // Project-relative posix path of <generatedDir>/tsconfig.aruna.json.
    path: string;
    referenced: boolean;
    status: "missing" | "correct" | "stale";
  };
  // True when the tsconfig extends the fragment but also declares its own
  // compilerOptions.paths — TS replaces inherited paths wholesale, so the
  // fragment's aliases are shadowed and must be kept aligned inline (aruna::112).
  pathsShadowFragment: boolean;
  expectedPaths: {
    client: string[];
    server: string[];
  };
  actualPaths: {
    client?: string[] | undefined;
    server?: string[] | undefined;
  };
  status: {
    client: "missing" | "correct" | "incorrect";
    server: "missing" | "correct" | "incorrect";
    baseUrlPresent: boolean;
    baseUrlRequired: boolean;
    baseUrlRecommended: boolean;
  };
  toolchain: ToolchainReport;
  // The Rojo project file measured against the partitioned `out/` contract.
  // Nothing else in the pipeline looks at it, so an unmounted `out/` is
  // otherwise invisible: every command exits 0 and the place comes out empty.
  rojoProject: RojoProjectReport;
  fixable: boolean;
  fixApplied: boolean;
  fixChanges: string[];
};

type TsconfigJsonObject = Record<string, unknown>;

type PackageJsonShape = {
  version?: unknown;
  dependencies?: Record<string, unknown> | undefined;
  peerDependencies?: Record<string, unknown> | undefined;
};

// Reads the package.json of `packageName` from the nearest node_modules,
// walking up from the project root (mirrors how Node resolves the install the
// consumer actually gets in a workspace).
function readInstalledPackageJson(
  startDir: string,
  packageName: string,
): PackageJsonShape | undefined {
  let current = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(current, "node_modules", packageName, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        return JSON.parse(fs.readFileSync(candidate, "utf8")) as PackageJsonShape;
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function inspectToolchain(projectRoot: string): ToolchainReport {
  const robloxTs = readInstalledPackageJson(projectRoot, "roblox-ts");
  const typescript = readInstalledPackageJson(projectRoot, "typescript");
  const robloxTsVersion =
    typeof robloxTs?.version === "string" ? robloxTs.version : undefined;
  const typescriptVersion =
    typeof typescript?.version === "string" ? typescript.version : undefined;
  const declared =
    robloxTs?.dependencies?.["typescript"] ?? robloxTs?.peerDependencies?.["typescript"];
  const expectedTypescript = typeof declared === "string" ? declared : undefined;

  if (
    robloxTsVersion === undefined ||
    typescriptVersion === undefined ||
    expectedTypescript === undefined
  ) {
    return { robloxTsVersion, typescriptVersion, expectedTypescript, status: "unknown" };
  }

  // Only an exact pin (e.g. "5.5.3" / "=5.5.3") is enforced; a range is the
  // package manager's job to satisfy.
  const exact = expectedTypescript.replace(/^=/, "");
  if (!/^\d+\.\d+\.\d+$/.test(exact)) {
    return { robloxTsVersion, typescriptVersion, expectedTypescript, status: "ok" };
  }

  return {
    robloxTsVersion,
    typescriptVersion,
    expectedTypescript,
    status: exact === typescriptVersion ? "ok" : "skew",
  };
}

function readTsconfig(tsconfigPath: string): { value?: TsconfigJsonObject; error?: string } {
  if (!fs.existsSync(tsconfigPath)) {
    return { error: "missing" };
  }

  try {
    const raw = fs.readFileSync(tsconfigPath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { error: "top-level JSON value must be an object" };
    }

    return { value: parsed as TsconfigJsonObject };
  } catch {
    return { error: "invalid JSON" };
  }
}

function createTsconfigDiagnostic(tsconfigPath: string, error: string): Diagnostic {
  const file = path.basename(tsconfigPath);
  if (error === "missing") {
    return {
      code: "aruna::102",
      name: "missing-tsconfig",
      severity: "warning",
      message: `Missing TypeScript config at ${path.basename(tsconfigPath)}.`,
      file,
      details: "Aruna looked for the TypeScript config at the resolved path but could not find it.",
      suggestion: "Create tsconfig.json or point aruna.config.ts to an existing tsconfig file.",
    };
  }

  return {
    code: "aruna::103",
    name: "invalid-tsconfig",
    severity: "error",
    message: `Malformed TypeScript config at ${path.basename(tsconfigPath)}.`,
    file,
    details: error,
    suggestion: "Fix the tsconfig JSON syntax or use a supported top-level object shape.",
  };
}

function displayPath(projectRoot: string, absolutePath: string): string {
  const relativePath = path.relative(projectRoot, absolutePath);
  return relativePath.length > 0 ? relativePath.split(path.sep).join("/") : ".";
}

function formatPathList(values: readonly string[]): string {
  return values.join(", ");
}

function renderStatusLabel(status: "missing" | "correct" | "incorrect"): string {
  switch (status) {
    case "correct":
      return "ok";
    case "incorrect":
      return "incorrect";
    case "missing":
      return "missing";
  }
}

function renderDiagnosticSummary(diagnostic: Diagnostic): string {
  const parts = [`${diagnostic.code} ${diagnostic.message}`];
  if (diagnostic.details) {
    parts.push(diagnostic.details);
  }
  return parts.join(" ");
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = ["aruna doctor", ""];
  const extendsClean = report.aliasMode === "extends" && !report.pathsShadowFragment;
  const needsFix = extendsClean
    ? report.fragment.status !== "correct"
    : report.status.client !== "correct" ||
      report.status.server !== "correct" ||
      !report.status.baseUrlPresent;
  lines.push(`project: ${displayPath(process.cwd(), report.projectRoot)}`);
  if (report.configPath) {
    lines.push(`config: ${displayPath(report.projectRoot, report.configPath)}`);
  }
  lines.push(`tsconfig: ${displayPath(report.projectRoot, report.tsconfigPath)}`);
  lines.push(`generated dir: ${report.generatedDir}`);
  lines.push(`manifest: ${report.manifestOutput}`);
  lines.push(`generated dir resolved: ${report.generatedDirResolved}`);
  lines.push(`manifest resolved: ${report.manifestOutputResolved}`);
  lines.push(`fix available: ${report.fixable ? "yes" : "no"}`);

  if (report.configDiagnostics.length > 0 || report.tsconfigDiagnostics.length > 0) {
    lines.push("");
    lines.push("problems");
    for (const diagnostic of [...report.configDiagnostics, ...report.tsconfigDiagnostics]) {
      lines.push(`  - ${renderDiagnosticSummary(diagnostic)}`);
    }
  }

  lines.push("");
  lines.push("tsconfig aliases");
  lines.push(
    `  mode: ${report.aliasMode}${report.aliasMode === "extends" ? ` (${report.fragment.path})` : ""}`,
  );
  if (report.aliasMode === "extends") {
    lines.push(
      `  fragment: ${report.fragment.status === "correct" ? "ok" : report.fragment.status}${
        report.fragment.status === "stale" ? " — run `aruna build` to regenerate" : ""
      }`,
    );
  }
  if (report.pathsShadowFragment) {
    lines.push(
      "  warning: compilerOptions.paths shadows the generated fragment (aruna::112) — " +
        "the aruna aliases below must stay aligned inline",
    );
  }
  if (!extendsClean) {
    lines.push(
      `  baseUrl: ${report.status.baseUrlPresent ? "present" : "missing"}${report.status.baseUrlRequired ? " (required)" : ""}`,
    );
    lines.push(
      `  ${ARUNA_ACTION_PATHS.client} -> ${formatPathList(report.expectedPaths.client)}  ${renderStatusLabel(report.status.client)}`,
    );
    if (report.status.client === "incorrect" && report.actualPaths.client) {
      lines.push(`    current: ${formatPathList(report.actualPaths.client)}`);
    }
    lines.push(
      `  ${ARUNA_ACTION_PATHS.server} -> ${formatPathList(report.expectedPaths.server)}  ${renderStatusLabel(report.status.server)}`,
    );
    if (report.status.server === "incorrect" && report.actualPaths.server) {
      lines.push(`    current: ${formatPathList(report.actualPaths.server)}`);
    }
  }

  lines.push("");
  lines.push("rojo project");
  const rojoProblem = formatRojoProjectProblem(report.rojoProject);
  if (rojoProblem.length === 0) {
    lines.push(`  ${report.rojoProject.path}: ok (mounts ${report.rojoProject.present.join(", ")})`);
  } else {
    for (const line of rojoProblem) {
      lines.push(`  ${line}`);
    }
  }

  if (report.toolchain.robloxTsVersion !== undefined) {
    lines.push("");
    lines.push("toolchain");
    lines.push(`  roblox-ts: ${report.toolchain.robloxTsVersion}`);
    lines.push(
      `  typescript: ${report.toolchain.typescriptVersion ?? "not installed"}` +
        (report.toolchain.expectedTypescript !== undefined
          ? ` (roblox-ts expects ${report.toolchain.expectedTypescript})`
          : ""),
    );
    if (report.toolchain.status === "skew") {
      lines.push(
        `  warning: typescript ${report.toolchain.typescriptVersion} does not match the ` +
          `${report.toolchain.expectedTypescript} roblox-ts ${report.toolchain.robloxTsVersion} pins — ` +
          `rbxtsc can fail with confusing errors. Pin "typescript": "${report.toolchain.expectedTypescript}" ` +
          `in devDependencies.`,
      );
    }
  }

  if (report.fixApplied) {
    lines.push("");
    if (report.fixChanges.length > 0) {
      lines.push("fixed tsconfig.json");
      for (const change of report.fixChanges) {
        lines.push(`  - ${change}`);
      }
    } else {
      lines.push("tsconfig.json already matched the Aruna aliases");
    }
  } else if (
    report.configDiagnostics.length > 0 ||
    report.tsconfigDiagnostics.length > 0 ||
    needsFix
  ) {
    lines.push("");
    if (report.fixable) {
      lines.push(
        `run \`aruna doctor --fix --project ${displayPath(process.cwd(), report.projectRoot)}\` to update tsconfig.json`,
      );
    } else {
      lines.push("unable to fix automatically until the project config and tsconfig are valid");
    }
  } else if (rojoProblem.length > 0) {
    // The aliases are healthy but the place would still build empty; never
    // report "done" over that.
    lines.push("");
    lines.push("the Rojo project above must be fixed before the build reaches the place");
  } else {
    lines.push("");
    lines.push("done");
  }

  return lines.join("\n");
}

function inspectFragment(
  projectRoot: string,
  generatedDir: string,
): { path: string; status: "missing" | "correct" | "stale" } {
  const fragmentRel = path
    .join(generatedDir, ARUNA_TSCONFIG_FRAGMENT_FILE)
    .split(path.sep)
    .join("/");
  const fragmentAbs = path.resolve(projectRoot, generatedDir, ARUNA_TSCONFIG_FRAGMENT_FILE);
  if (!fs.existsSync(fragmentAbs)) {
    return { path: fragmentRel, status: "missing" };
  }
  const expected = arunaTsconfigFragmentContents(projectRoot, generatedDir);
  const actual = fs.readFileSync(fragmentAbs, "utf8");
  return { path: fragmentRel, status: actual === expected ? "correct" : "stale" };
}

export function inspectDoctorProject(options: DoctorOptions): DoctorReport {
  const loaded = loadProjectConfig(options.projectRoot, options.configPath);
  const generatedDir = loaded.config.generatedDir;
  const generatedDirResolved = path.resolve(options.projectRoot, generatedDir);
  const manifestOutput = loaded.config.manifestOutput;
  const manifestOutputResolved = path.resolve(options.projectRoot, manifestOutput);
  const tsconfigPath = loaded.tsconfigPath;
  const expectedPaths = resolveArunaActionPaths(tsconfigPath, generatedDir);
  const tsconfigResult = readTsconfig(tsconfigPath);
  const tsconfigDiagnostics = loaded.diagnostics.filter(
    (diagnostic) => diagnostic.code === "aruna::102" || diagnostic.code === "aruna::103",
  );
  const configDiagnostics = loaded.diagnostics.filter(
    (diagnostic) => diagnostic.code !== "aruna::102" && diagnostic.code !== "aruna::103",
  );
  const effectiveTsconfigDiagnostics =
    tsconfigDiagnostics.length > 0 || !tsconfigResult.error
      ? tsconfigDiagnostics
      : [createTsconfigDiagnostic(tsconfigPath, tsconfigResult.error)];
  const fragment = inspectFragment(options.projectRoot, generatedDir);
  const toolchain = inspectToolchain(options.projectRoot);
  const rojoProject = inspectRojoProject(options.projectRoot, undefined, generatedDir);

  if (!tsconfigResult.value) {
    return {
      projectRoot: options.projectRoot,
      configPath: loaded.configPath,
      tsconfigPath,
      generatedDir,
      generatedDirResolved,
      manifestOutput,
      manifestOutputResolved,
      configDiagnostics,
      tsconfigDiagnostics: effectiveTsconfigDiagnostics,
      aliasMode: "inline",
      fragment: { ...fragment, referenced: false },
      pathsShadowFragment: false,
      expectedPaths,
      actualPaths: {},
      status: {
        client: "missing",
        server: "missing",
        baseUrlPresent: false,
        baseUrlRequired: true,
        baseUrlRecommended: false,
      },
      toolchain,
      rojoProject,
      fixable: false,
      fixApplied: false,
      fixChanges: [],
    };
  }

  const inspection = inspectArunaActionPaths(tsconfigResult.value, expectedPaths);
  const extendsRef = arunaTsconfigExtendsRef(tsconfigPath, generatedDir);
  const referenced = extendsIncludesFragment(tsconfigResult.value, extendsRef);
  const pathsShadowFragment = referenced && inspection.paths !== undefined;
  const aliasMode = referenced ? "extends" : "inline";
  const extendsClean = referenced && !pathsShadowFragment;

  return {
    projectRoot: options.projectRoot,
    configPath: loaded.configPath,
    tsconfigPath,
    generatedDir,
    generatedDirResolved,
    manifestOutput,
    manifestOutputResolved,
    configDiagnostics,
    tsconfigDiagnostics: effectiveTsconfigDiagnostics,
    aliasMode,
    fragment: { ...fragment, referenced },
    pathsShadowFragment,
    expectedPaths,
    actualPaths: inspection.current,
    status: {
      // In clean extends mode the fragment supplies every alias (and its own
      // baseUrl); the inline alias inspection only governs otherwise.
      client: extendsClean && fragment.status === "correct" ? "correct" : inspection.status.client,
      server: extendsClean && fragment.status === "correct" ? "correct" : inspection.status.server,
      baseUrlPresent: inspection.hasBaseUrl,
      baseUrlRequired: !extendsClean,
      baseUrlRecommended: false,
    },
    toolchain,
    rojoProject,
    fixable: configDiagnostics.length === 0 && effectiveTsconfigDiagnostics.length === 0,
    fixApplied: false,
    fixChanges: [],
  };
}

// Realigns the aruna aliases inside compilerOptions.paths (legacy inline
// management). Used when the project keeps its own path aliases, which shadow
// the generated fragment under `extends` — the aruna aliases must then live
// inline alongside them.
function applyInlineAliasFix(
  tsconfig: TsconfigJsonObject,
  report: DoctorReport,
  options: DoctorOptions,
): { changed: boolean; contents: string; fixChanges: string[] } {
  const actionUpdate = updateArunaActionPaths(tsconfig, report.expectedPaths, {
    requireBaseUrl: true,
  });
  let finalContents = actionUpdate.contents;
  let changed = actionUpdate.changed;

  // The $aruna/signals virtual-module alias is installed alongside the action
  // aliases (always, like actions — independent of runtime vendoring).
  const signalChanges: string[] = [];
  const signalPaths = resolveArunaSignalPaths(report.tsconfigPath, report.generatedDir);
  const signalUpdate = updateArunaRuntimePaths(tsconfig, signalPaths);
  finalContents = signalUpdate.contents;
  if (signalUpdate.changed) {
    changed = true;
    for (const [alias, targets] of Object.entries(signalPaths)) {
      signalChanges.push(`${alias} -> ${formatPathList(targets)}`);
    }
  }

  const runtimeChanges: string[] = [];
  if (options.emitRuntime) {
    const runtimePaths = resolveArunaRuntimePaths(report.tsconfigPath, report.generatedDir);
    const runtimeUpdate = updateArunaRuntimePaths(tsconfig, runtimePaths, {
      pruneStaleRuntimeAliases: true,
    });
    finalContents = runtimeUpdate.contents;
    if (runtimeUpdate.changed) {
      changed = true;
      for (const [alias, targets] of Object.entries(runtimePaths)) {
        runtimeChanges.push(`${alias} -> ${formatPathList(targets)}`);
      }
    }
  }

  const fixChanges: string[] = [];
  if (changed) {
    if (!report.status.baseUrlPresent) {
      fixChanges.push('added compilerOptions.baseUrl = "."');
    }
    if (report.status.client !== "correct") {
      fixChanges.push(
        `${ARUNA_ACTION_PATHS.client} -> ${formatPathList(report.expectedPaths.client)}`,
      );
    }
    if (report.status.server !== "correct") {
      fixChanges.push(
        `${ARUNA_ACTION_PATHS.server} -> ${formatPathList(report.expectedPaths.server)}`,
      );
    }
    fixChanges.push(...signalChanges);
    fixChanges.push(...runtimeChanges);
  }

  return { changed, contents: finalContents, fixChanges };
}

export function fixDoctorProject(options: DoctorOptions): DoctorReport {
  const report = inspectDoctorProject(options);
  if (
    !report.fixable ||
    report.configDiagnostics.length > 0 ||
    report.tsconfigDiagnostics.length > 0
  ) {
    return report;
  }

  const tsconfigResult = readTsconfig(report.tsconfigPath);
  if (!tsconfigResult.value) {
    return report;
  }
  const tsconfig = tsconfigResult.value;
  const fixChanges: string[] = [];

  // The fragment is generated output: always converge it first.
  if (report.fragment.status !== "correct") {
    const fragmentAbs = path.resolve(
      report.projectRoot,
      report.generatedDir,
      ARUNA_TSCONFIG_FRAGMENT_FILE,
    );
    fs.mkdirSync(path.dirname(fragmentAbs), { recursive: true });
    fs.writeFileSync(
      fragmentAbs,
      arunaTsconfigFragmentContents(report.projectRoot, report.generatedDir),
      "utf8",
    );
    fixChanges.push(`wrote ${report.fragment.path}`);
  }

  const compilerOptions = tsconfig["compilerOptions"];
  const paths =
    typeof compilerOptions === "object" &&
    compilerOptions !== null &&
    !Array.isArray(compilerOptions) &&
    typeof (compilerOptions as TsconfigJsonObject)["paths"] === "object" &&
    (compilerOptions as TsconfigJsonObject)["paths"] !== null &&
    !Array.isArray((compilerOptions as TsconfigJsonObject)["paths"])
      ? ((compilerOptions as TsconfigJsonObject)["paths"] as TsconfigJsonObject)
      : undefined;
  const userAliases = paths ? Object.keys(paths).filter((key) => !isArunaOwnedAlias(key)) : [];

  if (userAliases.length > 0) {
    // The project owns other path aliases; they shadow the fragment, so the
    // aruna aliases must stay aligned inline next to them.
    const inlineFix = applyInlineAliasFix(tsconfig, report, options);
    if (inlineFix.changed) {
      fs.writeFileSync(report.tsconfigPath, inlineFix.contents, "utf8");
      fixChanges.push(...inlineFix.fixChanges);
    }
  } else {
    // Migrate to extends-managed aliases: drop the aruna-owned inline aliases
    // (the whole paths block only held aruna aliases, if it existed at all)
    // and reference the fragment once.
    let tsconfigChanged = false;
    if (paths !== undefined) {
      delete (compilerOptions as TsconfigJsonObject)["paths"];
      tsconfigChanged = true;
      fixChanges.push(`removed inline Aruna aliases (now provided by ${report.fragment.path})`);
    }
    const extendsRef = arunaTsconfigExtendsRef(report.tsconfigPath, report.generatedDir);
    if (addFragmentToExtends(tsconfig, extendsRef)) {
      tsconfigChanged = true;
      fixChanges.push(`extends ${extendsRef}`);
    }
    if (tsconfigChanged) {
      fs.writeFileSync(report.tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`, "utf8");
    }
  }

  // Re-inspect so the reported state reflects what is now on disk.
  return {
    ...inspectDoctorProject(options),
    fixApplied: true,
    fixChanges,
  };
}

export function runDoctor(options: DoctorOptions): DoctorReport {
  return options.fix ? fixDoctorProject(options) : inspectDoctorProject(options);
}

export function doctorExitCode(report: DoctorReport): number {
  if (report.configDiagnostics.length > 0 || report.tsconfigDiagnostics.length > 0) {
    return 1;
  }

  // A Rojo project that does not mount `out/` builds an empty place while every
  // other command reports success — the loudest signal available is this exit
  // code, so it counts as a failure even though `--fix` cannot repair it.
  // Deliberately narrow to `incomplete`: a missing or malformed project file is
  // something `rojo build` itself refuses loudly, and the project may legitimately
  // keep its Rojo config elsewhere.
  if (report.rojoProject.status === "incomplete") {
    return 1;
  }

  return report.status.client === "correct" && report.status.server === "correct" ? 0 : 1;
}
