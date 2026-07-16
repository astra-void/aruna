import fs from "node:fs";
import path from "node:path";

// Optional domain parts selectable with `--with`.
export const ADD_DOMAIN_EXTRAS = ["ui", "runtime"] as const;
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

export const ping${pascal}InputSchema = schema.object({
  message: schema.string(),
});

export const ping${pascal}OutputSchema = schema.object({
  reply: schema.string(),
});

export type Ping${pascal}Input = Infer<typeof ping${pascal}InputSchema>;
export type Ping${pascal}Output = Infer<typeof ping${pascal}OutputSchema>;
`;
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
  run(_ctx, input): Ping${pascal}Output {
    return { reply: format${pascal}Reply(input.message) };
  },
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
  ];
  if (extras.includes("ui")) {
    files.push({ name: "ui.tsx", contents: uiTemplate(name, pascal) });
  }
  if (extras.includes("runtime")) {
    files.push({ name: "runtime.ts", contents: runtimeTemplate(name, pascal) });
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

  return lines.join("\n");
}
