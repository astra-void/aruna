export type ModuleKind =
  | "client"
  | "server"
  | "shared"
  | "clientEntry"
  | "serverEntry"
  | "serverAction"
  // A module exporting a store definition. Server-only, and distinguished from
  // serverAction so a client import can be reported as a store violation.
  | "serverStore"
  // A spec. Compiled and run by `aruna test`, and left out of the game build —
  // free to import client, server, and shared modules alike, while nothing may
  // import it (aruna::305).
  | "test"
  | "unknown";

export type DiagnosticSeverity = "error" | "warning" | "info";

export type DiagnosticCode =
  | "aruna::100"
  | "aruna::102"
  | "aruna::103"
  | "aruna::111"
  | "aruna::112"
  | "aruna::106"
  | "aruna::105"
  | "aruna::109"
  | "aruna::200"
  | "aruna::203"
  | "aruna::507"
  | "aruna::510"
  | "aruna::511"
  | "aruna::512"
  | "aruna::513"
  | "aruna::514"
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
  | "aruna::569"
  | "aruna::578"
  | "aruna::579"
  | "aruna::584"
  | "aruna::585"
  | "aruna::555"
  | "aruna::556"
  | "aruna::557"
  | "aruna::558"
  | "aruna::300"
  | "aruna::301"
  | "aruna::302"
  | "aruna::303"
  | "aruna::304"
  | "aruna::305"
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
  // Declared safe to run twice, so a timed-out invoke may be retried. Omitted
  // from the manifest JSON when false.
  idempotent?: boolean | undefined;
  serialization: {
    policy: "plain-data-v1";
  };
  rateLimit?:
    | {
        key: "player" | "global";
        windowMs: number;
        max: number;
        // Present only for a token bucket; the default fixed window omits it.
        strategy?: "tokenBucket" | undefined;
      }
    | undefined;
  inputSchema?: SchemaMetadata | undefined;
  outputSchema?: SchemaMetadata | undefined;
  // The errors the action declares, sorted by name. Omitted from the manifest
  // JSON when there are none.
  errors?: ActionErrorRecord[] | undefined;
};

// One error an action declares: a failure the client can tell apart by name,
// and the schema of its data when it has any.
export type ActionErrorRecord = {
  name: string;
  hasData: boolean;
  dataSchema?: SchemaMetadata | undefined;
};

// A server -> client signal discovered by the compiler. The push counterpart to
// ActionRecord: an id and an optional payload schema, no run/response.
export type SignalRecord = {
  id: string;
  file: string;
  exportName: string;
  hasPayloadSchema: boolean;
  // Routed over the dedicated UnreliableRemoteEvent (no delivery/ordering
  // guarantee). Omitted from the manifest JSON when false.
  unreliable?: boolean | undefined;
  // "binary" when the payload travels as an `encodeBinary` buffer. Omitted for
  // the default table encoding.
  wire?: "binary" | undefined;
  // The largest `encodeBinary` output for the payload, frame header included.
  // Omitted when the schema has no size bound.
  maxEncodedBytes?: number | undefined;
  serialization: {
    policy: "plain-data-v1";
  };
  payloadSchema?: SchemaMetadata | undefined;
};

// A plain keyed store, or a session-locked per-player document.
export type StoreKind = "store" | "playerStore";

export type StoreRecord = {
  // The DataStore name.
  id: string;
  file: string;
  exportName: string;
  kind: StoreKind;
  // The declared data version; 1 when the definition omits it.
  version: number;
  scope?: string | undefined;
  // Whether a migrate() was declared. Omitted from the manifest JSON when false.
  hasMigrate?: boolean | undefined;
  schema?: SchemaMetadata | undefined;
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
  // The bounds a constraint chain declares with a static argument (a number
  // literal, or a module-level const bound to one). A string's
  // `minLength`/`maxLength` are UTF-8 bytes and `minChars`/`maxChars` code
  // points; `.length(n)` sets both ends of a string's bytes or an array's items.
  minLength?: number | undefined;
  maxLength?: number | undefined;
  minChars?: number | undefined;
  maxChars?: number | undefined;
  min?: number | undefined;
  max?: number | undefined;
  int?: boolean | undefined;
  minItems?: number | undefined;
  maxItems?: number | undefined;
  maxEntries?: number | undefined;
  // How many `.refine(...)` calls the chain makes.
  refinements?: number | undefined;
  // Bounds present with a non-static argument: bounded, but not comparable.
  dynamicConstraints?: string[] | undefined;
  // A hash of every `.refine(...)` and every non-static bound, in order.
  // Opaque: equal means that part of the chain did not change.
  constraintsHash?: string | undefined;
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
  stores?: StoreRecord[] | undefined;
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

export type DefaultRateLimitConfig = {
  readonly key: "player" | "global";
  readonly windowMs: number;
  readonly max: number;
  // "fixedWindow" (the default) or "tokenBucket".
  readonly strategy?: "fixedWindow" | "tokenBucket" | undefined;
};

export type ActionsConfig = {
  readonly defaultRateLimit?: DefaultRateLimitConfig | undefined;
};

// Classification globs. The arrays *extend* the built-in Recommended Layout
// defaults rather than replacing them, so a project that only needs one extra
// pattern writes exactly that one pattern. `defaults: false` opts out of the
// built-in set entirely and makes the arrays the whole convention set.
export type ConventionConfig = {
  readonly defaults?: boolean | undefined;
  readonly client?: readonly string[] | undefined;
  readonly server?: readonly string[] | undefined;
  readonly shared?: readonly string[] | undefined;
  // Globs for spec files. These outrank every other convention — a spec sits
  // next to the code it exercises, so `**/server/**` would otherwise claim it.
  // Defaults to `**/*.test.ts(x)` and `**/*.spec.ts(x)`.
  readonly test?: readonly string[] | undefined;
};

// Which directories are domain units, for the domain-to-domain public API
// boundary. Roots are globs matching a domain *directory* (`src/domains/*`
// matches `src/domains/shop`), and they extend the built-in `<root>/domains/*`.
export type DomainsConfig = {
  readonly roots?: readonly string[] | undefined;
};

export type StrictConfig = {
  // Not enforced yet: no shared-module safety check exists. Setting it to
  // `false` reports aruna::109 rather than silently doing nothing.
  readonly sharedSafety?: boolean | undefined;
  // Raw RemoteEvent / RemoteFunction use in project code (aruna::507).
  readonly rawRemoteUsage?: "off" | "warning" | "error" | undefined;
  // Imports Aruna could not resolve (aruna::105).
  readonly unresolvedImports?: "off" | "warning" | "error" | undefined;
  // Imports that reach past another domain's public surface (aruna::304).
  readonly domainBoundary?: "off" | "warning" | "error" | undefined;
  // A store change, against the committed contract snapshot, that leaves this
  // build unable to read records the previous build wrote (aruna::578). An
  // error by default: the cost of getting it wrong is a player's save file.
  readonly storeCompatibility?: "off" | "warning" | "error" | undefined;
  // An action input with a string, array, or record that has no upper bound
  // (aruna::514).
  readonly unboundedInput?: "off" | "warning" | "error" | undefined;
};

// The committed contract snapshot `aruna check` and `aruna build` compare the
// project against. Relative to the project root. The gate only runs when the
// file exists; `aruna contract update` writes it.
export type ContractConfig = {
  readonly snapshot?: string | undefined;
};

// Reporting controls. `ignore` lists diagnostic codes (`"aruna::507"`) or names
// (`"raw-remote-usage"`) to drop from every report, project-wide.
export type DiagnosticsConfig = {
  readonly ignore?: readonly string[] | undefined;
};

// `aruna dev` process options. `rojo: true` (the default) spawns `rojo serve`
// alongside the watch build when a default.project.json exists; `false`
// disables the child; `{ port }` picks the serve port. Purely a CLI concern —
// the compiler never reads this section.
export type DevConfig = {
  readonly rojo?: boolean | { readonly port?: number | undefined } | undefined;
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
  readonly domains?: DomainsConfig | undefined;
  readonly strict?: StrictConfig | undefined;
  readonly diagnostics?: DiagnosticsConfig | undefined;
  readonly contract?: ContractConfig | undefined;
  readonly dev?: DevConfig | undefined;
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
  // The effective set: built-in defaults merged with the project's globs
  // (unless `conventions.defaults: false` opted the defaults out).
  readonly conventions: {
    readonly client: readonly string[];
    readonly server: readonly string[];
    readonly shared: readonly string[];
    readonly test: readonly string[];
  };
  // Only the project's own globs. They win over a default whenever both match,
  // so opting into the defaults can never reclassify a hand-pinned file.
  readonly conventionOverrides: {
    readonly client: readonly string[];
    readonly server: readonly string[];
    readonly shared: readonly string[];
    readonly test: readonly string[];
  };
  // The effective domain roots: the built-in `<root>/domains/*` plus the
  // project's own.
  readonly domains: {
    readonly roots: readonly string[];
  };
  readonly strict: {
    readonly sharedSafety: boolean;
    readonly rawRemoteUsage: "off" | "warning" | "error";
    readonly unresolvedImports: "off" | "warning" | "error";
    readonly domainBoundary: "off" | "warning" | "error";
    readonly storeCompatibility: "off" | "warning" | "error";
    readonly unboundedInput: "off" | "warning" | "error";
  };
  readonly diagnostics: {
    readonly ignore: readonly string[];
  };
  readonly contract: {
    readonly snapshot: string;
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
    shared: [
      "**/shared/**",
      "src/app/**",
      "**/schema.ts",
      "**/model.ts",
      "**/signals.ts",
      "**/index.ts",
    ],
    test: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
  },
  // Nothing is overridden in the default config, so the defaults above are the
  // whole effective set.
  conventionOverrides: {
    client: [],
    server: [],
    shared: [],
    test: [],
  },
  // Must stay in sync with `default_domain_roots` in
  // crates/aruna_compiler/src/domains.rs.
  domains: {
    roots: ["src/domains/*"],
  },
  strict: {
    sharedSafety: true,
    rawRemoteUsage: "warning",
    unresolvedImports: "warning",
    domainBoundary: "warning",
    storeCompatibility: "error",
    unboundedInput: "warning",
  },
  diagnostics: {
    ignore: [],
  },
  contract: {
    snapshot: "aruna.contract.json",
  },
};

export function defineConfig(config: Config): Config {
  return config;
}
