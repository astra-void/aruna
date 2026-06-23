import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConsumerPackageJson,
  buildConsumerTsconfigJson,
  buildConsumerTypecheckTsconfigJson,
  assertGeneratedActionAliases,
  assertGeneratedActionFiles,
  assertGeneratedActionImports,
  assertPublicPackageSubpathFiles,
  findForbiddenPackageConsumptionFragments,
  parseVerifyPackageConsumptionArgs,
  publicArunaSubpathFiles,
  rewriteWorkspaceVersions,
  type PackedPackage,
} from "../../../scripts/verify-package-consumption.ts";

async function makeTempRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeJsonFile(absolutePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeTextFile(absolutePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents, "utf8");
}

function buildFullPublicExports() {
  return {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    },
    "./client": {
      types: "./client.d.ts",
      import: "./client.js",
    },
    "./roblox": {
      types: "./roblox.d.ts",
      import: "./roblox.js",
    },
    "./schema": {
      types: "./schema.d.ts",
      import: "./schema.js",
    },
    "./server": {
      types: "./server.d.ts",
      import: "./server.js",
    },
  };
}

describe("verify-package-consumption args", () => {
  it("accepts the default invocation", () => {
    expect(parseVerifyPackageConsumptionArgs([])).toEqual({ keepTemp: false });
  });

  it("accepts --keep-temp", () => {
    expect(parseVerifyPackageConsumptionArgs(["--keep-temp"])).toEqual({ keepTemp: true });
  });

  it("rejects unknown args", () => {
    expect(() => parseVerifyPackageConsumptionArgs(["--nope"])).toThrow("Unknown argument: --nope");
  });

  it("adds workspace overrides for every packed local package", () => {
    const packedPackages: PackedPackage[] = [
      {
        name: "aruna",
        tarballName: "aruna-0.0.1.tgz",
        tarballPath: "/tmp/aruna-0.0.1.tgz",
      },
      {
        name: "@arunajs/core",
        tarballName: "arunajs-core-0.1.0.tgz",
        tarballPath: "/tmp/arunajs-core-0.1.0.tgz",
      },
      {
        name: "@arunajs/compiler",
        tarballName: "arunajs-compiler-0.1.0.tgz",
        tarballPath: "/tmp/arunajs-compiler-0.1.0.tgz",
      },
      {
        name: "@arunajs/compiler-darwin-arm64",
        tarballName: "arunajs-compiler-darwin-arm64-0.1.0.tgz",
        tarballPath: "/tmp/arunajs-compiler-darwin-arm64-0.1.0.tgz",
      },
    ];

    const consumerPackageJson = buildConsumerPackageJson(packedPackages);

    expect(consumerPackageJson.dependencies).toEqual({
      aruna: "file:./packs/aruna-0.0.1.tgz",
      "@arunajs/core": "file:./packs/arunajs-core-0.1.0.tgz",
      "@arunajs/compiler": "file:./packs/arunajs-compiler-0.1.0.tgz",
    });
  });

  it("uses local tarball file specs for consumer dependencies", () => {
    const packedPackages: PackedPackage[] = [
      {
        name: "aruna",
        tarballName: "aruna-0.0.1.tgz",
        tarballPath: "/tmp/aruna-0.0.1.tgz",
      },
      {
        name: "@arunajs/core",
        tarballName: "arunajs-core-0.1.0.tgz",
        tarballPath: "/tmp/arunajs-core-0.1.0.tgz",
      },
      {
        name: "@arunajs/compiler",
        tarballName: "arunajs-compiler-0.1.0.tgz",
        tarballPath: "/tmp/arunajs-compiler-0.1.0.tgz",
      },
    ];

    const consumerPackageJson = buildConsumerPackageJson(packedPackages);

    expect(consumerPackageJson.dependencies).toEqual({
      aruna: "file:./packs/aruna-0.0.1.tgz",
      "@arunajs/core": "file:./packs/arunajs-core-0.1.0.tgz",
      "@arunajs/compiler": "file:./packs/arunajs-compiler-0.1.0.tgz",
    });
  });

  it("keeps the generated consumer tsconfig path aliases empty before doctor runs", () => {
    const tsconfig = JSON.parse(buildConsumerTsconfigJson("/tmp/tsconfig.base.json")) as {
      compilerOptions?: {
        paths?: Record<string, unknown>;
        baseUrl?: string;
        rootDir?: string;
      };
      include?: string[];
      exclude?: string[];
    };

    expect(tsconfig.compilerOptions?.baseUrl).toBe(".");
    expect(tsconfig.compilerOptions?.rootDir).toBe("src");
    expect(tsconfig.compilerOptions?.paths).toEqual({});
    expect(tsconfig.include).toEqual(["src/**/*.ts", "src/**/*.tsx"]);
    expect(tsconfig.exclude).toEqual(["aruna.config.ts", "dist", "node_modules", "out"]);
    expect(JSON.stringify(tsconfig)).not.toContain("$aruna/actions/client");
    expect(JSON.stringify(tsconfig)).not.toContain("$aruna/actions/server");
  });

  it("lets the generated typecheck config include aruna.config.ts", () => {
    const tsconfig = JSON.parse(buildConsumerTypecheckTsconfigJson()) as {
      extends?: string;
      compilerOptions?: {
        module?: string;
        moduleResolution?: string;
        rootDir?: string;
        noEmit?: boolean;
      };
      include?: string[];
      exclude?: string[];
    };

    expect(tsconfig.extends).toBe("./tsconfig.json");
    expect(tsconfig.compilerOptions).toEqual({
      module: "ESNext",
      moduleResolution: "Bundler",
      rootDir: ".",
      noEmit: true,
    });
    expect(tsconfig.include).toEqual(["src/**/*.ts", "src/**/*.tsx", "aruna.config.ts"]);
    expect(tsconfig.exclude).toEqual(["dist", "node_modules", "out"]);
  });

  it("requires the public package subpath shims that rbxtsc resolves", async () => {
    const root = await makeTempRoot("aruna-package-subpaths-");
    await writeJsonFile(path.join(root, "package.json"), {
      exports: buildFullPublicExports(),
    });

    for (const fileName of publicArunaSubpathFiles) {
      await writeTextFile(path.join(root, fileName), "export {};\n");
    }

    await expect(assertPublicPackageSubpathFiles(root)).resolves.toBeUndefined();
  });

  it("rejects a missing public package subpath shim", async () => {
    const root = await makeTempRoot("aruna-package-subpaths-");
    await writeJsonFile(path.join(root, "package.json"), {
      exports: buildFullPublicExports(),
    });

    for (const fileName of publicArunaSubpathFiles) {
      if (fileName === "client.d.ts") {
        continue;
      }

      await writeTextFile(path.join(root, fileName), "export {};\n");
    }

    await expect(assertPublicPackageSubpathFiles(root)).rejects.toThrow(
      "Missing public package subpath file:",
    );
  });

  it("accepts a doctor-fixed tsconfig alias map", async () => {
    const root = await makeTempRoot("aruna-package-consumption-alias-");
    await writeJsonFile(path.join(root, "tsconfig.json"), {
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "$aruna/actions/client": ["src/.aruna/actions.client.generated.ts"],
          "$aruna/actions/server": ["src/.aruna/actions.server.generated.ts"],
        },
      },
    });

    await expect(assertGeneratedActionAliases(root)).resolves.toBeUndefined();
  });

  it("rejects a missing client generated action alias", async () => {
    const root = await makeTempRoot("aruna-package-consumption-alias-");
    await writeJsonFile(path.join(root, "tsconfig.json"), {
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "$aruna/actions/server": ["src/.aruna/actions.server.generated.ts"],
        },
      },
    });

    await expect(assertGeneratedActionAliases(root)).rejects.toThrow(
      "aruna doctor --fix did not install generated action aliases in tsconfig.json.",
    );
  });

  it("rejects a missing server generated action alias", async () => {
    const root = await makeTempRoot("aruna-package-consumption-alias-");
    await writeJsonFile(path.join(root, "tsconfig.json"), {
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "$aruna/actions/client": ["src/.aruna/actions.client.generated.ts"],
        },
      },
    });

    await expect(assertGeneratedActionAliases(root)).rejects.toThrow(
      "aruna doctor --fix did not install generated action aliases in tsconfig.json.",
    );
  });

  it("accepts the expected generated action files", async () => {
    const root = await makeTempRoot("aruna-package-consumption-files-");
    await writeTextFile(
      path.join(root, "src/.aruna/actions.client.generated.ts"),
      "export const purchaseItem = () => Promise.resolve({ ok: true });\n",
    );
    await writeTextFile(
      path.join(root, "src/.aruna/actions.server.generated.ts"),
      "export const actions = { purchaseItem: () => undefined };\n",
    );
    await writeTextFile(path.join(root, "src/.aruna/manifest.json"), "{\n  \"actions\": []\n}\n");

    await expect(assertGeneratedActionFiles(root)).resolves.toBeUndefined();
  });

  it("rejects a missing client generated action file", async () => {
    const root = await makeTempRoot("aruna-package-consumption-files-");
    await writeTextFile(
      path.join(root, "src/.aruna/actions.server.generated.ts"),
      "export const actions = { purchaseItem: () => undefined };\n",
    );
    await writeTextFile(path.join(root, "src/.aruna/manifest.json"), "{\n  \"actions\": []\n}\n");

    await expect(assertGeneratedActionFiles(root)).rejects.toThrow(
      "aruna build did not write generated action files before TypeScript.",
    );
  });

  it("rejects a missing server generated action file", async () => {
    const root = await makeTempRoot("aruna-package-consumption-files-");
    await writeTextFile(
      path.join(root, "src/.aruna/actions.client.generated.ts"),
      "export const purchaseItem = () => Promise.resolve({ ok: true });\n",
    );
    await writeTextFile(path.join(root, "src/.aruna/manifest.json"), "{\n  \"actions\": []\n}\n");

    await expect(assertGeneratedActionFiles(root)).rejects.toThrow(
      "aruna build did not write generated action files before TypeScript.",
    );
  });

  it("rejects a missing manifest file", async () => {
    const root = await makeTempRoot("aruna-package-consumption-files-");
    await writeTextFile(
      path.join(root, "src/.aruna/actions.client.generated.ts"),
      "export const purchaseItem = () => Promise.resolve({ ok: true });\n",
    );
    await writeTextFile(
      path.join(root, "src/.aruna/actions.server.generated.ts"),
      "export const actions = { purchaseItem: () => undefined };\n",
    );

    await expect(assertGeneratedActionFiles(root)).rejects.toThrow(
      "aruna build did not write generated action files before TypeScript.",
    );
  });

  it("accepts generated action files that use public package imports", async () => {
    const root = await makeTempRoot("aruna-package-consumption-imports-");
    await writeTextFile(
      path.join(root, "src/.aruna/actions.client.generated.ts"),
      [
        'import { invokeAction } from "aruna/client";',
        "",
        "export const purchaseItem = () => invokeAction(\"shop.purchaseItem\", {});",
        "",
      ].join("\n"),
    );
    await writeTextFile(
      path.join(root, "src/.aruna/actions.server.generated.ts"),
      'import { purchaseItem } from "../domains/shop/actions";\nexport const actions = { purchaseItem };\n',
    );
    await writeTextFile(path.join(root, "src/.aruna/manifest.json"), "{\n  \"actions\": []\n}\n");

    await expect(assertGeneratedActionImports(root)).resolves.toBeUndefined();
  });

  it("rejects generated action files that import the root package entry", async () => {
    const root = await makeTempRoot("aruna-package-consumption-imports-");
    await writeTextFile(
      path.join(root, "src/.aruna/actions.client.generated.ts"),
      [
        'import { invokeAction } from "aruna";',
        "",
        "export const purchaseItem = () => invokeAction(\"shop.purchaseItem\", {});",
        "",
      ].join("\n"),
    );
    await writeTextFile(
      path.join(root, "src/.aruna/actions.server.generated.ts"),
      'import { purchaseItem } from "../domains/shop/actions";\nexport const actions = { purchaseItem };\n',
    );
    await writeTextFile(path.join(root, "src/.aruna/manifest.json"), "{\n  \"actions\": []\n}\n");

    await expect(assertGeneratedActionImports(root)).rejects.toThrow(
      "Generated action files did not use public Aruna subpaths.",
    );
  });

  it("rewrites workspace versions to release-style versions", () => {
    expect(
      rewriteWorkspaceVersions(
        {
          aruna: "workspace:*",
          "@arunajs/core": "workspace:^",
          "@arunajs/compiler": "workspace:*",
          typescript: "^5.8.3",
        },
        {
          aruna: "0.0.1",
          "@arunajs/core": "0.1.0",
        },
        "0.9.9",
      ),
    ).toEqual({
      aruna: "0.0.1",
      "@arunajs/core": "0.1.0",
      "@arunajs/compiler": "0.9.9",
      typescript: "^5.8.3",
    });

    expect(rewriteWorkspaceVersions(undefined, {}, "0.0.0")).toBeUndefined();
  });

  it("catches direct monorepo path references", () => {
    expect(
      findForbiddenPackageConsumptionFragments(
        [
          'import { x } from "../../packages/aruna";',
          'import { y } from "packages/aruna/src";',
          'import { z } from "packages/aruna/dist";',
          'const w = "include/aruna";',
        ].join("\n"),
      ),
    ).toEqual([
      "../../packages/aruna",
      "packages/aruna/src",
      "packages/aruna/dist",
      "include/aruna",
    ]);
  });
});
