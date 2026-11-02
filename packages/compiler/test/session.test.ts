// The TypeScript side of the incremental compiler: a session's runs match the
// one-shot entry points, and a run does not block the main thread.
// (The byte-level differential test over random edits is in
// crates/aruna_compiler/tests/session.rs.)
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCompilerSession, inspectProject } from "../src/index.ts";

let roots: string[] = [];

afterEach(async () => {
  // Retried: on Windows a worker that is still releasing its handles makes the
  // first removal fail with ENOTEMPTY.
  await Promise.all(
    roots.map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
  roots = [];
});

async function project(domains: number): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aruna-session-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "tsconfig.json"), "{}\n");
  for (let index = 0; index < domains; index += 1) {
    const dir = path.join(root, "src", "domains", `d${index}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "schema.ts"),
      `import { schema } from "aruna/schema";\nexport const input${index} = schema.object({ n: schema.number() });\n`,
    );
    await fs.writeFile(
      path.join(dir, "actions.ts"),
      `import { defineAction } from "aruna/server";\nimport { input${index} } from "./schema";\nimport { helper } from "./model";\n` +
        `export const act${index} = defineAction({ id: "d${index}.act", input: input${index}, run() { return helper(); } });\n`,
    );
    await fs.writeFile(
      path.join(dir, "model.ts"),
      `export function helper(): number { return ${index}; }\n`,
    );
  }
  return root;
}

// The session compiles a 400-file project on a worker; Windows runners take
// well past vitest's 5 s default to write and compile it.
describe("compiler session", { timeout: 60_000 }, () => {
  it("matches the one-shot compiler before and after edits", async () => {
    const root = await project(6);
    const session = createCompilerSession({ root }, "inspect");
    try {
      expect(await session.run()).toEqual(await inspectProject({ root }));

      // A schema edit under an action, a new file, and a removed one.
      const schemaPath = path.join(root, "src/domains/d1/schema.ts");
      await fs.writeFile(
        schemaPath,
        `import { schema } from "aruna/schema";\nexport const input1 = schema.object({ n: schema.string() });\n`,
      );
      const added = path.join(root, "src/domains/d2/extra.ts");
      await fs.writeFile(added, `export const extra = 1;\n`);
      const removed = path.join(root, "src/domains/d3/model.ts");
      await fs.rm(removed);
      session.update([schemaPath, added, removed]);

      expect(await session.run()).toEqual(await inspectProject({ root }));
    } finally {
      session.dispose();
    }
  });

  it("runs off the main thread", async () => {
    const root = await project(400);
    const session = createCompilerSession({ root }, "inspect");
    try {
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
      }, 1);
      const started = performance.now();
      await session.run();
      const elapsed = performance.now() - started;
      clearInterval(timer);
      // The main thread kept servicing timers while the compiler ran. (A run
      // blocking it would let at most one tick through, after it finished.)
      expect(elapsed).toBeGreaterThan(5);
      expect(ticks).toBeGreaterThan(1);
    } finally {
      session.dispose();
    }
  });

  it("refuses to run after dispose", async () => {
    const root = await project(1);
    const session = createCompilerSession({ root }, "inspect");
    session.dispose();
    await expect(session.run()).rejects.toThrow("disposed");
  });
});
