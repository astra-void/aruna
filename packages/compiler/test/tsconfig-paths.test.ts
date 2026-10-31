// tsconfig `paths` without a baseUrl, the way the tsconfig upkeep writes them:
// TypeScript resolves each target against the directory of the config that
// declares it, and the compiler has to agree or it reports imports tsc accepts
// as unresolved.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectProject } from "../src/index.ts";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
  roots = [];
});

async function project(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-tsconfig-paths-"));
  roots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await fs.writeFile(path.join(root, relativePath), contents);
  }
  return root;
}

const sources = {
  "src/shared/lib/format.ts": "export const format = (n: number): string => `${n}`;\n",
  "src/client.ts": 'import { format } from "@lib/format";\nexport const label = format(1);\n',
};

async function aliasEdge(root: string) {
  const output = await inspectProject({ root });
  return output.manifest.imports.find((edge) => edge.specifier === "@lib/format");
}

describe("tsconfig paths without a baseUrl", () => {
  it("resolves targets written relative to tsconfig.json", async () => {
    const root = await project({
      ...sources,
      "tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "@lib/*": ["./src/shared/lib/*"] } },
      }),
    });

    expect(await aliasEdge(root)).toMatchObject({
      resolved: true,
      to: "src/shared/lib/format.ts",
    });
  });

  it("resolves an inherited paths block against the config that declares it", async () => {
    const root = await project({
      ...sources,
      "config/tsconfig.base.json": JSON.stringify({
        compilerOptions: { paths: { "@lib/*": ["../src/shared/lib/*"] } },
      }),
      "tsconfig.json": JSON.stringify({ extends: "./config/tsconfig.base.json" }),
    });

    expect(await aliasEdge(root)).toMatchObject({
      resolved: true,
      to: "src/shared/lib/format.ts",
    });
  });
});
