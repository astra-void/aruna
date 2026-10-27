// The package root is the config + compiler surface, and the only entry that
// runs under Node. The runtime lives under the type-only subpaths
// `aruna/server`, `aruna/client`, `aruna/roblox`, `aruna/schema`, and
// `aruna/testing`, which a game compiles from its vendored copy.
export {
  defineConfig,
  type CompilerInput,
  type CompilerOutput,
  type Config,
  type CompilerConfig,
  type ActionsConfig,
  type ConventionConfig,
  type StrictConfig,
  type DiagnosticsConfig,
  type ActionRecord,
  type Diagnostic,
  type DiagnosticCode,
  type DiagnosticSeverity,
  type GeneratedFile,
  type ImportEdge,
  type Manifest,
  type ModuleKind,
  type ModuleRecord,
  type SchemaLiteralMetadata,
  type SchemaMetadata,
} from "@arunajs/core";

export { buildProject, checkProject, inspectProject } from "@arunajs/compiler";
