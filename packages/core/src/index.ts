export type ArunaModuleKind = "client" | "server" | "shared" | "unknown";

export type ArunaDiagnosticSeverity = "error" | "warning" | "info";

export type ArunaDiagnosticCode =
  | "aruna::100"
  | "aruna::102"
  | "aruna::105"
  | "aruna::200"
  | "aruna::203"
  | "aruna::300"
  | "aruna::301"
  | "aruna::302"
  | "aruna::303"
  | "aruna::700"
  | "aruna::900";

export type ArunaDiagnostic = {
  code: ArunaDiagnosticCode;
  name: string;
  severity: ArunaDiagnosticSeverity;
  message: string;
  file?: string | undefined;
  span?: {
    start: number;
    end: number;
  } | undefined;
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
  generatedAt?: string | undefined;
  modules: ArunaModuleRecord[];
  imports: ArunaImportEdge[];
  diagnostics: ArunaDiagnostic[];
};

export type ArunaConfig = {
  root?: string | undefined;
  tsconfig?: string | undefined;
  source?: {
    include?: string[] | undefined;
    exclude?: string[] | undefined;
  } | undefined;
  conventions?: {
    client?: string[] | undefined;
    server?: string[] | undefined;
    shared?: string[] | undefined;
  } | undefined;
  diagnostics?: {
    warningsAsErrors?: boolean | undefined;
    ignore?: string[] | undefined;
  } | undefined;
  security?: {
    mode?: "recommended" | "strict" | "audit" | "off" | undefined;
  } | undefined;
  manifest?: {
    enabled?: boolean | undefined;
    output?: string | undefined;
  } | undefined;
};

export type ArunaCompilerInput = {
  root?: string | undefined;
  configPath?: string | undefined;
  config?: ArunaConfig | undefined;
  writeManifest?: boolean | undefined;
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
  config: ArunaConfig;
  diagnostics: ArunaDiagnostic[];
  manifest: ArunaManifest;
  summary: ArunaCompilerSummary;
  manifestPath?: string | undefined;
};

export const DEFAULT_ARUNA_CONFIG: Required<Pick<
  ArunaConfig,
  "tsconfig" | "source" | "conventions" | "diagnostics" | "security" | "manifest"
>> = {
  tsconfig: "tsconfig.json",
  source: {
    include: ["src/**/*.ts", "src/**/*.tsx"],
    exclude: ["node_modules/**", "out/**", ".aruna/**"]
  },
  conventions: {
    client: ["**/client/**"],
    server: ["**/server/**"],
    shared: ["**/shared/**"]
  },
  diagnostics: {
    warningsAsErrors: false
  },
  security: {
    mode: "recommended"
  },
  manifest: {
    enabled: true,
    output: ".aruna/manifest.json"
  }
};

export function defineConfig<T extends ArunaConfig>(config: T): T {
  return config;
}
