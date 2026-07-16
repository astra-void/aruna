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
  inspectToolchain,
} from "../src/cli/doctor.js";
import {
  resolveArunaActionPaths,
  resolveArunaRuntimePaths,
  resolveArunaSignalPaths,
} from "../src/cli/tsconfig-paths.js";
import { stripJsonComments } from "./support/jsonc.ts";

function readFragment(root: string, generatedDir = "src/.aruna"): {
  compilerOptions: { baseUrl: string; paths: Record<string, string[]> };
} {
  const raw = fs.readFileSync(path.join(root, generatedDir, "tsconfig.aruna.json"), "utf8");
  return JSON.parse(stripJsonComments(raw));
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

  it("migrates a tsconfig without aliases to the generated fragment with fix", () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{\n  "compilerOptions": {\n    "module": "ESNext"\n  }\n}\n`,
      "aruna.config.ts": minimalConfig(),
    });

    const report = fixDoctorProject({ projectRoot: root, fix: true });
    const tsconfig = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));

    expect(report.fixApplied).toBe(true);
    expect(report.aliasMode).toBe("extends");
    expect(report.fragment.status).toBe("correct");
    expect(tsconfig.extends).toBe("./src/.aruna/tsconfig.aruna.json");
    expect(tsconfig.compilerOptions.paths).toBeUndefined();

    // Every aruna alias lives in the generated fragment now — including the
    // signal registry virtual module, so `import { signals } from
    // "$aruna/signals"` resolves under tsc/rbxtsc.
    const fragment = readFragment(root);
    expect(fragment.compilerOptions.paths["$aruna/actions/client"]).toEqual([
      "src/.aruna/shared/actions.client.generated.ts",
    ]);
    expect(fragment.compilerOptions.paths["$aruna/actions/server"]).toEqual([
      "src/.aruna/server/actions.server.generated.ts",
    ]);
    expect(fragment.compilerOptions.paths["$aruna/signals"]).toEqual([
      "src/.aruna/shared/signals.generated.ts",
    ]);
    expect(doctorExitCode(report)).toBe(0);
  });

  it("preserves existing paths and stays inline-managed alongside them", () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{\n  "compilerOptions": {\n    "module": "ESNext",\n    "paths": {\n      "@shared/*": ["src/shared/*"]\n    }\n  }\n}\n`,
      "aruna.config.ts": minimalConfig(),
    });

    fixDoctorProject({ projectRoot: root, fix: true });
    const tsconfig = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));

    expect(tsconfig.compilerOptions.paths["@shared/*"]).toEqual(["src/shared/*"]);
    // User-owned aliases would shadow the fragment under `extends`, so the fix
    // keeps the aruna aliases inline next to them instead of migrating.
    expect(tsconfig.extends).toBeUndefined();
    expect(tsconfig.compilerOptions.paths["$aruna/actions/client"]).toEqual([
      "src/.aruna/shared/actions.client.generated.ts",
    ]);
  });

  it("migrates a tsconfig whose paths block only holds stale Aruna aliases", () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{\n  "compilerOptions": {\n    "paths": {\n      "$aruna/actions/client": ["wrong.ts"],\n      "$aruna/actions/server": ["also-wrong.ts"]\n    }\n  }\n}\n`,
      "aruna.config.ts": minimalConfig(),
    });

    fixDoctorProject({ projectRoot: root, fix: true });
    const tsconfig = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));

    expect(tsconfig.compilerOptions.paths).toBeUndefined();
    expect(tsconfig.extends).toBe("./src/.aruna/tsconfig.aruna.json");
    const fragment = readFragment(root);
    expect(fragment.compilerOptions.paths["$aruna/actions/client"]).toEqual([
      "src/.aruna/shared/actions.client.generated.ts",
    ]);
    expect(fragment.compilerOptions.paths["$aruna/actions/server"]).toEqual([
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
    expect(tsconfig.extends).toBe("./src/generated/tsconfig.aruna.json");
    const fragment = readFragment(root, "src/generated");
    expect(fragment.compilerOptions.paths["$aruna/actions/client"]).toEqual([
      "src/generated/shared/actions.client.generated.ts",
    ]);
    expect(fragment.compilerOptions.paths["$aruna/actions/server"]).toEqual([
      "src/generated/server/actions.server.generated.ts",
    ]);
  });

  it("does not inject baseUrl when migrating to the fragment", () => {
    const root = makeTempRoot();
    writeProject(root, {
      "tsconfig.json": `{\n  "compilerOptions": {\n    "module": "ESNext"\n  }\n}\n`,
      "aruna.config.ts": minimalConfig(),
    });

    fixDoctorProject({ projectRoot: root, fix: true });
    const tsconfig = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));

    // The fragment carries its own baseUrl; the project tsconfig stays clean.
    expect(tsconfig.compilerOptions.baseUrl).toBeUndefined();
    expect(tsconfig.extends).toBe("./src/.aruna/tsconfig.aruna.json");
    expect(readFragment(root).compilerOptions.baseUrl).toBe("../..");
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

  // After `doctor --fix`, every Aruna alias must equal the path the current
  // split-tree layout actually emits — the stale flat-layout tsconfig migrates
  // to the generated fragment, which is verified 1:1 against the resolvers
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

    // The stale inline aliases are gone entirely — replaced by the fragment.
    expect(tsconfig.compilerOptions.paths).toBeUndefined();
    expect(tsconfig.extends).toBe("./src/.aruna/tsconfig.aruna.json");

    const aliases = readFragment(root).compilerOptions.paths;
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

  it("keeps a fragment-shadowing paths block aligned inline with fix", () => {
    const root = makeTempRoot();
    writeProject(root, {
      // extends already references the fragment, but a user paths block
      // shadows it wholesale (TS extends semantics) — aruna::112 territory.
      "tsconfig.json": `{\n  "extends": "./src/.aruna/tsconfig.aruna.json",\n  "compilerOptions": {\n    "paths": {\n      "@shared/*": ["src/shared/*"]\n    }\n  }\n}\n`,
      "aruna.config.ts": minimalConfig(),
    });

    const report = fixDoctorProject({ projectRoot: root, fix: true, emitRuntime: true });
    const tsconfig = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));

    expect(report.pathsShadowFragment).toBe(true);
    // The shadowing block keeps the user alias and gains the aruna aliases so
    // resolution still works despite the shadow.
    expect(tsconfig.compilerOptions.paths["@shared/*"]).toEqual(["src/shared/*"]);
    expect(tsconfig.compilerOptions.paths["$aruna/actions/client"]).toEqual([
      "src/.aruna/shared/actions.client.generated.ts",
    ]);
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
    expect(tsconfig.extends).toBe("./src/.aruna/tsconfig.aruna.json");
    expect(tsconfig.compilerOptions.paths).toBeUndefined();
    const fragment = readFragment(root);
    expect(fragment.compilerOptions.paths["$aruna/actions/client"]).toEqual([
      "src/.aruna/shared/actions.client.generated.ts",
    ]);
    expect(fragment.compilerOptions.paths["aruna/client"]).toEqual([
      "src/.aruna/shared/runtime/client.ts",
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
