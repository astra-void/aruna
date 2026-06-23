// The package root is the config + compiler surface. Runtime APIs live under the
// dedicated subpaths: `aruna/server`, `aruna/client`, `aruna/roblox`, and
// `aruna/schema`.
export {
  defineConfig,
  type CompilerInput,
  type CompilerOutput,
  type Config,
  type CompilerConfig,
  type ActionsConfig,
  type ConventionConfig,
  type StrictConfig,
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

// The schema-driven binary codec is wire-level and shared by both runtimes.
export { decodeBinary, encodeBinary } from "./runtime/binary.js";
