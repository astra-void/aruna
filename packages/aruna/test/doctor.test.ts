import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  doctorExitCode,
  formatDoctorReport,
  fixDoctorProject,
  inspectDoctorProject,
} from "../src/cli/doctor.js";
import {
  resolveArunaActionPaths,
  resolveArunaRuntimePaths,
  resolveArunaSignalPaths,
} from "../src/cli/tsconfig-paths.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builtCliPath = path.resolve(packageRoot, "dist/cli.js");
const fixturesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures",
);

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aruna-doctor-"));
}

function writeProject(root: string, files: Record<string, string>): void {
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents, "utf8");
  }
}

function minimalConfig(generatedDir = "src/.aruna"): string {
  return `import { defineConfig } from "aruna";\n\nexport default defineConfig({\n  compiler: {\n    generatedDir: "${generatedDir}",\n    manifest: "${generatedDir}/manifest.json",\n  },\n  conventions: {\n    client: ["src/client.ts"],\n    server: ["src/server.ts"],\n    shared: ["src/shared/**"]\n  },\n});\n`;
}

function tsconfigWithPaths(extra: string = ""): string {
  return `{\n  "compilerOptions": {\n    "module": "ESNext",\n    "moduleResolution": "Bundler",\n    ${extra}\n    "paths": {\n      "$aruna/actions/client": ["src/.aruna/actions.client.generated.ts"],\n      "$aruna/actions/server": ["src/.aruna/actions.server.generated.ts"]\n    },\n    "noEmit": true\n  },\n  "include": ["src/**/*.ts", "aruna.config.ts"]\n}\n`;
}

describe("doctor", () => {
  it("mentions generatedDir and generated action aliases in the built CLI", () => {
    expect(fs.existsSync(builtCliPath)).toBe(true);

    const result = spawnSync(
      process.execPath,
      [
        builtCliPath,
        "doctor",
        "--no-color",
        "--project",
        path.join(fixturesRoot, "config-define-config", "input"),
      ],
      {
        encoding: "utf8",
        env: { ...process.env, CI: "1" },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("generated dir: src/.aruna");
    expect(result.stdout).toContain("$aruna/actions/client");
    expect(result.stdout).toContain("tsconfig aliases");
    expect(result.stderr).toBe("");
  });

  it("reports missing Aruna path aliases", () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{\n  "compilerOptions": {\n    "module": "ESNext"\n  }\n}\n`,
      "aruna.config.ts": minimalConfig(),
    });

    const report = inspectDoctorProject({ projectRoot: root });

    expect(report.status.client).toBe("missing");
    expect(report.status.server).toBe("missing");
    expect(formatDoctorReport(report)).toContain("generated dir: src/.aruna");
    expect(formatDoctorReport(report)).toContain(
      "$aruna/actions/client -> src/.aruna/shared/actions.client.generated.ts  missing",
    );
    expect(doctorExitCode(report)).toBe(1);
  });

  it("adds missing aliases with fix", () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{\n  "compilerOptions": {\n    "module": "ESNext"\n  }\n}\n`,
      "aruna.config.ts": minimalConfig(),
    });

    const report = fixDoctorProject({ projectRoot: root, fix: true });
    const tsconfig = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));

    expect(report.fixApplied).toBe(true);
    expect(report.fixChanges).toContain('added compilerOptions.baseUrl = "."');
    expect(tsconfig.compilerOptions.paths["$aruna/actions/client"]).toEqual([
      "src/.aruna/shared/actions.client.generated.ts",
    ]);
    expect(tsconfig.compilerOptions.paths["$aruna/actions/server"]).toEqual([
      "src/.aruna/server/actions.server.generated.ts",
    ]);
    // The signal registry virtual module is installed alongside the actions so
    // `import { signals } from "$aruna/signals"` resolves under tsc/rbxtsc.
    expect(tsconfig.compilerOptions.paths["$aruna/signals"]).toEqual([
      "src/.aruna/shared/signals.generated.ts",
    ]);
  });

  it("preserves existing paths", () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{\n  "compilerOptions": {\n    "module": "ESNext",\n    "paths": {\n      "@shared/*": ["src/shared/*"]\n    }\n  }\n}\n`,
      "aruna.config.ts": minimalConfig(),
    });

    fixDoctorProject({ projectRoot: root, fix: true });
    const tsconfig = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));

    expect(tsconfig.compilerOptions.paths["@shared/*"]).toEqual(["src/shared/*"]);
  });

  it("updates incorrect Aruna aliases", () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{\n  "compilerOptions": {\n    "paths": {\n      "$aruna/actions/client": ["wrong.ts"],\n      "$aruna/actions/server": ["also-wrong.ts"]\n    }\n  }\n}\n`,
      "aruna.config.ts": minimalConfig(),
    });

    fixDoctorProject({ projectRoot: root, fix: true });
    const tsconfig = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));

    expect(tsconfig.compilerOptions.paths["$aruna/actions/client"]).toEqual([
      "src/.aruna/shared/actions.client.generated.ts",
    ]);
    expect(tsconfig.compilerOptions.paths["$aruna/actions/server"]).toEqual([
      "src/.aruna/server/actions.server.generated.ts",
    ]);
  });

  it("preserves existing baseUrl and unrelated compilerOptions", () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{\n  "compilerOptions": {\n    "baseUrl": "./",\n    "module": "ESNext",\n    "strict": true,\n    "skipLibCheck": true\n  }\n}\n`,
      "aruna.config.ts": minimalConfig(),
    });

    fixDoctorProject({ projectRoot: root, fix: true });
    const tsconfig = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));

    expect(tsconfig.compilerOptions.baseUrl).toBe("./");
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.skipLibCheck).toBe(true);
    expect(tsconfig.compilerOptions.module).toBe("ESNext");
  });

  it("handles missing tsconfig with a clear message", () => {
    const root = makeTempRoot();
    writeProject(root, {
      "aruna.config.ts": minimalConfig(),
    });

    const report = inspectDoctorProject({ projectRoot: root });

    expect(report.tsconfigDiagnostics[0]?.code).toBe("aruna::102");
    expect(formatDoctorReport(report)).toContain("tsconfig");
  });

  it("handles invalid tsconfig JSON with a clear message", () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{\n  "compilerOptions": {\n    "module": "ESNext",\n  }\n}\n`,
      "aruna.config.ts": minimalConfig(),
    });

    const report = inspectDoctorProject({ projectRoot: root });

    expect(report.tsconfigDiagnostics[0]?.code).toBe("aruna::103");
    expect(formatDoctorReport(report)).toContain("invalid JSON");
  });

  it("respects custom generatedDir", () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": tsconfigWithPaths(),
      "aruna.config.ts": minimalConfig("src/generated"),
    });

    const report = fixDoctorProject({ projectRoot: root, fix: true });
    const tsconfig = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));

    expect(report.generatedDir).toBe("src/generated");
    expect(report.manifestOutput).toBe("src/generated/manifest.json");
    expect(tsconfig.compilerOptions.paths["$aruna/actions/client"]).toEqual([
      "src/generated/shared/actions.client.generated.ts",
    ]);
    expect(tsconfig.compilerOptions.paths["$aruna/actions/server"]).toEqual([
      "src/generated/server/actions.server.generated.ts",
    ]);
  });

  it("adds baseUrl when required", () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{\n  "compilerOptions": {\n    "module": "ESNext"\n  }\n}\n`,
      "aruna.config.ts": minimalConfig(),
    });

    fixDoctorProject({ projectRoot: root, fix: true });
    const tsconfig = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));

    expect(tsconfig.compilerOptions.baseUrl).toBe(".");
  });

  it("works through the built CLI", () => {
    expect(fs.existsSync(builtCliPath)).toBe(true);

    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{\n  "compilerOptions": {\n    "module": "ESNext"\n  }\n}\n`,
      "aruna.config.ts": minimalConfig(),
    });

    const result = spawnSync(
      process.execPath,
      [builtCliPath, "doctor", "--fix", "--project", root],
      {
        encoding: "utf8",
        env: { ...process.env, CI: "1" },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("fixed tsconfig.json");
    expect(result.stderr).toBe("");
  });

  // After `doctor --fix --emit-runtime`, every Aruna alias must equal the path the
  // current split-tree layout actually emits — verified 1:1 against the resolvers
  // that codegen/vendoring share, so the two can never silently drift apart.
  it("realigns every alias 1:1 with the current emit layout, dropping stale flat paths", () => {
    const root = makeTempRoot();
    writeProject(root, {
      // Start from a fully stale flat-layout tsconfig: action + signal + runtime
      // aliases all point at the pre-split-tree paths.
      "tsconfig.json": `{\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": {\n      "$aruna/actions/client": ["src/.aruna/actions.client.generated.ts"],\n      "$aruna/actions/server": ["src/.aruna/actions.server.generated.ts"],\n      "$aruna/signals": ["src/.aruna/signals.generated.ts"],\n      "aruna/client": ["src/.aruna/runtime/client.ts"],\n      "aruna/server": ["src/.aruna/runtime/server.ts"],\n      "aruna/roblox": ["src/.aruna/runtime/roblox.ts"],\n      "aruna/schema": ["src/.aruna/runtime/schema.ts"]\n    }\n  }\n}\n`,
      "aruna.config.ts": minimalConfig(),
    });

    fixDoctorProject({ projectRoot: root, fix: true, emitRuntime: true });
    const tsconfig = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));
    const aliases = tsconfig.compilerOptions.paths as Record<string, string[]>;

    const tsconfigPath = path.join(root, "tsconfig.json");
    const expectedAction = resolveArunaActionPaths(tsconfigPath, "src/.aruna");
    const expectedSignal = resolveArunaSignalPaths(tsconfigPath, "src/.aruna");
    const expectedRuntime = resolveArunaRuntimePaths(tsconfigPath, "src/.aruna");
    const expected: Record<string, string[]> = {
      "$aruna/actions/client": expectedAction.client,
      "$aruna/actions/server": expectedAction.server,
      ...expectedSignal,
      ...expectedRuntime,
    };

    for (const [alias, target] of Object.entries(expected)) {
      expect(aliases[alias], `alias ${alias}`).toEqual(target);
      // And none still point at the flat layout.
      expect(aliases[alias]?.[0]).not.toContain("/.aruna/runtime/");
    }
  });

  it("realigns aliases cross-repo via --project (built CLI, INIT_CWD anchored)", () => {
    expect(fs.existsSync(builtCliPath)).toBe(true);
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": {\n      "$aruna/actions/client": ["src/.aruna/actions.client.generated.ts"]\n    }\n  }\n}\n`,
      "aruna.config.ts": minimalConfig(),
    });

    const result = spawnSync(
      process.execPath,
      [builtCliPath, "doctor", "--fix", "--emit-runtime", "--project", "."],
      {
        cwd: root,
        encoding: "utf8",
        // INIT_CWD set elsewhere (as pnpm would) must not derail `--project .`.
        env: { ...process.env, CI: "1", INIT_CWD: root },
      },
    );

    expect(result.status).toBe(0);
    const tsconfig = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));
    expect(tsconfig.compilerOptions.paths["$aruna/actions/client"]).toEqual([
      "src/.aruna/shared/actions.client.generated.ts",
    ]);
    expect(tsconfig.compilerOptions.paths["aruna/client"]).toEqual([
      "src/.aruna/shared/runtime/client.ts",
    ]);
  });
});
