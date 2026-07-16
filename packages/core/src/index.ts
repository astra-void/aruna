export type ModuleKind =
  | "client"
  | "server"
  | "shared"
  | "clientEntry"
  | "serverEntry"
  | "serverAction"
  | "unknown";

export type DiagnosticSeverity = "error" | "warning" | "info";

export type DiagnosticCode =
  | "aruna::100"
  | "aruna::102"
  | "aruna::103"
  | "aruna::110"
  | "aruna::111"
  | "aruna::112"
  | "aruna::106"
  | "aruna::105"
  | "aruna::200"
  | "aruna::203"
  | "aruna::550"
  | "aruna::551"
  | "aruna::552"
  | "aruna::553"
  | "aruna::554"
  | "aruna::559"
  | "aruna::560"
  | "aruna::563"
  | "aruna::564"
  | "aruna::565"
  | "aruna::566"
  | "aruna::568"
  | "aruna::555"
  | "aruna::556"
  | "aruna::557"
  | "aruna::558"
  | "aruna::300"
  | "aruna::301"
  | "aruna::302"
  | "aruna::303"
  | "aruna::700"
  | "aruna::701"
  | "aruna::900";

export type Diagnostic = {
  code: DiagnosticCode;
  name: string;
  severity: DiagnosticSeverity;
  message: string;
  file?: string | undefined;
  span?:
    | {
        start: number;
        end: number;
      }
    | undefined;
  details?: string | undefined;
  suggestion?: string | undefined;
  docsUrl?: string | undefined;
};

export type ModuleRecord = {
  id: string;
  path: string;
  kind: ModuleKind;
  reason: "path" | "directive" | "fallback";
  reasonDetail?: string | undefined;
};

export type ActionRecord = {
  id: string;
  file: string;
  exportName: string;
  hasInputSchema: boolean;
  hasOutputSchema: boolean;
  hasRun: boolean;
  // One-way action: the client does not wait for an ack and the server skips the
  // response. Omitted from the manifest JSON when false.
  fireAndForget?: boolean | undefined;
  serialization: {
    policy: "plain-data-v1";
  };
  rateLimit?:
    | {
        key: "player" | "global";
        windowMs: number;
        max: number;
      }
    | undefined;
  inputSchema?: SchemaMetadata | undefined;
  outputSchema?: SchemaMetadata | undefined;
};

// A server -> client signal discovered by the compiler. The push counterpart to
// ActionRecord: an id and an optional payload schema, no run/response.
export type SignalRecord = {
  id: string;
  file: string;
  exportName: string;
  hasPayloadSchema: boolean;
  serialization: {
    policy: "plain-data-v1";
  };
  payloadSchema?: SchemaMetadata | undefined;
};

export type SchemaLiteralMetadata =
  | {
      kind: "string";
      value: string;
    }
  | {
      kind: "number";
      value: string;
    }
  | {
      kind: "boolean";
      value: boolean;
    }
  | {
      kind: "undefined";
    };

export type SchemaMetadata = {
  kind: string;
  numericFormat?: string | undefined;
  properties?: Record<string, SchemaMetadata> | undefined;
  items?: SchemaMetadata | undefined;
  literal?: SchemaLiteralMetadata | undefined;
  values?: SchemaLiteralMetadata[] | undefined;
  inner?: SchemaMetadata | undefined;
  members?: SchemaMetadata[] | undefined;
};

export type GeneratedFile = {
  path: string;
  contents: string;
};

export type ImportEdge = {
  from: string;
  to?: string | undefined;
  specifier: string;
  resolved: boolean;
  kind?: "static" | "dynamic" | undefined;
};

export type Manifest = {
  version: 1;
  projectRoot: string;
  modules: ModuleRecord[];
  imports: ImportEdge[];
  actions: ActionRecord[];
  // Omitted from manifest JSON when empty; treat as [] when absent.
  signals?: SignalRecord[] | undefined;
  diagnostics: Diagnostic[];
};

export type CompilerConfig = {
  readonly generatedDir?: string | undefined;
  readonly manifest?:
    | string
    | {
        readonly output?: string | undefined;
      }
    | undefined;
  readonly preserveGeneratedComments?: boolean | undefined;
};

export type ActionsConfig = {
  readonly defaultRateLimit?: NonNullable<ActionRecord["rateLimit"]> | undefined;
};

export type ConventionConfig = {
  readonly client?: readonly string[] | undefined;
  readonly server?: readonly string[] | undefined;
  readonly shared?: readonly string[] | undefined;
};

export type StrictConfig = {
  readonly sharedSafety?: boolean | undefined;
  readonly rawRemoteUsage?: "off" | "warning" | "error" | undefined;
  readonly unresolvedImports?: "off" | "warning" | "error" | undefined;
};

// Who owns the runtime entry scripts. "user": the project's src/server.ts /
// src/client.tsx are the Script/LocalScript entries (classic model).
// "generated": Aruna emits <generatedDir>/server/main.server.ts and
// <generatedDir>/client/main.client.ts from the manifest, and the user entry
// files (when present) become plain hook modules imported by the generated
// mains.
export type EntriesMode = "user" | "generated";

export type Config = {
  readonly root?: string | undefined;
  readonly entries?: EntriesMode | undefined;
  readonly compiler?: CompilerConfig | undefined;
  readonly actions?: ActionsConfig | undefined;
  readonly conventions?: ConventionConfig | undefined;
  readonly strict?: StrictConfig | undefined;
};

export type NormalizedConfig = {
  readonly root: string;
  readonly generatedDir: string;
  readonly manifestOutput: string;
  readonly entries: EntriesMode;
  readonly compiler: {
    readonly preserveGeneratedComments: boolean;
  };
  readonly actions: {
    readonly defaultRateLimit: NonNullable<ActionsConfig["defaultRateLimit"]>;
  };
  readonly conventions: {
    readonly client: readonly string[];
    readonly server: readonly string[];
    readonly shared: readonly string[];
  };
  readonly strict: {
    readonly sharedSafety: boolean;
    readonly rawRemoteUsage: "off" | "warning" | "error";
    readonly unresolvedImports: "off" | "warning" | "error";
  };
};

export type CompilerInput = {
  root?: string | undefined;
  configPath?: string | undefined;
  config?: Config | undefined;
  writeManifest?: boolean | undefined;
  writeGenerated?: boolean | undefined;
  json?: boolean | undefined;
  quiet?: boolean | undefined;
  verbose?: boolean | undefined;
  warningsAsErrors?: boolean | undefined;
};

export type CompilerSummary = {
  modules: number;
  imports: number;
  resolvedImports: number;
  errors: number;
  warnings: number;
  infos: number;
};

export type CompilerOutput = {
  ok: boolean;
  projectRoot: string;
  config: NormalizedConfig;
  diagnostics: Diagnostic[];
  manifest: Manifest;
  generatedFiles?: GeneratedFile[] | undefined;
  summary: CompilerSummary;
  manifestPath?: string | undefined;
};

export const DEFAULT_CONFIG: NormalizedConfig = {
  root: "src",
  generatedDir: "src/.aruna",
  manifestOutput: "src/.aruna/manifest.json",
  entries: "user",
  compiler: {
    preserveGeneratedComments: true,
  },
  actions: {
    defaultRateLimit: {
      key: "player",
      windowMs: 1000,
      max: 20,
    },
  },
  // Recommended Layout v0 defaults; must stay in sync with
  // `ConventionSet::for_root` in crates/aruna_compiler/src/module_kind.rs.
  conventions: {
    client: ["**/client/**", "**/ui.tsx"],
    server: ["**/server/**", "**/actions.ts", "**/runtime.ts"],
    shared: ["**/shared/**", "src/app/**", "**/schema.ts", "**/model.ts"],
  },
  strict: {
    sharedSafety: true,
    rawRemoteUsage: "warning",
    unresolvedImports: "warning",
  },
};

export function defineConfig(config: Config): Config {
  return config;
}
