// `pnpm bench:compiler` — how long the compiler takes on a synthetic project in
// the recommended layout, at 200, 1000, and 3000 files.
//
// Scenarios, each the median of several runs:
//   cold          the first check
//   warm          a check with nothing changed
//   body edit     one function body changed
//   import edit   one file gains an import
//   schema edit   one action's input schema changes a field type
//
// It drives the native compiler directly with a prebuilt input, so it measures
// the compiler (config loading happens once, as it does in `aruna dev`). When the
// binary exposes `CompilerSession`, the incremental path is measured; otherwise
// every check is a one-shot `checkProject`, which is the baseline.
//
// Flags: --sizes 200,1000 (default 200,1000,3000), --runs N (default 5),
//        --one-shot (measure the one-shot path even when a session exists),
//        --json (machine-readable output).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadNativeCompiler, loadProjectConfig } from "../packages/compiler/src/index.ts";

const argv = process.argv.slice(2);

function flagValue(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const sizes = (flagValue("--sizes") ?? "200,1000,3000").split(",").map(Number);
const runs = Number(flagValue("--runs") ?? "5");
const forceOneShot = argv.includes("--one-shot");
const asJson = argv.includes("--json");

// Files per domain: schema, model, actions, signals, runtime, ui, spec.
const FILES_PER_DOMAIN = 7;
// Plus src/server.ts, src/client.tsx, src/shared/format.ts.
const ROOT_FILES = 3;

function domainName(index: number): string {
  return `d${String(index).padStart(4, "0")}`;
}

function pascal(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function writeFile(root: string, relative: string, contents: string): void {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
}

function schemaSource(name: string, quantityType: "number" | "string"): string {
  const P = pascal(name);
  return `import { schema, type Infer } from "aruna/schema";

export const buy${P}Input = schema.object({
  itemId: schema.string().maxLength(32),
  quantity: schema.${quantityType}(),
});

export const buy${P}Output = schema.object({
  ok: schema.boolean(),
  total: schema.number(),
});

export const ${name}Changed = schema.object({ total: schema.u32() });

export type Buy${P}Input = Infer<typeof buy${P}Input>;
`;
}

function modelSource(name: string, factor: number): string {
  return `import { formatAmount } from "../../shared/format";

export function price${pascal(name)}(quantity: number): number {
  return quantity * ${factor};
}

export function describe${pascal(name)}(total: number): string {
  return formatAmount(total);
}
`;
}

function actionsSource(name: string, extraImport: boolean): string {
  const P = pascal(name);
  return `import { defineAction } from "aruna/server";
import { buy${P}Input, buy${P}Output } from "./schema";
import { price${P} } from "./model";
${extraImport ? `import { describe${P} } from "./model";\n` : ""}
export const buy${P} = defineAction({
  id: "${name}.buy",
  input: buy${P}Input,
  output: buy${P}Output,
  rateLimit: { key: "player", windowMs: 1000, max: 5 },
  run(_ctx, input) {
    return { ok: true, total: price${P}(input.quantity as number) };
  },
});
`;
}

function signalsSource(name: string): string {
  return `import { defineSignal } from "aruna/server";
import { ${name}Changed } from "./schema";

export const ${name}ChangedSignal = defineSignal({ id: "${name}.changed", payload: ${name}Changed });
`;
}

function runtimeSource(name: string): string {
  return `import { defineRuntime } from "aruna/server";

export const ${name}Runtime = defineRuntime({
  id: "${name}",
  start() {},
});
`;
}

function uiSource(name: string): string {
  return `import { describe${pascal(name)} } from "./model";

export function ${name}Label(total: number): string {
  return describe${pascal(name)}(total);
}
`;
}

function specSource(name: string): string {
  return `import { describe, expect, it } from "aruna/testing";
import { price${pascal(name)} } from "./model";

describe("${name}", () => {
  it("prices", () => {
    expect(price${pascal(name)}(2)).toBe(2);
  });
});
`;
}

// Writes a project of about `files` source files; returns the domain count.
function generateProject(root: string, files: number): number {
  const domains = Math.max(1, Math.round((files - ROOT_FILES) / FILES_PER_DOMAIN));
  writeFile(root, "tsconfig.json", `{ "compilerOptions": { "baseUrl": "." } }\n`);
  writeFile(
    root,
    "src/shared/format.ts",
    `export function formatAmount(total: number): string {\n  return \`\${total}\`;\n}\n`,
  );
  writeFile(root, "src/server.ts", `export const serverReady = true;\n`);
  writeFile(root, "src/client.tsx", `export const clientReady = true;\n`);
  for (let index = 0; index < domains; index += 1) {
    const name = domainName(index);
    const dir = `src/domains/${name}`;
    writeFile(root, `${dir}/schema.ts`, schemaSource(name, "number"));
    writeFile(root, `${dir}/model.ts`, modelSource(name, 1));
    writeFile(root, `${dir}/actions.ts`, actionsSource(name, false));
    writeFile(root, `${dir}/signals.ts`, signalsSource(name));
    writeFile(root, `${dir}/runtime.ts`, runtimeSource(name));
    writeFile(root, `${dir}/ui.tsx`, uiSource(name));
    writeFile(root, `${dir}/actions.test.ts`, specSource(name));
  }
  return domains;
}

type NativeSession = {
  update(changedPaths: string[]): void;
  check(): Promise<string>;
  dispose(): void;
};

type BenchNative = ReturnType<typeof loadNativeCompiler> & {
  CompilerSession?: new (input: unknown) => NativeSession;
};

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

async function time(work: () => unknown): Promise<number> {
  const start = performance.now();
  await work();
  return performance.now() - start;
}

type Scenario = "cold" | "warm" | "body edit" | "import edit" | "schema edit";
type SizeResult = { files: number; domains: number; mode: string; ms: Record<Scenario, number> };

async function benchSize(native: BenchNative, files: number): Promise<SizeResult> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `aruna-bench-${files}-`));
  try {
    const domains = generateProject(root, files);
    const loaded = loadProjectConfig(root);
    const input = {
      projectRoot: root,
      config: loaded.config,
      configDiagnostics: loaded.diagnostics,
      tsconfigOptions: { baseUrl: loaded.tsconfigOptions.baseUrl, paths: undefined },
      writeManifest: false,
      writeGenerated: false,
      warningsAsErrors: false,
    };
    const useSession = native.CompilerSession !== undefined && !forceOneShot;
    const mode = useSession ? "session" : "one-shot";

    // The file each edit touches, in the middle domain so it is not special.
    const target = domainName(Math.floor(domains / 2));
    const modelPath = path.join(root, `src/domains/${target}/model.ts`);
    const actionsPath = path.join(root, `src/domains/${target}/actions.ts`);
    const schemaPath = path.join(root, `src/domains/${target}/schema.ts`);

    let session: NativeSession | undefined;
    const check = async (changed: string[]): Promise<unknown> => {
      if (session !== undefined) {
        session.update(changed);
        return JSON.parse(await session.check());
      }
      return native.checkProject(input);
    };

    const cold: number[] = [];
    for (let run = 0; run < Math.min(runs, 3); run += 1) {
      session?.dispose();
      cold.push(
        await time(async () => {
          if (useSession) {
            session = new native.CompilerSession!(input);
            return check([]);
          }
          return native.checkProject(input);
        }),
      );
    }

    const warm: number[] = [];
    for (let run = 0; run < runs; run += 1) {
      warm.push(await time(() => check([])));
    }

    const edit = async (file: string, variants: readonly string[]): Promise<number[]> => {
      const samples: number[] = [];
      for (let run = 0; run < runs; run += 1) {
        fs.writeFileSync(file, variants[(run + 1) % variants.length]);
        samples.push(await time(() => check([file])));
      }
      // Leave the project as generated for the next scenario.
      fs.writeFileSync(file, variants[0]);
      await check([file]);
      return samples;
    };

    const result: SizeResult = {
      files: domains * FILES_PER_DOMAIN + ROOT_FILES,
      domains,
      mode,
      ms: {
        cold: median(cold),
        warm: median(warm),
        "body edit": median(
          await edit(modelPath, [modelSource(target, 1), modelSource(target, 2)]),
        ),
        "import edit": median(
          await edit(actionsPath, [actionsSource(target, false), actionsSource(target, true)]),
        ),
        "schema edit": median(
          await edit(schemaPath, [schemaSource(target, "number"), schemaSource(target, "string")]),
        ),
      },
    };
    session?.dispose();
    return result;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const native = loadNativeCompiler() as BenchNative;
  const results: SizeResult[] = [];
  for (const files of sizes) {
    results.push(await benchSize(native, files));
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    const scenarios: Scenario[] = ["cold", "warm", "body edit", "import edit", "schema edit"];
    console.log(`compiler benchmark (${results[0]?.mode ?? "?"}, median of ${runs} runs, ms)\n`);
    console.log(["files", ...scenarios].map((cell) => cell.padStart(12)).join(""));
    for (const result of results) {
      console.log(
        [String(result.files), ...scenarios.map((scenario) => result.ms[scenario].toFixed(1))]
          .map((cell) => cell.padStart(12))
          .join(""),
      );
    }
    console.log(
      `\n${os.cpus()[0]?.model ?? "unknown cpu"}, ${os.cpus().length} cores, node ${process.version}`,
    );
  }
}

void main();
