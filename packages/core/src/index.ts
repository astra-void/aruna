export type ArunaModuleKind =
  | "client"
  | "server"
  | "shared"
  | "clientEntry"
  | "serverEntry"
  | "serverAction"
  | "unknown";

export type ArunaDiagnosticSeverity = "error" | "warning" | "info";

export type ArunaDiagnosticCode =
  | "aruna::100"
  | "aruna::102"
  | "aruna::103"
  | "aruna::106"
  | "aruna::105"
  | "aruna::200"
  | "aruna::203"
  | "aruna::550"
  | "aruna::551"
  | "aruna::552"
  | "aruna::553"
  | "aruna::554"
  | "aruna::560"
  | "aruna::555"
  | "aruna::556"
  | "aruna::557"
  | "aruna::300"
  | "aruna::301"
  | "aruna::302"
  | "aruna::303"
  | "aruna::700"
  | "aruna::701"
  | "aruna::900";

export type ArunaDiagnostic = {
  code: ArunaDiagnosticCode;
  name: string;
  severity: ArunaDiagnosticSeverity;
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

export type ArunaModuleRecord = {
  id: string;
  path: string;
  kind: ArunaModuleKind;
  reason: "path" | "directive" | "fallback";
  reasonDetail?: string | undefined;
};

export type ArunaActionRecord = {
  id: string;
  file: string;
  exportName: string;
  hasInputSchema: boolean;
  hasOutputSchema: boolean;
  hasRun: boolean;
  serialization: {
    policy: "plain-data-v1";
  };
  rateLimit?:
    | {
        key: "player";
        windowMs: number;
        max: number;
      }
    | undefined;
  inputSchema?: ArunaSchemaMetadata | undefined;
  outputSchema?: ArunaSchemaMetadata | undefined;
};

export type ArunaSchemaLiteralMetadata =
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

export type ArunaSchemaMetadata = {
  kind: string;
  properties?: Record<string, ArunaSchemaMetadata> | undefined;
  items?: ArunaSchemaMetadata | undefined;
  literal?: ArunaSchemaLiteralMetadata | undefined;
  values?: ArunaSchemaLiteralMetadata[] | undefined;
  inner?: ArunaSchemaMetadata | undefined;
};

export type ArunaGeneratedFile = {
  path: string;
  contents: string;
};

export type ArunaImportEdge = {
  from: string;
  to?: string | undefined;
  specifier: string;
  resolved: boolean;
  kind?: "static" | "dynamic" | undefined;
};

export type ArunaManifest = {
  version: 1;
  projectRoot: string;
  modules: ArunaModuleRecord[];
  imports: ArunaImportEdge[];
  actions: ArunaActionRecord[];
  diagnostics: ArunaDiagnostic[];
};

export type ArunaCompilerConfig = {
  readonly generatedDir?: string | undefined;
  readonly manifest?:
    | string
    | {
        readonly output?: string | undefined;
      }
    | undefined;
  readonly preserveGeneratedComments?: boolean | undefined;
};

export type ArunaActionsConfig = {
  readonly transport?: "remote-event" | "remote-function" | "memory" | undefined;
  readonly defaultRateLimit?: NonNullable<ArunaActionRecord["rateLimit"]> | undefined;
};

export type ArunaConventionConfig = {
  readonly client?: readonly string[] | undefined;
  readonly server?: readonly string[] | undefined;
  readonly shared?: readonly string[] | undefined;
};

export type ArunaStrictConfig = {
  readonly sharedSafety?: boolean | undefined;
  readonly rawRemoteUsage?: "off" | "warning" | "error" | undefined;
  readonly unresolvedImports?: "off" | "warning" | "error" | undefined;
};

export type ArunaConfig = {
  readonly root?: string | undefined;
  readonly compiler?: ArunaCompilerConfig | undefined;
  readonly actions?: ArunaActionsConfig | undefined;
  readonly conventions?: ArunaConventionConfig | undefined;
  readonly strict?: ArunaStrictConfig | undefined;
};

export type NormalizedArunaConfig = {
  readonly root: string;
  readonly generatedDir: string;
  readonly manifestOutput: string;
  readonly compiler: {
    readonly preserveGeneratedComments: boolean;
  };
  readonly actions: {
    readonly transport: "remote-event" | "remote-function" | "memory";
    readonly defaultRateLimit: NonNullable<ArunaActionsConfig["defaultRateLimit"]>;
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

export type ArunaCompilerInput = {
  root?: string | undefined;
  configPath?: string | undefined;
  config?: ArunaConfig | undefined;
  writeManifest?: boolean | undefined;
  writeGenerated?: boolean | undefined;
  json?: boolean | undefined;
  quiet?: boolean | undefined;
  verbose?: boolean | undefined;
  warningsAsErrors?: boolean | undefined;
};

export type ArunaCompilerSummary = {
  modules: number;
  imports: number;
  resolvedImports: number;
  errors: number;
  warnings: number;
  infos: number;
};

export type ArunaCompilerOutput = {
  ok: boolean;
  projectRoot: string;
  config: NormalizedArunaConfig;
  diagnostics: ArunaDiagnostic[];
  manifest: ArunaManifest;
  generatedFiles?: ArunaGeneratedFile[] | undefined;
  summary: ArunaCompilerSummary;
  manifestPath?: string | undefined;
};

export const DEFAULT_ARUNA_CONFIG: NormalizedArunaConfig = {
  root: "src",
  generatedDir: "src/.aruna",
  manifestOutput: "src/.aruna/manifest.json",
  compiler: {
    preserveGeneratedComments: true,
  },
  actions: {
    transport: "remote-event",
    defaultRateLimit: {
      key: "player",
      windowMs: 1000,
      max: 20,
    },
  },
  conventions: {
    client: ["**/client/**"],
    server: ["**/server/**"],
    shared: ["**/shared/**"],
  },
  strict: {
    sharedSafety: true,
    rawRemoteUsage: "warning",
    unresolvedImports: "warning",
  },
};

export function defineConfig(config: ArunaConfig): ArunaConfig {
  return config;
}
