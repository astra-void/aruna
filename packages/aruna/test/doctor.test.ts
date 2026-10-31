import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import {
  doctorExitCode,
  formatDoctorReport,
  fixDoctorProject,
  inspectDoctorProject,
  inspectToolchain,
} from "../src/cli/doctor.js";
import { arunaAliasTargets } from "../src/cli/tsconfig-paths.js";
import { partitionedRojoProject } from "../src/cli/rojo-layout.js";

type Tsconfig = {
  extends?: unknown;
  compilerOptions: Record<string, unknown> & { paths?: Record<string, string[]> };
};

function readTsconfig(root: string): Tsconfig {
  return parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"), [], {
    allowTrailingComma: true,
  }) as Tsconfig;
}

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

describe("doctor", () => {
  it("mentions generatedDir and the Aruna aliases in the built CLI", () => {
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

  it("reports what tsconfig.json still needs, without writing it", () => {
    const root = makeTempRoot();
    const original = `{\n  "compilerOptions": {\n    "module": "ESNext"\n  }\n}\n`;
    writeProject(root, { "tsconfig.json": original, "aruna.config.ts": minimalConfig() });

    const report = inspectDoctorProject({ projectRoot: root });

    expect(report.tsconfig.status).toBe("needs-update");
    expect(report.tsconfig.mandatory).toContainEqual({
      key: "module",
      change: 'set to "CommonJS"',
      reason: "required by roblox-ts",
    });
    expect(report.aliases.every((alias) => alias.status === "missing")).toBe(true);
    const rendered = formatDoctorReport(report);
    expect(rendered).toContain("generated dir: src/.aruna");
    expect(rendered).toContain('module would be set to "CommonJS" (required by roblox-ts)');
    expect(rendered).toContain(
      "$aruna/actions/client -> ./src/.aruna/shared/actions.client.generated.ts  missing",
    );
    expect(doctorExitCode(report)).toBe(1);
    expect(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8")).toBe(original);
  });

  it("writes the Aruna aliases into tsconfig.json itself, with no baseUrl or extends", () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{\n  "compilerOptions": {\n    "module": "ESNext"\n  }\n}\n`,
      "aruna.config.ts": minimalConfig(),
    });

    const report = fixDoctorProject({ projectRoot: root, fix: true });
    const tsconfig = readTsconfig(root);

    expect(report.fix?.status).toBe("update");
    expect(report.tsconfig.status).toBe("ok");
    expect(tsconfig.extends).toBeUndefined();
    expect(tsconfig.compilerOptions.baseUrl).toBeUndefined();
    expect(tsconfig.compilerOptions.module).toBe("CommonJS");
    // Every alias, the signal registry and the vendored runtime included, as a
    // "./" path from tsconfig.json — TypeScript requires that without a baseUrl.
    expect(tsconfig.compilerOptions.paths?.["$aruna/actions/client"]).toEqual([
      "./src/.aruna/shared/actions.client.generated.ts",
    ]);
    expect(tsconfig.compilerOptions.paths?.["$aruna/actions/server"]).toEqual([
      "./src/.aruna/server/actions.server.generated.ts",
    ]);
    expect(tsconfig.compilerOptions.paths?.["$aruna/signals"]).toEqual([
      "./src/.aruna/shared/signals.generated.ts",
    ]);
    expect(tsconfig.compilerOptions.paths?.["aruna/server"]).toEqual([
      "./src/.aruna/shared/runtime/server.ts",
    ]);
    expect(doctorExitCode(report)).toBe(0);
  });

  it("keeps the project's own path aliases next to Aruna's", () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{\n  "compilerOptions": {\n    "paths": {\n      "@/*": ["./src/*"]\n    }\n  }\n}\n`,
      "aruna.config.ts": minimalConfig(),
    });

    fixDoctorProject({ projectRoot: root, fix: true });
    const tsconfig = readTsconfig(root);

    expect(tsconfig.compilerOptions.paths?.["@/*"]).toEqual(["./src/*"]);
    expect(tsconfig.compilerOptions.paths?.["$aruna/actions/client"]).toEqual([
      "./src/.aruna/shared/actions.client.generated.ts",
    ]);
  });

  it("realigns stale Aruna aliases in place", () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{\n  "compilerOptions": {\n    "paths": {\n      "$aruna/actions/client": ["./wrong.ts"],\n      "$aruna/actions/server": ["./also-wrong.ts"]\n    }\n  }\n}\n`,
      "aruna.config.ts": minimalConfig(),
    });

    const before = inspectDoctorProject({ projectRoot: root });
    expect(before.aliases.find((alias) => alias.alias === "$aruna/actions/client")).toEqual({
      alias: "$aruna/actions/client",
      expected: "./src/.aruna/shared/actions.client.generated.ts",
      actual: "./wrong.ts",
      status: "stale",
    });

    fixDoctorProject({ projectRoot: root, fix: true });
    const tsconfig = readTsconfig(root);

    expect(tsconfig.compilerOptions.paths?.["$aruna/actions/client"]).toEqual([
      "./src/.aruna/shared/actions.client.generated.ts",
    ]);
    expect(tsconfig.compilerOptions.paths?.["$aruna/actions/server"]).toEqual([
      "./src/.aruna/server/actions.server.generated.ts",
    ]);
  });

  it("keeps the project's own baseUrl and maps the aliases relative to it", () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{\n  "compilerOptions": {\n    "baseUrl": "src",\n    "module": "ESNext",\n    "strict": true,\n    "skipLibCheck": false\n  }\n}\n`,
      "aruna.config.ts": minimalConfig(),
    });

    fixDoctorProject({ projectRoot: root, fix: true });
    const tsconfig = readTsconfig(root);

    expect(tsconfig.compilerOptions.baseUrl).toBe("src");
    expect(tsconfig.compilerOptions.strict).toBe(true);
    // A suggested value the project already set is the project's.
    expect(tsconfig.compilerOptions.skipLibCheck).toBe(false);
    expect(tsconfig.compilerOptions.paths?.["$aruna/actions/client"]).toEqual([
      "./.aruna/shared/actions.client.generated.ts",
    ]);
  });

  it("creates a missing tsconfig.json with --fix", () => {
    const root = makeTempRoot();
    writeProject(root, { "aruna.config.ts": minimalConfig() });

    const before = inspectDoctorProject({ projectRoot: root });
    expect(before.tsconfigDiagnostics[0]?.code).toBe("aruna::102");
    expect(before.tsconfig.status).toBe("missing");
    expect(before.fixable).toBe(true);
    expect(formatDoctorReport(before)).toContain("tsconfig.json is missing");

    const report = fixDoctorProject({ projectRoot: root, fix: true });
    expect(report.fix?.status).toBe("create");
    expect(report.tsconfigDiagnostics).toEqual([]);
    expect(formatDoctorReport(report)).toContain("created tsconfig.json");
    expect(doctorExitCode(report)).toBe(0);
  });

  it("reads a commented tsconfig with trailing commas", () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{\n  // the project's settings\n  "compilerOptions": {\n    "module": "ESNext",\n  },\n}\n`,
      "aruna.config.ts": minimalConfig(),
    });

    const report = fixDoctorProject({ projectRoot: root, fix: true });
    expect(report.tsconfig.status).toBe("ok");
    const contents = fs.readFileSync(path.join(root, "tsconfig.json"), "utf8");
    expect(contents).toContain("// the project's settings");
  });

  it("leaves a tsconfig it cannot parse alone, with a clear message", () => {
    const root = makeTempRoot();
    const broken = `{\n  "compilerOptions": \n}\n`;
    writeProject(root, { "tsconfig.json": broken, "aruna.config.ts": minimalConfig() });

    const report = fixDoctorProject({ projectRoot: root, fix: true });

    expect(report.tsconfigDiagnostics[0]?.code).toBe("aruna::103");
    expect(report.tsconfig.status).toBe("unreadable");
    expect(report.fixable).toBe(false);
    expect(formatDoctorReport(report)).toContain("unreadable: invalid JSON");
    expect(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8")).toBe(broken);
  });

  it("respects custom generatedDir", () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{}\n`,
      "aruna.config.ts": minimalConfig("src/generated"),
    });

    const report = fixDoctorProject({ projectRoot: root, fix: true });
    const tsconfig = readTsconfig(root);

    expect(report.generatedDir).toBe("src/generated");
    expect(report.manifestOutput).toBe("src/generated/manifest.json");
    expect(tsconfig.compilerOptions.paths?.["$aruna/actions/client"]).toEqual([
      "./src/generated/shared/actions.client.generated.ts",
    ]);
    expect(tsconfig.compilerOptions.paths?.["$aruna/actions/server"]).toEqual([
      "./src/generated/server/actions.server.generated.ts",
    ]);
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
    expect(result.stdout).toContain("reconfigured tsconfig.json");
    expect(result.stderr).toBe("");
  });

  // After `doctor --fix`, every Aruna alias must equal the path the current
  // split-tree layout actually emits — verified 1:1 against the targets that
  // codegen and vendoring share, so the two can never silently drift apart.
  it("realigns every alias 1:1 with the current emit layout, dropping stale flat paths", () => {
    const root = makeTempRoot();
    writeProject(root, {
      // Start from a fully stale flat-layout tsconfig: action + signal + runtime
      // aliases all point at the pre-split-tree paths.
      "tsconfig.json": `{\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": {\n      "$aruna/actions/client": ["src/.aruna/actions.client.generated.ts"],\n      "$aruna/actions/server": ["src/.aruna/actions.server.generated.ts"],\n      "$aruna/signals": ["src/.aruna/signals.generated.ts"],\n      "aruna/client": ["src/.aruna/runtime/client.ts"],\n      "aruna/server": ["src/.aruna/runtime/server.ts"],\n      "aruna/roblox": ["src/.aruna/runtime/roblox.ts"],\n      "aruna/schema": ["src/.aruna/runtime/schema.ts"],\n      "aruna/server-app": ["src/.aruna/runtime/server-app.ts"]\n    }\n  }\n}\n`,
      "aruna.config.ts": minimalConfig(),
    });

    fixDoctorProject({ projectRoot: root, fix: true });
    const aliases = readTsconfig(root).compilerOptions.paths ?? {};

    for (const [alias, target] of Object.entries(arunaAliasTargets(root, "src/.aruna"))) {
      const expected = `./${path.relative(root, target).split(path.sep).join("/")}`;
      expect(aliases[alias], `alias ${alias}`).toEqual([expected]);
      // And none still point at the flat layout.
      expect(aliases[alias]?.[0]).not.toContain("/.aruna/runtime/");
    }
    // A runtime module the layout no longer has loses its alias.
    expect(aliases["aruna/server-app"]).toBeUndefined();
  });

  it("drops a reference to the retired generated fragment and inlines its settings", () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{\n  "extends": "./src/.aruna/tsconfig.aruna.json",\n  "compilerOptions": {\n    "jsx": "react"\n  }\n}\n`,
      "src/.aruna/tsconfig.aruna.json": `{ "compilerOptions": { "baseUrl": "../..", "noLib": true } }\n`,
      "aruna.config.ts": minimalConfig(),
    });

    const report = fixDoctorProject({ projectRoot: root, fix: true });
    const tsconfig = readTsconfig(root);

    expect(report.fix?.mandatory).toContainEqual(
      expect.objectContaining({
        key: "extends",
        change: "updated to drop ./src/.aruna/tsconfig.aruna.json",
      }),
    );
    expect(tsconfig.extends).toBeUndefined();
    expect(tsconfig.compilerOptions.jsx).toBe("react");
    expect(tsconfig.compilerOptions.noLib).toBe(true);
    expect(tsconfig.compilerOptions.baseUrl).toBeUndefined();
    expect(tsconfig.compilerOptions.paths?.["$aruna/signals"]).toEqual([
      "./src/.aruna/shared/signals.generated.ts",
    ]);
    expect(doctorExitCode(report)).toBe(0);
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
      [builtCliPath, "doctor", "--fix", "--project", "."],
      {
        cwd: root,
        encoding: "utf8",
        // INIT_CWD set elsewhere (as pnpm would) must not derail `--project .`.
        env: { ...process.env, CI: "1", INIT_CWD: root },
      },
    );

    expect(result.status).toBe(0);
    const tsconfig = readTsconfig(root);
    expect(tsconfig.extends).toBeUndefined();
    expect(tsconfig.compilerOptions.paths?.["$aruna/actions/client"]).toEqual([
      "./src/.aruna/shared/actions.client.generated.ts",
    ]);
    expect(tsconfig.compilerOptions.paths?.["aruna/client"]).toEqual([
      "./src/.aruna/shared/runtime/client.ts",
    ]);
  });
});

describe("inspectToolchain", () => {
  function writeInstalled(root: string, name: string, pkg: Record<string, unknown>): void {
    const dir = path.join(root, "node_modules", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  }

  it("reports ok when the installed typescript matches the roblox-ts pin", () => {
    const root = makeTempRoot();
    writeInstalled(root, "roblox-ts", {
      name: "roblox-ts",
      version: "3.0.0",
      dependencies: { typescript: "5.5.3" },
    });
    writeInstalled(root, "typescript", { name: "typescript", version: "5.5.3" });

    expect(inspectToolchain(root)).toEqual({
      robloxTsVersion: "3.0.0",
      typescriptVersion: "5.5.3",
      expectedTypescript: "5.5.3",
      status: "ok",
    });
  });

  it("reports skew when the installed typescript drifts from an exact pin", () => {
    const root = makeTempRoot();
    writeInstalled(root, "roblox-ts", {
      name: "roblox-ts",
      version: "3.0.0",
      dependencies: { typescript: "5.5.3" },
    });
    writeInstalled(root, "typescript", { name: "typescript", version: "5.9.3" });

    expect(inspectToolchain(root).status).toBe("skew");
  });

  it("does not enforce a range pin and tolerates missing installs", () => {
    const root = makeTempRoot();
    writeInstalled(root, "roblox-ts", {
      name: "roblox-ts",
      version: "3.0.0",
      dependencies: { typescript: "^5.5.0" },
    });
    writeInstalled(root, "typescript", { name: "typescript", version: "5.9.3" });
    expect(inspectToolchain(root).status).toBe("ok");

    const bare = makeTempRoot();
    expect(inspectToolchain(bare).status).toBe("unknown");
  });
});

describe("doctor rojo project check", () => {
  const alignedProject = JSON.stringify(partitionedRojoProject());
  // What `rojo init` leaves behind — Luau sources, no compiled out/ tree.
  const unmountedProject = JSON.stringify({
    tree: {
      $className: "DataModel",
      ReplicatedStorage: { Shared: { $path: "src/shared" } },
      ServerScriptService: { Server: { $path: "src/server" } },
    },
  });

  it("passes a project that mounts the partitioned out/ tree", () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{\n  "compilerOptions": { "module": "ESNext" }\n}\n`,
      "aruna.config.ts": minimalConfig(),
      "default.project.json": alignedProject,
    });

    const report = fixDoctorProject({ projectRoot: root, fix: true });
    expect(report.rojoProject.status).toBe("aligned");
    expect(formatDoctorReport(report)).toContain("default.project.json: ok");
    expect(doctorExitCode(report)).toBe(0);
  });

  it("fails a project whose rojo file never mounts out/", () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{\n  "compilerOptions": { "module": "ESNext" }\n}\n`,
      "aruna.config.ts": minimalConfig(),
      "default.project.json": unmountedProject,
    });

    const report = fixDoctorProject({ projectRoot: root, fix: true });
    // tsconfig is healthy; only the Rojo layout is wrong — and that alone is a
    // failure, because nothing else in the pipeline reports it.
    expect(report.tsconfig.status).toBe("ok");
    expect(report.rojoProject.status).toBe("incomplete");
    expect(report.rojoProject.absent).toEqual([
      "out/client",
      "out/server",
      "out/shared",
      "include",
    ]);
    expect(doctorExitCode(report)).toBe(1);

    const rendered = formatDoctorReport(report);
    expect(rendered).toContain("does not mount");
    expect(rendered).toContain("aruna init --force");
    expect(rendered).not.toContain("\ndone");
  });

  it("does not fail on a missing project file — rojo reports that itself", () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{\n  "compilerOptions": { "module": "ESNext" }\n}\n`,
      "aruna.config.ts": minimalConfig(),
    });

    const report = fixDoctorProject({ projectRoot: root, fix: true });
    expect(report.rojoProject.status).toBe("missing");
    expect(doctorExitCode(report)).toBe(0);
  });
});
