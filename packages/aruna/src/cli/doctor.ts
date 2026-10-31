import fs from "node:fs";
import path from "node:path";
import { loadProjectConfig } from "@arunajs/compiler";
import type { Diagnostic } from "@arunajs/core";
import {
  formatRojoProjectProblem,
  inspectRojoProject,
  type RojoProjectReport,
} from "./rojo-project.js";
import {
  applyTsconfigSetup,
  formatTsconfigSetup,
  planTsconfigSetup,
  tsconfigSetupSummary,
  type TsconfigAliasStatus,
  type TsconfigChange,
  type TsconfigSetupSummary,
} from "./tsconfig-setup.js";

export type DoctorOptions = {
  projectRoot: string;
  configPath?: string | undefined;
  fix?: boolean | undefined;
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
  // What tsconfig.json still lacks: the changes `aruna build` makes on its own
  // before it compiles. Only mandatory changes fail the doctor; suggested
  // values are listed for the project to take or leave.
  tsconfig: {
    status: "ok" | "needs-update" | "missing" | "unreadable";
    mandatory: readonly TsconfigChange[];
    suggested: readonly TsconfigChange[];
    error?: string | undefined;
  };
  // Every Aruna alias, as tsconfig.json maps it now.
  aliases: readonly TsconfigAliasStatus[];
  toolchain: ToolchainReport;
  // The Rojo project file measured against the partitioned `out/` contract.
  // Nothing else in the pipeline looks at it, so an unmounted `out/` is
  // otherwise invisible: every command exits 0 and the place comes out empty.
  rojoProject: RojoProjectReport;
  fixable: boolean;
  // What `--fix` wrote, when it ran.
  fix?: TsconfigSetupSummary | undefined;
};

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

function displayPath(projectRoot: string, absolutePath: string): string {
  const relativePath = path.relative(projectRoot, absolutePath);
  return relativePath.length > 0 ? relativePath.split(path.sep).join("/") : ".";
}

function renderDiagnosticSummary(diagnostic: Diagnostic): string {
  const parts = [`${diagnostic.code} ${diagnostic.message}`];
  if (diagnostic.details) {
    parts.push(diagnostic.details);
  }
  return parts.join(" ");
}

function needsFix(report: DoctorReport): boolean {
  return (
    report.tsconfig.status === "missing" ||
    (report.tsconfig.status === "needs-update" && report.tsconfig.mandatory.length > 0)
  );
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = ["aruna doctor", ""];
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
  lines.push("tsconfig.json");
  if (report.tsconfig.status === "ok") {
    lines.push("  ok: has everything roblox-ts and Aruna need");
  } else if (report.tsconfig.status === "unreadable") {
    lines.push(`  unreadable: ${report.tsconfig.error ?? "it could not be read"}`);
  } else {
    const [headline, ...changes] = formatTsconfigSetup(
      {
        status: report.tsconfig.status === "missing" ? "create" : "update",
        mandatory: report.tsconfig.mandatory,
        suggested: report.tsconfig.suggested,
      },
      "pending",
    );
    if (headline !== undefined) {
      lines.push(`  ${headline}`);
    }
    for (const line of changes) {
      lines.push(line === "" ? "" : `  ${line}`);
    }
  }

  if (report.aliases.length > 0) {
    lines.push("");
    lines.push("tsconfig aliases");
    for (const alias of report.aliases) {
      lines.push(`  ${alias.alias} -> ${alias.expected}  ${alias.status}`);
      if (alias.status === "stale" && alias.actual !== undefined) {
        const where = alias.declaredIn !== undefined ? ` (in ${alias.declaredIn})` : "";
        lines.push(`    current: ${alias.actual}${where}`);
      }
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

  if (report.fix !== undefined) {
    lines.push("");
    const written = formatTsconfigSetup(report.fix, "applied");
    if (written.length > 0) {
      lines.push(...written);
    } else {
      lines.push("tsconfig.json already had everything roblox-ts and Aruna need");
    }
  } else if (
    report.configDiagnostics.length > 0 ||
    report.tsconfigDiagnostics.length > 0 ||
    needsFix(report)
  ) {
    lines.push("");
    if (report.fixable) {
      lines.push(
        `run \`aruna doctor --fix --project ${displayPath(process.cwd(), report.projectRoot)}\` ` +
          "(or any `aruna build`) to update tsconfig.json",
      );
    } else {
      lines.push("unable to fix automatically until the project config and tsconfig are valid");
    }
  } else if (rojoProblem.length > 0) {
    // tsconfig is healthy but the place would still build empty; never report
    // "done" over that.
    lines.push("");
    lines.push("the Rojo project above must be fixed before the build reaches the place");
  } else {
    lines.push("");
    lines.push("done");
  }

  return lines.join("\n");
}

export function inspectDoctorProject(options: DoctorOptions): DoctorReport {
  const loaded = loadProjectConfig(options.projectRoot, options.configPath);
  const generatedDir = loaded.config.generatedDir;
  const generatedDirResolved = path.resolve(options.projectRoot, generatedDir);
  const manifestOutput = loaded.config.manifestOutput;
  const manifestOutputResolved = path.resolve(options.projectRoot, manifestOutput);
  const tsconfigDiagnostics = loaded.diagnostics.filter(
    (diagnostic) => diagnostic.code === "aruna::102" || diagnostic.code === "aruna::103",
  );
  const configDiagnostics = loaded.diagnostics.filter(
    (diagnostic) => diagnostic.code !== "aruna::102" && diagnostic.code !== "aruna::103",
  );
  const setup = planTsconfigSetup({ projectRoot: options.projectRoot, generatedDir });
  const summary = tsconfigSetupSummary(setup);

  return {
    projectRoot: options.projectRoot,
    configPath: loaded.configPath,
    tsconfigPath: loaded.tsconfigPath,
    generatedDir,
    generatedDirResolved,
    manifestOutput,
    manifestOutputResolved,
    configDiagnostics,
    tsconfigDiagnostics,
    tsconfig: {
      status:
        summary.status === "create"
          ? "missing"
          : summary.status === "update"
            ? "needs-update"
            : summary.status,
      mandatory: summary.mandatory,
      suggested: summary.suggested,
      ...(summary.error !== undefined ? { error: summary.error } : {}),
    },
    aliases: setup.status === "unreadable" ? [] : setup.aliases,
    toolchain: inspectToolchain(options.projectRoot),
    rojoProject: inspectRojoProject(options.projectRoot, undefined, generatedDir),
    // A broken aruna.config.ts hides the generatedDir the aliases point into,
    // and an unreadable tsconfig is the project's to repair.
    fixable:
      setup.status !== "unreadable" &&
      !configDiagnostics.some((diagnostic) => diagnostic.code === "aruna::100"),
  };
}

export function fixDoctorProject(options: DoctorOptions): DoctorReport {
  const report = inspectDoctorProject(options);
  if (!report.fixable) {
    return report;
  }

  const setup = planTsconfigSetup({
    projectRoot: options.projectRoot,
    generatedDir: report.generatedDir,
  });
  applyTsconfigSetup(setup);

  // Re-inspect so the reported state reflects what is now on disk.
  return { ...inspectDoctorProject(options), fix: tsconfigSetupSummary(setup) };
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

  return report.tsconfig.status === "unreadable" || needsFix(report) ? 1 : 0;
}
