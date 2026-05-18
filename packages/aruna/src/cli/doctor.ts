import fs from "node:fs";
import path from "node:path";
import { loadProjectConfig } from "@arunajs/compiler";
import type { ArunaConfig, ArunaDiagnostic } from "@arunajs/core";
import { DEFAULT_ARUNA_CONFIG } from "@arunajs/core";
import {
  ARUNA_ACTION_PATHS,
  inspectArunaActionPaths,
  resolveArunaActionPaths,
  updateArunaActionPaths,
} from "./tsconfig-paths.js";

export type DoctorOptions = {
  projectRoot: string;
  configPath?: string | undefined;
  fix?: boolean | undefined;
};

export type DoctorReport = {
  projectRoot: string;
  configPath?: string | undefined;
  tsconfigPath: string;
  generatedDir: string;
  generatedDirResolved: string;
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
    generatedDirSupported: boolean;
    manifestOutputSupported: boolean;
  };
  fixApplied: boolean;
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

function createTsconfigDiagnostic(
  tsconfigPath: string,
  error: string,
): ArunaDiagnostic {
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

function configSupportsGeneratedDir(config: ArunaConfig): boolean {
  return typeof config.generatedDir === "string" || config.generatedDir === undefined;
}

function configSupportsManifestOutput(config: ArunaConfig): boolean {
  return config.manifest === undefined || typeof config.manifest.output === "string" || config.manifest.output === undefined;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = ["aruna doctor", ""];
  lines.push(`project: ${report.projectRoot}`);
  if (report.configPath) {
    lines.push(`config: ${report.configPath}`);
  }
  lines.push(`tsconfig: ${report.tsconfigPath}`);
  lines.push(`generatedDir: ${report.generatedDir}`);
  lines.push(`resolved generatedDir: ${report.generatedDirResolved}`);
  lines.push(`client alias: ${report.status.client}`);
  lines.push(`server alias: ${report.status.server}`);
  lines.push(
    `baseUrl: ${report.status.baseUrlPresent ? "present" : "absent"} (${report.status.baseUrlRequired ? "required" : "not required"})`,
  );
  lines.push(
    `generatedDir supported: ${report.status.generatedDirSupported ? "yes" : "no"}`,
  );
  lines.push(
    `manifest.output supported: ${report.status.manifestOutputSupported ? "yes" : "no"}`,
  );

  const problems: string[] = [];
  if (report.configDiagnostics.length > 0) {
    problems.push(
      ...report.configDiagnostics.map((diagnostic) =>
        diagnostic.details
          ? `${diagnostic.code} ${diagnostic.message} (${diagnostic.details})`
          : `${diagnostic.code} ${diagnostic.message}`,
      ),
    );
  }
  if (report.tsconfigDiagnostics.length > 0) {
    problems.push(
      ...report.tsconfigDiagnostics.map((diagnostic) =>
        diagnostic.details
          ? `${diagnostic.code} ${diagnostic.message} (${diagnostic.details})`
          : `${diagnostic.code} ${diagnostic.message}`,
      ),
    );
  }
  if (report.status.client !== "correct") {
    problems.push(
      `missing or incorrect ${ARUNA_ACTION_PATHS.client} -> ${report.expectedPaths.client.join(", ")}`,
    );
  }
  if (report.status.server !== "correct") {
    problems.push(
      `missing or incorrect ${ARUNA_ACTION_PATHS.server} -> ${report.expectedPaths.server.join(", ")}`,
    );
  }

  if (problems.length > 0) {
    lines.push("");
    lines.push("problems:");
    for (const problem of problems) {
      lines.push(`  - ${problem}`);
    }
    if (!report.fixApplied) {
      lines.push("");
      lines.push("run `aruna doctor --fix` to write the required tsconfig aliases");
    }
  } else if (report.fixApplied) {
    lines.push("");
    lines.push("tsconfig aliases updated");
  } else {
    lines.push("");
    lines.push("tsconfig aliases are configured correctly");
  }

  return lines.join("\n");
}

export function inspectDoctorProject(options: DoctorOptions): DoctorReport {
  const loaded = loadProjectConfig(options.projectRoot, options.configPath);
  const generatedDir = (loaded.config.generatedDir ??
    DEFAULT_ARUNA_CONFIG.generatedDir ??
    "src/.aruna") as string;
  const generatedDirResolved = path.resolve(options.projectRoot, generatedDir);
  const tsconfigPath = loaded.tsconfigPath;
  const expectedPaths = resolveArunaActionPaths(tsconfigPath, generatedDir);
  const tsconfigResult = readTsconfig(tsconfigPath);
  const tsconfigDiagnostics = loaded.diagnostics.filter((diagnostic) =>
    diagnostic.code === "aruna::102" || diagnostic.code === "aruna::103",
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
        generatedDirSupported: configSupportsGeneratedDir(loaded.config),
        manifestOutputSupported: configSupportsManifestOutput(loaded.config),
      },
      fixApplied: false,
    };
  }

  const inspection = inspectArunaActionPaths(tsconfigResult.value, expectedPaths);
  return {
    projectRoot: options.projectRoot,
    configPath: loaded.configPath,
    tsconfigPath,
    generatedDir,
    generatedDirResolved,
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
      generatedDirSupported: configSupportsGeneratedDir(loaded.config),
      manifestOutputSupported: configSupportsManifestOutput(loaded.config),
    },
    fixApplied: false,
  };
}

export function fixDoctorProject(options: DoctorOptions): DoctorReport {
  const report = inspectDoctorProject(options);
  if (report.configDiagnostics.length > 0 || report.tsconfigDiagnostics.length > 0) {
    return report;
  }

  const tsconfigResult = readTsconfig(report.tsconfigPath);
  if (!tsconfigResult.value) {
    return report;
  }

  const updated = updateArunaActionPaths(tsconfigResult.value, report.expectedPaths, {
    requireBaseUrl: true,
  });
  if (!updated.changed) {
    return {
      ...report,
      fixApplied: true,
    };
  }

  fs.writeFileSync(report.tsconfigPath, updated.contents, "utf8");
  return {
    ...report,
    fixApplied: true,
    status: {
      ...report.status,
      client: "correct",
      server: "correct",
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
