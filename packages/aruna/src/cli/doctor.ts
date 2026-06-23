import fs from "node:fs";
import path from "node:path";
import { loadProjectConfig } from "@arunajs/compiler";
import type { ArunaDiagnostic } from "@arunajs/core";
import {
  ARUNA_ACTION_PATHS,
  inspectArunaActionPaths,
  resolveArunaActionPaths,
  resolveArunaRuntimePaths,
  resolveArunaSignalPaths,
  updateArunaActionPaths,
  updateArunaRuntimePaths,
} from "./tsconfig-paths.js";

export type DoctorOptions = {
  projectRoot: string;
  configPath?: string | undefined;
  fix?: boolean | undefined;
  emitRuntime?: boolean | undefined;
};

export type DoctorReport = {
  projectRoot: string;
  configPath?: string | undefined;
  tsconfigPath: string;
  generatedDir: string;
  generatedDirResolved: string;
  manifestOutput: string;
  manifestOutputResolved: string;
  configDiagnostics: ArunaDiagnostic[];
  tsconfigDiagnostics: ArunaDiagnostic[];
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
  fixable: boolean;
  fixApplied: boolean;
  fixChanges: string[];
};

type TsconfigJsonObject = Record<string, unknown>;

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

function createTsconfigDiagnostic(tsconfigPath: string, error: string): ArunaDiagnostic {
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

function renderDiagnosticSummary(diagnostic: ArunaDiagnostic): string {
  const parts = [`${diagnostic.code} ${diagnostic.message}`];
  if (diagnostic.details) {
    parts.push(diagnostic.details);
  }
  return parts.join(" ");
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = ["aruna doctor", ""];
  const needsFix =
    report.status.client !== "correct" ||
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
      expectedPaths,
      actualPaths: {},
      status: {
        client: "missing",
        server: "missing",
        baseUrlPresent: false,
        baseUrlRequired: true,
        baseUrlRecommended: false,
      },
      fixable: false,
      fixApplied: false,
      fixChanges: [],
    };
  }

  const inspection = inspectArunaActionPaths(tsconfigResult.value, expectedPaths);
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
    expectedPaths,
    actualPaths: inspection.current,
    status: {
      client: inspection.status.client,
      server: inspection.status.server,
      baseUrlPresent: inspection.hasBaseUrl,
      baseUrlRequired: true,
      baseUrlRecommended: false,
    },
    fixable: configDiagnostics.length === 0 && effectiveTsconfigDiagnostics.length === 0,
    fixApplied: false,
    fixChanges: [],
  };
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
    const runtimeUpdate = updateArunaRuntimePaths(tsconfig, runtimePaths);
    finalContents = runtimeUpdate.contents;
    if (runtimeUpdate.changed) {
      changed = true;
      for (const [alias, targets] of Object.entries(runtimePaths)) {
        runtimeChanges.push(`${alias} -> ${formatPathList(targets)}`);
      }
    }
  }

  if (!changed) {
    return {
      ...report,
      fixApplied: true,
      fixChanges: [],
    };
  }

  fs.writeFileSync(report.tsconfigPath, finalContents, "utf8");
  const fixChanges: string[] = [];
  if (!report.status.baseUrlPresent && report.status.baseUrlRequired) {
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
  return {
    ...report,
    fixApplied: true,
    fixChanges,
    status: {
      ...report.status,
      client: "correct",
      server: "correct",
      baseUrlPresent: true,
    },
    actualPaths: report.expectedPaths,
  };
}

export function runDoctor(options: DoctorOptions): DoctorReport {
  return options.fix ? fixDoctorProject(options) : inspectDoctorProject(options);
}

export function doctorExitCode(report: DoctorReport): number {
  if (report.configDiagnostics.length > 0 || report.tsconfigDiagnostics.length > 0) {
    return 1;
  }

  return report.status.client === "correct" && report.status.server === "correct" ? 0 : 1;
}
