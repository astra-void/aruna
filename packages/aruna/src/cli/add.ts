import fs from "node:fs";
import path from "node:path";

// Optional domain parts selectable with `--with`.
export const ADD_DOMAIN_EXTRAS = ["ui", "runtime", "resource"] as const;
export type AddDomainExtra = (typeof ADD_DOMAIN_EXTRAS)[number];

export type AddDomainOptions = {
  readonly projectRoot: string;
  // The configured source root (config `root`, default "src").
  readonly root: string;
  readonly name: string;
  readonly extras: readonly AddDomainExtra[];
};

export type AddDomainResult = {
  readonly domainDir: string;
  readonly created: string[];
  readonly skipped: string[];
};

// Domain names become directory segments and action-id prefixes
// (`<name>.<action>`), so they are restricted to identifier-safe segments.
export function validateDomainName(name: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
    return (
      `invalid domain name "${name}" — use letters, digits, "-" or "_", ` +
      `starting with a letter (e.g. "shop", "player-stats")`
    );
  }
  return undefined;
}

export function parseAddExtras(withOption: string | undefined): {
  extras?: AddDomainExtra[];
  error?: string;
} {
  if (withOption === undefined || withOption.trim().length === 0) {
    return { extras: [] };
  }
  const parts = withOption
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const unknown = parts.filter(
    (part) => !ADD_DOMAIN_EXTRAS.includes(part as AddDomainExtra),
  );
  if (unknown.length > 0) {
    return {
      error: `unknown --with part(s): ${unknown.join(", ")} (supported: ${ADD_DOMAIN_EXTRAS.join(", ")})`,
    };
  }
  return { extras: [...new Set(parts)] as AddDomainExtra[] };
}

// "player-stats" -> "PlayerStats", for generated type/function names.
export function pascalCase(name: string): string {
  return name
    .split(/[-_]/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("");
}

function schemaTemplate(pascal: string): string {
  return `import { schema, type Infer } from "aruna/schema";

// Client input is bounded, so the server refuses an oversized payload while
// validating it (aruna::514 flags an unbounded one).
export const ping${pascal}InputSchema = schema.object({
  message: schema.string().maxChars(200),
});

export const ping${pascal}OutputSchema = schema.object({
  reply: schema.string(),
});

export type Ping${pascal}Input = Infer<typeof ping${pascal}InputSchema>;
export type Ping${pascal}Output = Infer<typeof ping${pascal}OutputSchema>;

// What the server pushes to a player after they ping (see ./signals).
export const ${lower(pascal)}PingedPayload = schema.object({
  reply: schema.string().maxChars(240),
});
`;
}

function lower(pascal: string): string {
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function modelTemplate(name: string, pascal: string): string {
  return `// Shared ${name} domain model: pure data and helpers importable from both
// client and server code (classified shared by the \`**/model.ts\` convention).

export function format${pascal}Reply(message: string): string {
  return \`${name}: \${message}\`;
}
`;
}

function actionsTemplate(name: string, pascal: string): string {
  // Schemas live in ./schema and are referenced by import — the compiler
  // resolves schema identifiers through one relative import hop, so the
  // contract metadata still extracts and ./schema stays the single home of
  // the wire shapes and their Infer'd types.
  return `import { defineAction } from "aruna/server";
import {
  ping${pascal}InputSchema,
  ping${pascal}OutputSchema,
  type Ping${pascal}Output,
} from "./schema";
import { format${pascal}Reply } from "./model";

export const ping${pascal} = defineAction({
  id: "${name}.ping",
  input: ping${pascal}InputSchema,
  output: ping${pascal}OutputSchema,
  run(ctx, input): Ping${pascal}Output {
    const reply = format${pascal}Reply(input.message);
    // The app-owned publisher (generated entries wire it): the caller also
    // gets the reply as a push, before this action's response.
    ctx.publisher?.to(ctx.player, "${name}.pinged", { reply });
    return { reply };
  },
});
`;
}

// The domain's server -> client signal. Shared by convention (**/signals.ts):
// the generated registry imports it on both sides.
function signalsTemplate(name: string, pascal: string): string {
  return `import { defineSignal } from "aruna/server";
import { ${lower(pascal)}PingedPayload } from "./schema";

export const ${lower(pascal)}Pinged = defineSignal({
  id: "${name}.pinged",
  payload: ${lower(pascal)}PingedPayload,
});
`;
}

// A server-owned resource clients subscribe to (docs/resources.md). The file
// defines a resource, so the compiler classifies it server code.
function resourcesTemplate(name: string, pascal: string): string {
  return `import { defineResource } from "aruna/roblox";
import { schema } from "aruna/schema";

// Per-player state the server owns. Replace the map with your store; call
// \`ctx.resources?.invalidate(${lower(pascal)}State)\` from an action after a change.
const pings = new Map<number, number>();

export function record${pascal}Ping(userId: number): void {
  pings.set(userId, (pings.get(userId) ?? 0) + 1);
}

export const ${lower(pascal)}State = defineResource({
  id: "${name}.state",
  schema: schema.object({ pings: schema.u32() }),
  load(ctx) {
    return { pings: pings.get(ctx.player.UserId) ?? 0 };
  },
});
`;
}

// A passing spec for the action the scaffold just wrote, so a new domain starts
// with a test to extend rather than an empty file to remember to create. It is
// classified `test` by the `**/*.test.ts` convention, which keeps it out of the
// game build; `aruna test` compiles and runs it.
function actionsSpecTemplate(name: string, pascal: string): string {
  return `import { createTestPlayer, createTestServerApp, describe, expect, it } from "aruna/testing";
import { ping${pascal} } from "./actions";
import type { Ping${pascal}Output } from "./schema";
import { ${lower(pascal)}Pinged } from "./signals";

const actions = { "${name}.ping": ping${pascal} };
const signals = { "${name}.pinged": ${lower(pascal)}Pinged };

describe("${name}.ping", () => {
  it("replies to the message it was sent, and pushes the reply", async () => {
    // The harness owns the transport, the publisher, and the players source, so
    // this dispatch goes through the real validation and rate-limiting path.
    const harness = createTestServerApp({ actions, signals });
    const player = createTestPlayer();

    const output = (await harness.invoke(player, "${name}.ping", {
      message: "hello",
    })) as Ping${pascal}Output;

    expect(output.reply).toContain("hello");
    const published = harness.takePublished();
    expect(published.size()).toBe(1);
    expect(published[0]!.signalId).toBe("${name}.pinged");
    harness.dispose();
  });

  it("rejects input the schema does not accept", async () => {
    const harness = createTestServerApp({ actions });

    let rejection: { readonly name?: string } | undefined;
    await harness.invoke(createTestPlayer(), "${name}.ping", { message: 42 }).catch((err: unknown) => {
      rejection = err as { readonly name?: string };
    });
    expect(rejection?.name).toBe("ActionValidationError");

    harness.dispose();
  });
});
`;
}

function uiTemplate(name: string, pascal: string): string {
  return `// Client-only ${name} UI (classified client by the \`**/ui.tsx\` convention).
// Call server actions through the generated stubs, e.g.
//   import { ping${pascal} } from "$aruna/actions/client";

export function ${pascal}Panel() {
  return undefined;
}
`;
}

function runtimeTemplate(name: string, pascal: string): string {
  return `// Server-only ${name} runtime (classified server by the \`**/runtime.ts\`
// convention): schedulers, services, and state that must never replicate.

export function start${pascal}Runtime(): void {}
`;
}

export type DomainFilePlan = {
  readonly name: string;
  readonly contents: string;
};

// The scaffold plan for a domain. File names are the Recommended Layout v0
// conventions the classifier ships with (`**/schema.ts` / `**/model.ts` shared,
// `**/actions.ts` / `**/runtime.ts` server, `**/ui.tsx` client), so generated
// files are correctly classified by construction — asserted by the unit tests
// against DEFAULT_CONFIG.conventions.
export function planDomainFiles(
  name: string,
  extras: readonly AddDomainExtra[],
): DomainFilePlan[] {
  const pascal = pascalCase(name);
  const files: DomainFilePlan[] = [
    { name: "schema.ts", contents: schemaTemplate(pascal) },
    { name: "model.ts", contents: modelTemplate(name, pascal) },
    { name: "actions.ts", contents: actionsTemplate(name, pascal) },
    { name: "signals.ts", contents: signalsTemplate(name, pascal) },
    { name: "actions.test.ts", contents: actionsSpecTemplate(name, pascal) },
  ];
  if (extras.includes("ui")) {
    files.push({ name: "ui.tsx", contents: uiTemplate(name, pascal) });
  }
  if (extras.includes("runtime")) {
    files.push({ name: "runtime.ts", contents: runtimeTemplate(name, pascal) });
  }
  if (extras.includes("resource")) {
    files.push({ name: "resources.ts", contents: resourcesTemplate(name, pascal) });
  }
  return files;
}

export function runAddDomain(options: AddDomainOptions): AddDomainResult {
  const domainDir = path.posix.join(options.root, "domains", options.name);
  const created: string[] = [];
  const skipped: string[] = [];

  for (const file of planDomainFiles(options.name, options.extras)) {
    const relative = path.posix.join(domainDir, file.name);
    const absolute = path.join(options.projectRoot, relative);
    if (fs.existsSync(absolute)) {
      skipped.push(relative);
      continue;
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, file.contents, "utf8");
    created.push(relative);
  }

  return { domainDir, created, skipped };
}

export function formatAddDomainReport(name: string, result: AddDomainResult): string {
  const lines: string[] = [`aruna add domain ${name}`, ""];

  if (result.created.length > 0) {
    lines.push("created");
    for (const file of result.created) {
      lines.push(`  + ${file}`);
    }
  }

  if (result.skipped.length > 0) {
    if (result.created.length > 0) {
      lines.push("");
    }
    lines.push("kept existing");
    for (const file of result.skipped) {
      lines.push(`  = ${file}`);
    }
  }

  lines.push("");
  lines.push("next steps");
  lines.push(`  1. fill in the schemas and actions under ${result.domainDir}/`);
  lines.push("  2. aruna build   # regenerate stubs and the manifest for the new domain");
  lines.push("  3. aruna test    # run the scaffolded spec (and the rest)");

  return lines.join("\n");
}
