import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatTsconfigSetup,
  planTsconfigSetup,
  setUpTsconfig,
  type TsconfigSetup,
} from "../src/cli/tsconfig-setup.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aruna-tsconfig-setup-"));
  roots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(root, relativePath), contents, "utf8");
  }
  return root;
}

function readable(setup: TsconfigSetup): Exclude<TsconfigSetup, { status: "unreadable" }> {
  if (setup.status === "unreadable") {
    throw new Error(`unexpected unreadable tsconfig: ${setup.error}`);
  }
  return setup;
}

type Tsconfig = {
  extends?: unknown;
  include?: string[];
  compilerOptions: Record<string, unknown> & { paths: Record<string, string[]> };
};

function contentsOf(setup: TsconfigSetup): Tsconfig {
  return parse(readable(setup).contents, [], { allowTrailingComma: true }) as Tsconfig;
}

const ALL_ALIASES = [
  "$aruna/actions/client",
  "$aruna/actions/server",
  "$aruna/signals",
  "aruna/client",
  "aruna/server",
  "aruna/roblox",
  "aruna/schema",
  "aruna/testing",
];

describe("planTsconfigSetup", () => {
  it("creates a complete tsconfig.json, and the result needs nothing more", () => {
    const root = project({});
    const setup = setUpTsconfig({ projectRoot: root, generatedDir: "src/.aruna" });

    expect(setup.status).toBe("create");
    const tsconfig = contentsOf(setup);
    expect(Object.keys(tsconfig.compilerOptions.paths)).toEqual(ALL_ALIASES);
    expect(tsconfig.compilerOptions["baseUrl"]).toBeUndefined();
    expect(planTsconfigSetup({ projectRoot: root, generatedDir: "src/.aruna" }).status).toBe("ok");
  });

  it("edits only what it must: comments, tabs, and the project's spellings survive", () => {
    const original = [
      "{",
      '\t"compilerOptions": {',
      "\t\t// required",
      '\t\t"module": "commonjs",',
      '\t\t"moduleResolution": "Node",',
      '\t\t"noLib": true,',
      '\t\t"strict": true,',
      '\t\t"target": "ESNext",',
      '\t\t"moduleDetection": "force",',
      '\t\t"allowSyntheticDefaultImports": true,',
      '\t\t"typeRoots": ["node_modules/@rbxts", "node_modules/@lattice-ui"],',
      '\t\t"rootDir": "src",',
      '\t\t"outDir": "out",',
      '\t\t"baseUrl": "src",',
      '\t\t"paths": {',
      '\t\t\t"$aruna/actions/client": ["aruna/shared/actions.client.generated.ts"],',
      '\t\t\t"aruna/server-app": ["aruna/shared/runtime/server-app.ts"]',
      "\t\t}",
      "\t},",
      '\t"include": ["src/**/*"],',
      '\t"exclude": ["aruna.config.ts", "out", "node_modules"]',
      "}",
      "",
    ].join("\n");
    const root = project({ "tsconfig.json": original });

    const setup = readable(planTsconfigSetup({ projectRoot: root, generatedDir: "src/aruna" }));

    expect(setup.status).toBe("update");
    expect(setup.contents).toBe(
      [
        "{",
        '\t"compilerOptions": {',
        "\t\t// required",
        '\t\t"module": "commonjs",',
        '\t\t"moduleResolution": "Node",',
        '\t\t"noLib": true,',
        '\t\t"strict": true,',
        '\t\t"target": "ESNext",',
        '\t\t"moduleDetection": "force",',
        '\t\t"allowSyntheticDefaultImports": true,',
        '\t\t"typeRoots": ["node_modules/@rbxts", "node_modules/@lattice-ui"],',
        '\t\t"rootDir": "src",',
        '\t\t"outDir": "out",',
        '\t\t"baseUrl": "src",',
        '\t\t"paths": {',
        // Already reaching the generated file through the project's baseUrl.
        '\t\t\t"$aruna/actions/client": ["aruna/shared/actions.client.generated.ts"],',
        '\t\t\t"$aruna/actions/server": ["./aruna/server/actions.server.generated.ts"],',
        '\t\t\t"$aruna/signals": ["./aruna/shared/signals.generated.ts"],',
        '\t\t\t"aruna/client": ["./aruna/shared/runtime/client.ts"],',
        '\t\t\t"aruna/server": ["./aruna/shared/runtime/server.ts"],',
        '\t\t\t"aruna/roblox": ["./aruna/shared/runtime/roblox.ts"],',
        '\t\t\t"aruna/schema": ["./aruna/shared/runtime/schema.ts"],',
        '\t\t\t"aruna/testing": ["./aruna/shared/runtime/testing.ts"]',
        "\t\t},",
        '\t\t"skipLibCheck": true,',
        '\t\t"jsx": "preserve",',
        '\t\t"downlevelIteration": true,',
        '\t\t"esModuleInterop": true,',
        '\t\t"forceConsistentCasingInFileNames": true,',
        '\t\t"resolveJsonModule": true,',
        '\t\t"noUncheckedIndexedAccess": true',
        "\t},",
        '\t"include": ["src/**/*"],',
        '\t"exclude": ["aruna.config.ts", "out", "node_modules"]',
        "}",
        "",
      ].join("\n"),
    );
    expect(setup.mandatory.map((change) => change.change)).toEqual([
      "updated to add $aruna/actions/server, $aruna/signals, aruna/client, aruna/server, aruna/roblox, aruna/schema, aruna/testing",
      "updated to drop aruna/server-app",
    ]);
    // A classic `node_modules/@rbxts` type root loads its packages by itself, so
    // no `types` list is suggested.
    expect(setup.suggested.map((change) => change.key)).not.toContain("types");
  });

  it("forces what roblox-ts requires and suggests only what the project left unset", () => {
    const root = project({
      "tsconfig.json": `{\n  "compilerOptions": {\n    "module": "ESNext",\n    "skipLibCheck": false,\n    "jsx": "react"\n  }\n}\n`,
    });

    const setup = readable(planTsconfigSetup({ projectRoot: root, generatedDir: "src/.aruna" }));
    const tsconfig = contentsOf(setup);

    expect(setup.mandatory).toContainEqual({
      key: "module",
      change: 'set to "CommonJS"',
      reason: "required by roblox-ts",
    });
    expect(tsconfig.compilerOptions["module"]).toBe("CommonJS");
    expect(tsconfig.compilerOptions["skipLibCheck"]).toBe(false);
    expect(tsconfig.compilerOptions["jsx"]).toBe("react");
    const suggested = setup.suggested.map((change) => change.key);
    expect(suggested).not.toContain("skipLibCheck");
    expect(suggested).not.toContain("jsx");
    expect(suggested).toContain("noUncheckedIndexedAccess");
  });

  it("counts what a base config supplies through extends", () => {
    const root = project({
      "config/tsconfig.base.json": JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "CommonJS",
          moduleResolution: "Node",
          moduleDetection: "force",
          noLib: true,
          strict: true,
          allowSyntheticDefaultImports: true,
          typeRoots: ["../node_modules", "../node_modules/@rbxts"],
          types: ["@rbxts/types"],
          skipLibCheck: true,
          rootDir: "../src",
          outDir: "../out",
          jsx: "react",
          downlevelIteration: true,
          esModuleInterop: true,
          forceConsistentCasingInFileNames: true,
          resolveJsonModule: true,
          noUncheckedIndexedAccess: true,
        },
        include: ["../src/**/*.ts", "../src/.aruna/**/*.ts"],
        exclude: ["../out"],
      }),
      "tsconfig.json": `{ "extends": "./config/tsconfig.base.json" }\n`,
    });

    const setup = readable(planTsconfigSetup({ projectRoot: root, generatedDir: "src/.aruna" }));

    expect(setup.mandatory.map((change) => change.key)).toEqual(["paths"]);
    expect(setup.suggested).toEqual([]);
  });

  it("adds node_modules/@rbxts to the project's typeRoots", () => {
    const root = project({
      "tsconfig.json": `{\n  "compilerOptions": {\n    "typeRoots": ["./types"]\n  }\n}\n`,
    });

    const setup = readable(planTsconfigSetup({ projectRoot: root, generatedDir: "src/.aruna" }));

    expect(setup.contents).toContain('"typeRoots": ["./types", "./node_modules/@rbxts"]');
    expect(setup.suggested.map((change) => change.key)).not.toContain("types");
  });

  it("copies inherited paths and include in when it must extend them, rebased", () => {
    const root = project({
      "base/tsconfig.base.json": JSON.stringify({
        compilerOptions: { paths: { "@lib/*": ["./lib/*"] } },
        include: ["src/**/*.ts"],
      }),
      "tsconfig.json": `{ "extends": "./base/tsconfig.base.json" }\n`,
    });

    const tsconfig = contentsOf(
      planTsconfigSetup({ projectRoot: root, generatedDir: "src/.aruna" }),
    );

    // TypeScript replaces an inherited paths block (and include) wholesale.
    expect(tsconfig.compilerOptions.paths["@lib/*"]).toEqual(["./base/lib/*"]);
    expect(tsconfig.compilerOptions.paths["$aruna/signals"]).toEqual([
      "./src/.aruna/shared/signals.generated.ts",
    ]);
    expect(tsconfig.include).toEqual(["base/src/**/*.ts", "src/.aruna/**/*.ts"]);
  });

  it("names a dot-folder generated dir in include, which wildcards never reach", () => {
    const root = project({ "tsconfig.json": `{\n  "include": ["src/**/*"]\n}\n` });

    const setup = readable(planTsconfigSetup({ projectRoot: root, generatedDir: "src/.aruna" }));

    expect(setup.contents).toContain('"include": ["src/**/*", "src/.aruna/**/*.ts"]');
    expect(setup.mandatory).toContainEqual(
      expect.objectContaining({ key: "include", change: "updated to add src/.aruna/**/*.ts" }),
    );
  });

  it("drops a reference to the retired generated fragment", () => {
    const single = project({
      "tsconfig.json": `{\n  "extends": "./src/.aruna/tsconfig.aruna.json",\n  "compilerOptions": {}\n}\n`,
    });
    const singleSetup = readable(
      planTsconfigSetup({ projectRoot: single, generatedDir: "src/.aruna" }),
    );
    expect(singleSetup.retiredFragment).toBe("src/.aruna/tsconfig.aruna.json");
    expect(contentsOf(singleSetup).extends).toBeUndefined();

    const list = project({
      "base.json": "{}\n",
      "tsconfig.json": `{\n  "extends": ["./base.json", "./src/.aruna/tsconfig.aruna.json"]\n}\n`,
    });
    const listSetup = readable(
      planTsconfigSetup({ projectRoot: list, generatedDir: "src/.aruna" }),
    );
    expect(contentsOf(listSetup).extends).toBe("./base.json");
  });

  it("keeps a baseUrl the project chose and writes the aliases relative to it", () => {
    const root = project({
      "tsconfig.json": `{\n  "compilerOptions": {\n    "baseUrl": "src"\n  }\n}\n`,
    });

    const tsconfig = contentsOf(
      planTsconfigSetup({ projectRoot: root, generatedDir: "src/.aruna" }),
    );

    expect(tsconfig.compilerOptions["baseUrl"]).toBe("src");
    expect(tsconfig.compilerOptions.paths["$aruna/actions/client"]).toEqual([
      "./.aruna/shared/actions.client.generated.ts",
    ]);
  });

  it("refuses a tsconfig it cannot edit safely", () => {
    const broken = project({ "tsconfig.json": `{\n  "compilerOptions": \n}\n` });
    const brokenSetup = planTsconfigSetup({ projectRoot: broken, generatedDir: "src/.aruna" });
    expect(brokenSetup.status).toBe("unreadable");
    expect(brokenSetup.status === "unreadable" && brokenSetup.error).toBe(
      "invalid JSON (ValueExpected on line 3)",
    );

    const misshapen = project({ "tsconfig.json": `{ "compilerOptions": [] }\n` });
    const misshapenSetup = planTsconfigSetup({
      projectRoot: misshapen,
      generatedDir: "src/.aruna",
    });
    expect(misshapenSetup.status === "unreadable" && misshapenSetup.error).toBe(
      "compilerOptions must be an object",
    );
  });
});

describe("formatTsconfigSetup", () => {
  it("reports what was changed, or what would be", () => {
    const root = project({
      "tsconfig.json": `{\n  "compilerOptions": {\n    "module": "ESNext"\n  }\n}\n`,
    });
    const setup = planTsconfigSetup({ projectRoot: root, generatedDir: "src/.aruna" });

    const applied = formatTsconfigSetup(setup, "applied");
    expect(applied[0]).toBe("reconfigured tsconfig.json for roblox-ts and Aruna");
    expect(applied).toContain("  mandatory changes:");
    expect(applied).toContain('    - module was set to "CommonJS" (required by roblox-ts)');
    expect(applied).toContain("  suggested values (yours to change):");
    expect(applied).toContain("    - skipLibCheck was set to true");

    const pending = formatTsconfigSetup(setup, "pending");
    expect(pending[0]).toBe("tsconfig.json needs reconfiguring for roblox-ts and Aruna");
    expect(pending).toContain('    - module would be set to "CommonJS" (required by roblox-ts)');
  });

  it("says nothing for a tsconfig that already has everything", () => {
    const root = project({});
    setUpTsconfig({ projectRoot: root, generatedDir: "src/.aruna" });
    expect(
      formatTsconfigSetup(
        planTsconfigSetup({ projectRoot: root, generatedDir: "src/.aruna" }),
        "applied",
      ),
    ).toEqual([]);
  });
});
