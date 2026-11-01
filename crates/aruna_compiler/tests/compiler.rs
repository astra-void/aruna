use aruna_compiler::{
    check_project, classify_relative_path, CompilerInput, ConventionSet, DiagnosticSeverity,
    ModuleKind, StrictSeverity, TsconfigResolverOptions,
};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use tempfile::TempDir;

fn write_file(root: &Path, relative: &str, contents: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, contents).unwrap();
}

fn compiler_input(root: &Path) -> CompilerInput {
    CompilerInput {
        project_root: root.to_string_lossy().to_string(),
        config: Default::default(),
        config_diagnostics: Vec::new(),
        tsconfig_options: TsconfigResolverOptions::default(),
        write_manifest: true,
        write_generated: false,
        warnings_as_errors: false,
    }
}

fn diagnostic_codes(output: &aruna_compiler::CompilerOutput) -> Vec<String> {
    output
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.code.clone())
        .collect()
}

#[test]
fn classifies_relative_paths() {
    let conventions = ConventionSet::default();
    assert_eq!(
        classify_relative_path("src/client/main.ts", &conventions).kind,
        ModuleKind::Client
    );
    assert_eq!(
        classify_relative_path("src/server/main.ts", &conventions).kind,
        ModuleKind::Server
    );
    assert_eq!(
        classify_relative_path("src/shared/schema.ts", &conventions).kind,
        ModuleKind::Shared
    );
    assert_eq!(
        classify_relative_path("src/utils/debug.ts", &conventions).kind,
        ModuleKind::Unknown
    );
}

#[test]
fn resolves_relative_imports_and_enforces_boundaries() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();

    write_file(
        root,
        "src/client/main.ts",
        r#"
import { schema } from "../shared/schema";
import { secret } from "../server/secret";

export const main = { schema, secret };
"#,
    );
    write_file(
        root,
        "src/shared/schema.ts",
        "export const schema = { ok: true };\n",
    );
    write_file(
        root,
        "src/server/secret.ts",
        "export const secret = \"shh\";\n",
    );

    let output = check_project(compiler_input(root));

    assert!(!output.ok);
    assert_eq!(diagnostic_codes(&output), vec!["aruna::300".to_string()]);
    assert_eq!(
        output
            .manifest
            .modules
            .iter()
            .map(|module| module.path.clone())
            .collect::<Vec<_>>(),
        vec![
            "src/client/main.ts".to_string(),
            "src/server/secret.ts".to_string(),
            "src/shared/schema.ts".to_string(),
        ]
    );
    assert_eq!(
        output
            .manifest
            .imports
            .iter()
            .map(|edge| edge.specifier.clone())
            .collect::<Vec<_>>(),
        vec![
            "../server/secret".to_string(),
            "../shared/schema".to_string()
        ]
    );
}

#[test]
fn resolves_tsconfig_aliases_and_reports_unresolved_imports() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();

    write_file(
        root,
        "src/client/main.ts",
        r#"
import { schema } from "@shared/schema";
import { missing } from "../shared/missing";

export const main = { schema, missing };
"#,
    );
    write_file(
        root,
        "src/shared/schema.ts",
        "export const schema = { alias: true } as const;\n",
    );

    let mut paths = BTreeMap::new();
    paths.insert("@shared/*".to_string(), vec!["src/shared/*".to_string()]);
    let input = CompilerInput {
        tsconfig_options: TsconfigResolverOptions {
            base_url: Some(root.to_string_lossy().to_string()),
            paths,
        },
        ..compiler_input(root)
    };

    let output = check_project(input);

    assert!(output.ok);
    assert_eq!(diagnostic_codes(&output), vec!["aruna::105".to_string()]);
    assert_eq!(
        output
            .manifest
            .imports
            .iter()
            .map(|edge| (edge.specifier.clone(), edge.resolved))
            .collect::<Vec<_>>(),
        vec![
            ("../shared/missing".to_string(), false),
            ("@shared/schema".to_string(), true)
        ]
    );
}

fn unresolved_import_project(root: &Path) {
    write_file(
        root,
        "src/client/main.ts",
        "import { missing } from \"../shared/missing\";\nexport const main = missing;\n",
    );
}

#[test]
fn applies_strict_unresolved_imports_severity() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    unresolved_import_project(root);

    let mut as_error = compiler_input(root);
    as_error.config.strict.unresolved_imports = StrictSeverity::Error;
    let output = check_project(as_error);
    assert!(!output.ok);
    assert_eq!(diagnostic_codes(&output), vec!["aruna::105".to_string()]);
    assert_eq!(output.diagnostics[0].severity, DiagnosticSeverity::Error);

    let mut off = compiler_input(root);
    off.config.strict.unresolved_imports = StrictSeverity::Off;
    let output = check_project(off);
    assert!(output.ok);
    assert!(output.diagnostics.is_empty());
}

fn raw_remote_project(root: &Path) {
    write_file(
        root,
        "src/server/net.ts",
        "export const remote = new Instance(\"RemoteEvent\");\nremote.FireAllClients(1);\n",
    );
    // Specs are not game code, so a raw remote in one is never reported.
    write_file(
        root,
        "src/server/net.test.ts",
        "const remote = new Instance(\"RemoteEvent\");\nremote.FireServer(1);\n",
    );
}

#[test]
fn reports_raw_remote_usage_at_the_configured_severity() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    raw_remote_project(root);

    let output = check_project(compiler_input(root));
    assert!(output.ok);
    assert_eq!(
        diagnostic_codes(&output),
        vec!["aruna::507".to_string(), "aruna::507".to_string()]
    );
    assert!(output
        .diagnostics
        .iter()
        .all(|diagnostic| diagnostic.file.as_deref() == Some("src/server/net.ts")
            && diagnostic.severity == DiagnosticSeverity::Warning));

    let mut as_error = compiler_input(root);
    as_error.config.strict.raw_remote_usage = StrictSeverity::Error;
    let output = check_project(as_error);
    assert!(!output.ok);
    assert!(output
        .diagnostics
        .iter()
        .all(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error));

    let mut off = compiler_input(root);
    off.config.strict.raw_remote_usage = StrictSeverity::Off;
    assert!(check_project(off).diagnostics.is_empty());
}

fn unbounded_input_project(root: &Path) {
    write_file(
        root,
        "src/server/actions.ts",
        r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const rename = defineAction({
  id: "profile.rename",
  input: schema.object({ name: schema.string(), tags: schema.array(schema.string().maxLength(8)) }),
  run() {},
});

export const bounded = defineAction({
  id: "profile.bounded",
  input: schema.object({ name: schema.string().maxChars(20), level: schema.number() }),
  run() {},
});
"#,
    );
}

#[test]
fn reports_unbounded_action_input_at_the_configured_severity() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    unbounded_input_project(root);

    // One diagnostic for the action that has unbounded values, naming each.
    let output = check_project(compiler_input(root));
    assert!(output.ok);
    assert_eq!(diagnostic_codes(&output), vec!["aruna::514".to_string()]);
    let diagnostic = &output.diagnostics[0];
    assert_eq!(diagnostic.name, "unbounded-action-input");
    assert_eq!(diagnostic.severity, DiagnosticSeverity::Warning);
    assert_eq!(diagnostic.file.as_deref(), Some("src/server/actions.ts"));
    assert!(diagnostic.message.contains("profile.rename"));
    let details = diagnostic.details.as_deref().unwrap_or_default();
    assert!(details.contains("input.name: a string with no .maxLength(n) or .maxChars(n)"));
    assert!(details.contains("input.tags: an array with no .maxItems(n)"));
    assert!(!details.contains("input.tags[]"));

    let mut as_error = compiler_input(root);
    as_error.config.strict.unbounded_input = StrictSeverity::Error;
    let output = check_project(as_error);
    assert!(!output.ok);
    assert_eq!(output.diagnostics[0].severity, DiagnosticSeverity::Error);

    let mut off = compiler_input(root);
    off.config.strict.unbounded_input = StrictSeverity::Off;
    assert!(check_project(off).diagnostics.is_empty());
}

#[test]
fn drops_diagnostics_listed_in_diagnostics_ignore_by_code_or_name() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    raw_remote_project(root);
    unresolved_import_project(root);

    let mut by_name = compiler_input(root);
    by_name.config.diagnostics.ignore = vec!["raw-remote-usage".to_string()];
    assert_eq!(
        diagnostic_codes(&check_project(by_name)),
        vec!["aruna::105".to_string()]
    );

    let mut by_code = compiler_input(root);
    by_code.config.diagnostics.ignore = vec!["aruna::105".to_string(), "aruna::507".to_string()];
    assert!(check_project(by_code).diagnostics.is_empty());
}

fn diagnostic<'a>(
    output: &'a aruna_compiler::CompilerOutput,
    code: &str,
) -> Vec<&'a aruna_compiler::ArunaDiagnostic> {
    output
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code == code)
        .collect()
}

// The project from the shared-safety walkthrough: a shared model that loads a
// shared profile that loads a server store.
fn write_transitive_project(root: &Path) {
    write_file(
        root,
        "src/domains/combat/model.ts",
        "import { profile } from \"../economy/model\";\nexport const model = profile;\n",
    );
    write_file(
        root,
        "src/domains/economy/model.ts",
        "import { store } from \"./server/store\";\nexport const profile = store;\n",
    );
    write_file(
        root,
        "src/domains/economy/server/store.ts",
        "export const store = 1;\n",
    );
}

#[test]
fn reports_a_shared_module_that_loads_server_code_through_another() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    write_transitive_project(root);

    let mut input = compiler_input(root);
    input.config.strict.domain_boundary = StrictSeverity::Off;
    let output = check_project(input);
    assert!(!output.ok);
    // The direct edge, where it is.
    let direct = diagnostic(&output, "aruna::303");
    assert_eq!(direct.len(), 1);
    assert_eq!(direct[0].file.as_deref(), Some("src/domains/economy/model.ts"));
    // The module upstream of it, with the chain and the import that starts it.
    let transitive = diagnostic(&output, "aruna::306");
    assert_eq!(transitive.len(), 1);
    let report = transitive[0];
    assert_eq!(report.name, "shared-transitive-server-dependency");
    assert_eq!(report.severity, DiagnosticSeverity::Error);
    assert_eq!(report.file.as_deref(), Some("src/domains/combat/model.ts"));
    let span = report.span.as_ref().expect("points at the import");
    let source = fs::read_to_string(root.join("src/domains/combat/model.ts")).unwrap();
    assert_eq!(&source[span.start..span.end], "\"../economy/model\"");
    assert_eq!(
        report.details.as_deref(),
        Some(
            "dependency chain:\n  src/domains/combat/model.ts (shared)\n  → src/domains/economy/model.ts (shared)\n  → src/domains/economy/server/store.ts (server)"
        )
    );
    assert!(report
        .suggestion
        .as_deref()
        .unwrap()
        .starts_with("The import to fix is in src/domains/economy/model.ts."));
}

#[test]
fn shared_safety_off_keeps_only_the_import_boundary_rules() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    write_transitive_project(root);
    write_file(
        root,
        "src/shared/save.ts",
        "export const store = game.GetService(\"DataStoreService\");\n",
    );

    let mut on = compiler_input(root);
    on.config.strict.domain_boundary = StrictSeverity::Off;
    let codes = diagnostic_codes(&check_project(on));
    assert!(codes.contains(&"aruna::306".to_string()), "{codes:?}");
    assert!(codes.contains(&"aruna::308".to_string()), "{codes:?}");

    let mut off = compiler_input(root);
    off.config.strict.domain_boundary = StrictSeverity::Off;
    off.config.strict.shared_safety = false;
    assert_eq!(diagnostic_codes(&check_project(off)), vec!["aruna::303".to_string()]);
}

#[test]
fn reports_a_server_only_service_read_from_shared_code() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let source = r#"const RunService = game.GetService("RunService");
const DataStoreService = game.GetService("DataStoreService");
export function load() {
    return game.GetService("MemoryStoreService");
}
export function guarded() {
    if (RunService.IsServer()) {
        return game.GetService("ServerStorage");
    }
}
"#;
    write_file(root, "src/shared/save.ts", source);
    // The same reads are what server code is for.
    write_file(root, "src/server/save.ts", source);

    let output = check_project(compiler_input(root));
    let at_load = diagnostic(&output, "aruna::308");
    assert_eq!(at_load.len(), 1);
    assert_eq!(at_load[0].file.as_deref(), Some("src/shared/save.ts"));
    assert_eq!(at_load[0].severity, DiagnosticSeverity::Error);
    let span = at_load[0].span.as_ref().unwrap();
    assert_eq!(&source[span.start..span.end], "game.GetService(\"DataStoreService\")");
    let in_function = diagnostic(&output, "aruna::309");
    assert_eq!(in_function.len(), 1);
    assert_eq!(in_function[0].severity, DiagnosticSeverity::Warning);
    assert!(in_function[0].message.contains("MemoryStoreService"));
    assert_eq!(output.diagnostics.len(), 2, "{:?}", diagnostic_codes(&output));
}

#[test]
fn type_only_imports_cross_boundaries_without_a_report() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    write_file(
        root,
        "src/server/session.ts",
        "export interface ServerSession { id: number }\nexport const serverSession = { id: 1 };\nexport class Base {}\n",
    );
    write_file(
        root,
        "src/shared/view.ts",
        r#"import type { ServerSession } from "../server/session";
import { type ServerSession as Aliased } from "../server/session";
import { Base, serverSession } from "../server/session";
export type { ServerSession as Reexported } from "../server/session";
export type View = { session: ServerSession; aliased: Aliased; instance: typeof serverSession };
export interface Extended extends Base {}
export class Impl implements Base {}
"#,
    );
    write_file(
        root,
        "src/client/main.ts",
        "import type { ServerSession } from \"../server/session\";\nexport const id = (session: ServerSession) => session.id;\n",
    );

    let output = check_project(compiler_input(root));
    assert!(output.ok, "{:?}", output.diagnostics);
    assert!(output.diagnostics.is_empty(), "{:?}", diagnostic_codes(&output));
}

#[test]
fn a_value_import_or_reexport_is_still_a_runtime_dependency() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    write_file(
        root,
        "src/server/session.ts",
        "export interface ServerSession { id: number }\nexport const serverSession = { id: 1 };\n",
    );
    write_file(
        root,
        "src/shared/read.ts",
        "import { serverSession } from \"../server/session\";\nexport const id = serverSession.id;\n",
    );
    write_file(
        root,
        "src/shared/reexport.ts",
        "export { serverSession } from \"../server/session\";\n",
    );
    write_file(
        root,
        "src/shared/star.ts",
        "export * from \"../server/session\";\n",
    );
    write_file(
        root,
        "src/shared/side-effect.ts",
        "import \"../server/session\";\n",
    );
    write_file(
        root,
        "src/shared/local-reexport.ts",
        "import { serverSession } from \"../server/session\";\nexport { serverSession };\n",
    );

    let output = check_project(compiler_input(root));
    let mut files: Vec<_> = diagnostic(&output, "aruna::303")
        .iter()
        .map(|diagnostic| diagnostic.file.clone().unwrap())
        .collect();
    files.sort();
    assert_eq!(
        files,
        vec![
            "src/shared/local-reexport.ts",
            "src/shared/read.ts",
            "src/shared/reexport.ts",
            "src/shared/side-effect.ts",
            "src/shared/star.ts",
        ]
    );
}

#[test]
fn legal_shared_modules_and_unresolved_or_dynamic_imports_are_not_reported() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    write_file(root, "src/shared/math.ts", "export const add = (a: number, b: number) => a + b;\n");
    write_file(
        root,
        "src/shared/model.ts",
        r#"import { add } from "./math";
const Players = game.GetService("Players");
const HttpService = game.GetService("HttpService");
export const total = add(1, 2);
export async function later() {
    return import("../server/secret");
}
"#,
    );
    write_file(root, "src/server/secret.ts", "export const secret = 1;\n");
    write_file(
        root,
        "src/client/main.ts",
        "import { total } from \"../shared/model\";\nexport const shown = total;\n",
    );
    write_file(
        root,
        "src/server/main.ts",
        "import { total } from \"../shared/model\";\nimport { secret } from \"./secret\";\nexport const both = total + secret;\n",
    );

    let output = check_project(compiler_input(root));
    assert!(output.diagnostics.is_empty(), "{:?}", diagnostic_codes(&output));
}

#[test]
fn reports_a_shared_module_that_loads_client_code_through_another() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    write_file(
        root,
        "src/shared/a.ts",
        "import { b } from \"./b\";\nexport const a = b;\n",
    );
    write_file(
        root,
        "src/shared/b.ts",
        "import { ui } from \"../client/ui\";\nexport const b = ui;\n",
    );
    write_file(root, "src/client/ui.ts", "export const ui = 1;\n");

    let output = check_project(compiler_input(root));
    assert_eq!(diagnostic(&output, "aruna::302").len(), 1);
    let transitive = diagnostic(&output, "aruna::307");
    assert_eq!(transitive.len(), 1);
    assert_eq!(transitive[0].file.as_deref(), Some("src/shared/a.ts"));
}

#[test]
fn shared_safety_reports_are_ignorable_by_code_and_name() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    write_transitive_project(root);
    let mut input = compiler_input(root);
    input.config.strict.domain_boundary = StrictSeverity::Off;
    input.config.diagnostics.ignore = vec![
        "aruna::303".to_string(),
        "shared-transitive-server-dependency".to_string(),
    ];
    assert!(check_project(input).diagnostics.is_empty());
}

#[test]
fn reports_parse_failures_without_stopping_other_files() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();

    write_file(
        root,
        "src/client/main.ts",
        r#"
export const main = {
"#,
    );
    write_file(
        root,
        "src/client/other.ts",
        r#"
import { schema } from "../shared/schema";

export const other = schema;
"#,
    );
    write_file(
        root,
        "src/shared/schema.ts",
        "export const schema = { ok: true };\n",
    );

    let output = check_project(compiler_input(root));

    assert!(!output.ok);
    assert_eq!(diagnostic_codes(&output), vec!["aruna::106".to_string()]);
    assert_eq!(
        output
            .manifest
            .modules
            .iter()
            .map(|module| module.path.clone())
            .collect::<Vec<_>>(),
        vec![
            "src/client/main.ts".to_string(),
            "src/client/other.ts".to_string(),
            "src/shared/schema.ts".to_string(),
        ]
    );
    assert_eq!(
        output
            .manifest
            .imports
            .iter()
            .map(|edge| edge.specifier.clone())
            .collect::<Vec<_>>(),
        vec!["../shared/schema".to_string()]
    );
}

#[test]
fn orders_manifest_deterministically() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();

    write_file(
        root,
        "src/client/main.ts",
        r#"
import { b } from "./b";
import { a } from "./a";

export const main = { a, b };
"#,
    );
    write_file(root, "src/client/a.ts", "export const a = 1;\n");
    write_file(root, "src/client/b.ts", "export const b = 2;\n");
    write_file(root, "src/shared/z.ts", "export const z = 3;\n");

    let output = check_project(compiler_input(root));

    assert!(output.ok);
    assert_eq!(
        output
            .manifest
            .modules
            .iter()
            .map(|module| module.path.clone())
            .collect::<Vec<_>>(),
        vec![
            "src/client/a.ts".to_string(),
            "src/client/b.ts".to_string(),
            "src/client/main.ts".to_string(),
            "src/shared/z.ts".to_string(),
        ]
    );
    assert_eq!(
        output
            .manifest
            .imports
            .iter()
            .map(|edge| edge.specifier.clone())
            .collect::<Vec<_>>(),
        vec!["./a".to_string(), "./b".to_string()]
    );
}

#[test]
fn captures_undefined_literal_schema_metadata() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();

    write_file(
        root,
        "src/server/actions.ts",
        r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const demo = defineAction({
  id: "demo.literal",
  input: schema.literal(undefined),
  output: schema.enum([undefined, "ready"]),
  run() {
    return undefined;
  },
});
"#,
    );

    let output = check_project(compiler_input(root));

    assert!(output.ok);
    let action = output
        .manifest
        .actions
        .iter()
        .find(|action| action.id == "demo.literal")
        .expect("expected action metadata");

    let input_schema = action.input_schema.as_ref().expect("expected input schema");
    assert_eq!(input_schema.kind, "literal");
    assert_eq!(
        input_schema.literal.as_ref(),
        Some(&aruna_compiler::ArunaSchemaLiteralMetadata::Undefined)
    );

    let output_schema = action.output_schema.as_ref().expect("expected output schema");
    assert_eq!(output_schema.kind, "enum");
    assert_eq!(
        output_schema
            .values
            .as_ref()
            .expect("expected enum values"),
        &vec![
            aruna_compiler::ArunaSchemaLiteralMetadata::Undefined,
            aruna_compiler::ArunaSchemaLiteralMetadata::String {
                value: "ready".to_string(),
            },
        ]
    );
}

#[test]
fn chained_constraints_parse_to_the_underlying_schema() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();

    write_file(
        root,
        "src/server/actions.ts",
        r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const demo = defineAction({
  id: "demo.constrained",
  input: schema.object({
    level: schema.number().min(1).max(100).int(),
    name: schema.string().minLength(3).refine((value) => value !== "", "non-empty"),
    tags: schema.array(schema.string()).maxItems(5),
  }),
  run() {
    return undefined;
  },
});
"#,
    );

    let output = check_project(compiler_input(root));

    // The strict parser accepts chained constraint/refine methods instead of
    // rejecting the argument, and drops them (runtime-only) from the metadata.
    assert!(output.ok, "chained constraints should compile: {:?}", output.diagnostics);
    let action = output
        .manifest
        .actions
        .iter()
        .find(|action| action.id == "demo.constrained")
        .expect("expected action metadata");

    let properties = action
        .input_schema
        .as_ref()
        .expect("expected input schema")
        .properties
        .as_ref()
        .expect("expected object properties");

    // Constraints are transparent: level stays plain `number`, name plain
    // `string`, tags plain `string[]`.
    assert_eq!(properties["level"].kind, "number");
    assert_eq!(properties["level"].numeric_format, None);
    assert_eq!(properties["name"].kind, "string");
    assert_eq!(properties["tags"].kind, "array");
    assert_eq!(
        properties["tags"].items.as_ref().expect("expected array item").kind,
        "string"
    );
}

#[test]
fn discriminated_union_parses_as_a_plain_union() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();

    write_file(
        root,
        "src/server/actions.ts",
        r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const demo = defineAction({
  id: "demo.event",
  input: schema.discriminatedUnion("type", [
    schema.object({ type: schema.literal("move"), dx: schema.number() }),
    schema.object({ type: schema.literal("chat"), text: schema.string() }),
  ]),
  run() {
    return undefined;
  },
});
"#,
    );

    let output = check_project(compiler_input(root));

    assert!(output.ok, "discriminatedUnion should compile: {:?}", output.diagnostics);
    let input_schema = output
        .manifest
        .actions
        .iter()
        .find(|action| action.id == "demo.event")
        .expect("expected action metadata")
        .input_schema
        .as_ref()
        .expect("expected input schema");

    // Emitted as a plain union of its two object members — the discriminant is a
    // runtime-only dispatch hint, dropped from the metadata.
    assert_eq!(input_schema.kind, "union");
    let members = input_schema.members.as_ref().expect("expected union members");
    assert_eq!(members.len(), 2);
    assert_eq!(members[0].kind, "object");
    assert_eq!(members[1].kind, "object");
}

#[test]
fn parses_2d_userdata_schemas_and_renders_their_types() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();

    write_file(
        root,
        "src/server/actions.ts",
        r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const demo = defineAction({
  id: "ui.place",
  input: schema.object({
    at: schema.vector2(),
    size: schema.udim2(),
    pad: schema.udim(),
  }),
  run() {
    return undefined;
  },
});
"#,
    );

    let output = check_project(CompilerInput {
        write_generated: true,
        ..compiler_input(root)
    });

    assert!(output.ok, "2D userdata should compile: {:?}", output.diagnostics);
    let properties = output
        .manifest
        .actions
        .iter()
        .find(|action| action.id == "ui.place")
        .expect("expected action metadata")
        .input_schema
        .as_ref()
        .expect("expected input schema")
        .properties
        .as_ref()
        .expect("expected object properties");

    assert_eq!(properties["at"].kind, "vector2");
    assert_eq!(properties["size"].kind, "udim2");
    assert_eq!(properties["pad"].kind, "udim");

    // The generated client stub renders them to the @rbxts/types globals (not the
    // silent `unknown` fallback).
    let generated_files = output.generated_files.expect("expected generated files");
    let client = generated_files
        .iter()
        .find(|file| file.path.contains("actions.client.generated.ts"))
        .expect("expected generated client file");
    assert!(client.contents.contains("Vector2"));
    assert!(client.contents.contains("UDim2"));
    assert!(client.contents.contains("UDim"));
}

#[test]
fn parses_datetime_brickcolor_instance_and_default() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();

    write_file(
        root,
        "src/server/actions.ts",
        r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const demo = defineAction({
  id: "demo.rest",
  input: schema.object({
    when: schema.dateTime(),
    color: schema.brickColor(),
    part: schema.instance(),
    count: schema.number().default(1),
  }),
  run() {
    return undefined;
  },
});
"#,
    );

    let output = check_project(CompilerInput {
        write_generated: true,
        ..compiler_input(root)
    });

    assert!(output.ok, "should compile: {:?}", output.diagnostics);
    let properties = output
        .manifest
        .actions
        .iter()
        .find(|action| action.id == "demo.rest")
        .expect("expected action metadata")
        .input_schema
        .as_ref()
        .expect("expected input schema")
        .properties
        .as_ref()
        .expect("expected object properties");

    assert_eq!(properties["when"].kind, "dateTime");
    assert_eq!(properties["color"].kind, "brickColor");
    assert_eq!(properties["part"].kind, "instance");
    // `.default(1)` emits an `optional` wrapper so the client field is omittable;
    // the default value is runtime-only and dropped from the metadata.
    assert_eq!(properties["count"].kind, "optional");
    assert_eq!(
        properties["count"].inner.as_ref().expect("expected optional inner").kind,
        "number"
    );

    let generated_files = output.generated_files.expect("expected generated files");
    let client = generated_files
        .iter()
        .find(|file| file.path.contains("actions.client.generated.ts"))
        .expect("expected generated client file");
    assert!(client.contents.contains("DateTime"));
    assert!(client.contents.contains("BrickColor"));
    assert!(client.contents.contains("Instance"));
}

#[test]
fn rejects_null_literal_schema_values() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();

    write_file(
        root,
        "src/server/actions.ts",
        r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const demo = defineAction({
  id: "demo.literal",
  input: schema.literal(null),
  run() {
    return null;
  },
});
"#,
    );

    let output = check_project(compiler_input(root));

    assert_eq!(diagnostic_codes(&output), vec!["aruna::553".to_string()]);
    assert_eq!(output.summary.errors, 0);
    assert_eq!(output.summary.warnings, 1);
    assert_eq!(output.manifest.actions.len(), 1);
    assert!(output.manifest.actions[0].input_schema.is_none());
}

#[test]
fn captures_rate_limit_metadata() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();

    write_file(
        root,
        "src/server/actions.ts",
        r#"
import { defineAction } from "aruna/server";

export const demo = defineAction({
  id: "demo.rateLimit",
  rateLimit: {
    key: "player",
    windowMs: 1000,
    max: 5,
  },
  run() {
    return null;
  },
});
"#,
    );

    let output = check_project(compiler_input(root));

    assert!(output.ok);
    let action = output
        .manifest
        .actions
        .iter()
        .find(|action| action.id == "demo.rateLimit")
        .expect("expected action metadata");

    assert_eq!(
        action.rate_limit.as_ref(),
        Some(&aruna_compiler::ArunaActionRateLimitMetadata {
            key: "player".to_string(),
            window_ms: 1000,
            max: 5,
            strategy: None,
        })
    );
}

#[test]
fn records_custom_rate_limit_key_function_as_custom() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();

    write_file(
        root,
        "src/server/actions.ts",
        r#"
import { defineAction } from "aruna/server";

export const demo = defineAction({
  id: "demo.customKey",
  rateLimit: {
    key: (info) => `target:${info.actionId}`,
    windowMs: 1000,
    max: 5,
  },
  run() {
    return null;
  },
});
"#,
    );

    let output = check_project(compiler_input(root));

    assert!(output.ok, "a key function should compile, not error");
    let action = output
        .manifest
        .actions
        .iter()
        .find(|action| action.id == "demo.customKey")
        .expect("expected action metadata");

    // The function is applied at runtime; the manifest records the "custom"
    // sentinel so contract diff / inspect can surface a key change.
    assert_eq!(
        action.rate_limit.as_ref(),
        Some(&aruna_compiler::ArunaActionRateLimitMetadata {
            key: "custom".to_string(),
            window_ms: 1000,
            max: 5,
            strategy: None,
        })
    );
}

#[test]
fn records_a_token_bucket_strategy_and_rejects_an_unknown_one() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();

    write_file(
        root,
        "src/server/actions.ts",
        r#"
import { defineAction } from "aruna/server";

export const bucket = defineAction({
  id: "demo.bucket",
  rateLimit: { key: "player", windowMs: 1000, max: 5, strategy: "tokenBucket" },
  run() {},
});

export const window = defineAction({
  id: "demo.window",
  rateLimit: { key: "player", windowMs: 1000, max: 5, strategy: "fixedWindow" },
  run() {},
});
"#,
    );

    let output = check_project(compiler_input(root));
    assert!(output.ok);
    let strategy_of = |id: &str| {
        output
            .manifest
            .actions
            .iter()
            .find(|action| action.id == id)
            .and_then(|action| action.rate_limit.as_ref())
            .map(|rate_limit| rate_limit.strategy.clone())
    };
    assert_eq!(strategy_of("demo.bucket"), Some(Some("tokenBucket".to_string())));
    // The default is recorded as no strategy, written or not.
    assert_eq!(strategy_of("demo.window"), Some(None));

    write_file(
        root,
        "src/server/actions.ts",
        r#"
import { defineAction } from "aruna/server";

export const leaky = defineAction({
  id: "demo.leaky",
  rateLimit: { key: "player", windowMs: 1000, max: 5, strategy: "leakyBucket" },
  run() {},
});
"#,
    );
    let output = check_project(compiler_input(root));
    assert!(!output.ok);
    assert_eq!(diagnostic_codes(&output), vec!["aruna::560".to_string()]);
    assert!(output.diagnostics[0]
        .details
        .as_deref()
        .unwrap_or_default()
        .contains("rateLimit.strategy must be \"fixedWindow\" or \"tokenBucket\"."));
}

#[test]
fn captures_fire_and_forget_metadata() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();

    write_file(
        root,
        "src/server/actions.ts",
        r#"
import { defineAction } from "aruna/server";

export const oneWay = defineAction({
  id: "spray.paint",
  fireAndForget: true,
  run() {
    return null;
  },
});

export const twoWay = defineAction({
  id: "shop.purchase",
  run() {
    return null;
  },
});
"#,
    );

    let output = check_project(compiler_input(root));

    assert!(output.ok);
    let one_way = output
        .manifest
        .actions
        .iter()
        .find(|action| action.id == "spray.paint")
        .expect("expected fire-and-forget action metadata");
    assert!(one_way.fire_and_forget);

    let two_way = output
        .manifest
        .actions
        .iter()
        .find(|action| action.id == "shop.purchase")
        .expect("expected two-way action metadata");
    assert!(!two_way.fire_and_forget);
}

#[test]
fn rejects_invalid_fire_and_forget_metadata() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();

    write_file(
        root,
        "src/server/actions.ts",
        r#"
import { defineAction } from "aruna/server";

export const demo = defineAction({
  id: "demo.fireAndForget",
  fireAndForget: "yes",
  run() {
    return null;
  },
});
"#,
    );

    let output = check_project(compiler_input(root));

    assert_eq!(diagnostic_codes(&output), vec!["aruna::559".to_string()]);
    assert!(!output.ok);
}

#[test]
fn captures_idempotent_metadata() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();

    write_file(
        root,
        "src/server/actions.ts",
        r#"
import { defineAction } from "aruna/server";

export const claim = defineAction({
  id: "quest.claim",
  idempotent: true,
  run() {
    return null;
  },
});

export const purchase = defineAction({
  id: "shop.purchase",
  run() {
    return null;
  },
});
"#,
    );

    let output = check_project(compiler_input(root));

    assert!(output.ok);
    let claim = output
        .manifest
        .actions
        .iter()
        .find(|action| action.id == "quest.claim")
        .expect("expected idempotent action metadata");
    assert!(claim.idempotent);

    let purchase = output
        .manifest
        .actions
        .iter()
        .find(|action| action.id == "shop.purchase")
        .expect("expected plain action metadata");
    assert!(!purchase.idempotent);
    // Omitted from the manifest JSON when false, so existing snapshots stay
    // byte-stable.
    let json = serde_json::to_string(purchase).unwrap();
    assert!(!json.contains("idempotent"));
}

#[test]
fn rejects_non_literal_idempotent_metadata() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();

    write_file(
        root,
        "src/server/actions.ts",
        r#"
import { defineAction } from "aruna/server";

const SAFE = true;

export const demo = defineAction({
  id: "demo.idempotent",
  idempotent: SAFE,
  run() {
    return null;
  },
});
"#,
    );

    let output = check_project(compiler_input(root));

    assert_eq!(diagnostic_codes(&output), vec!["aruna::569".to_string()]);
    assert!(!output.ok);
}

#[test]
fn rejects_invalid_rate_limit_metadata() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();

    write_file(
        root,
        "src/server/actions.ts",
        r#"
import { defineAction } from "aruna/server";

export const demo = defineAction({
  id: "demo.rateLimit",
  rateLimit: {
    limit: 5,
    windowMs: 1000,
  },
  run() {
    return null;
  },
});
"#,
    );

    let output = check_project(compiler_input(root));

    assert_eq!(diagnostic_codes(&output), vec!["aruna::560".to_string()]);
    assert!(!output.ok);
    let action = output
        .manifest
        .actions
        .iter()
        .find(|action| action.id == "demo.rateLimit")
        .expect("expected action metadata");
    assert!(action.rate_limit.is_none());
}

#[test]
fn resolves_runtime_boot_order_from_after_edges() {
    use aruna_compiler::{resolve_runtime_order, ArunaRuntimeRecord};

    let runtime = |id: &str, after: &[&str]| ArunaRuntimeRecord {
        id: id.to_string(),
        file: format!("src/domains/{id}/runtime.ts"),
        export_name: format!("{id}Runtime"),
        after: after.iter().map(|entry| entry.to_string()).collect(),
    };

    // The shape a real game declares: score first because everything credits it,
    // playtime before anything gating on time, emote after the grab runtime it
    // registers hooks on, world after the round its parts call into.
    let (ordered, diagnostics) = resolve_runtime_order(&[
        runtime("world", &["round"]),
        runtime("emote", &["grab"]),
        runtime("score", &[]),
        runtime("grab", &["score"]),
        runtime("round", &["playtime"]),
        runtime("playtime", &["score"]),
    ]);

    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let ids: Vec<&str> = ordered.iter().map(|entry| entry.id.as_str()).collect();
    // Every dependency lands before its dependent, and independents are ordered
    // by id so the emitted sequence is stable across builds.
    assert_eq!(ids, vec!["score", "grab", "emote", "playtime", "round", "world"]);
}

#[test]
fn reports_an_after_edge_naming_no_runtime() {
    use aruna_compiler::{resolve_runtime_order, ArunaRuntimeRecord};

    let (ordered, diagnostics) = resolve_runtime_order(&[ArunaRuntimeRecord {
        id: "round".to_string(),
        file: "src/domains/round/runtime.ts".to_string(),
        export_name: "roundRuntime".to_string(),
        after: vec!["playtime".to_string()],
    }]);

    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code, "aruna::582");
    assert!(diagnostics[0].message.contains("playtime"));
    // The runtime itself still boots: one bad edge is not a reason to drop the
    // work, and the diagnostic already fails the build.
    assert_eq!(ordered.len(), 1);
}

#[test]
fn reports_a_runtime_order_cycle() {
    use aruna_compiler::{resolve_runtime_order, ArunaRuntimeRecord};

    let runtime = |id: &str, after: &str| ArunaRuntimeRecord {
        id: id.to_string(),
        file: format!("src/domains/{id}/runtime.ts"),
        export_name: format!("{id}Runtime"),
        after: vec![after.to_string()],
    };

    let (_, diagnostics) = resolve_runtime_order(&[runtime("a", "b"), runtime("b", "a")]);

    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code, "aruna::582");
    assert!(diagnostics[0].message.contains("cycle"));
}

#[test]
fn discovers_domain_runtimes_and_emits_the_resolved_boot_sequence() {
    use aruna_compiler::EntriesMode;

    let temp = TempDir::new().unwrap();
    let root = temp.path();

    let runtime = |id: &str, after: &str| {
        format!(
            "import {{ defineRuntime }} from \"aruna/server\";\n\
             export const {id}Runtime = defineRuntime({{\n\
             \x20 id: \"{id}\",\n{after}\
             \x20 start() {{}},\n\
             }});\n"
        )
    };

    // The shape a real game declares: the boot order lives in `after` edges
    // rather than in a hand-written bootstrap script.
    write_file(root, "src/domains/score/runtime.ts", &runtime("score", ""));
    write_file(
        root,
        "src/domains/grab/runtime.ts",
        &runtime("grab", "  after: [\"score\"],\n"),
    );
    write_file(
        root,
        "src/domains/emote/runtime.ts",
        &runtime("emote", "  after: [\"grab\"],\n"),
    );

    let mut input = compiler_input(root);
    input.config.entries = EntriesMode::Generated;
    input.write_manifest = false;
    input.write_generated = true;
    let output = check_project(input);

    assert!(output.ok, "{:?}", diagnostic_codes(&output));

    // Recorded in resolved boot order, not discovery order.
    let ids: Vec<&str> = output
        .manifest
        .runtimes
        .iter()
        .map(|entry| entry.id.as_str())
        .collect();
    assert_eq!(ids, vec!["score", "grab", "emote"]);

    let entry = output
        .generated_files
        .as_ref()
        .expect("generated files")
        .iter()
        .find(|file| file.path.ends_with("main.server.ts"))
        .expect("generated server entry");
    assert!(entry
        .contents
        .contains("import { createServerApp, startRuntimes } from \"aruna/server\";"));
    assert!(entry
        .contents
        .contains("startRuntimes([\n  score_runtime,\n  grab_runtime,\n  emote_runtime,\n]);"));
}

#[test]
fn rejects_a_runtime_after_edge_that_names_no_runtime() {
    use aruna_compiler::EntriesMode;

    let temp = TempDir::new().unwrap();
    let root = temp.path();
    write_file(
        root,
        "src/domains/round/runtime.ts",
        "import { defineRuntime } from \"aruna/server\";\n\
         export const roundRuntime = defineRuntime({\n\
         \x20 id: \"round\",\n\
         \x20 after: [\"playtime\"],\n\
         \x20 start() {},\n\
         });\n",
    );

    let mut input = compiler_input(root);
    input.config.entries = EntriesMode::Generated;
    input.write_manifest = false;
    let output = check_project(input);

    // A boot-order mistake used to surface only in Studio; it fails the build now.
    assert!(!output.ok);
    assert!(diagnostic_codes(&output).contains(&"aruna::582".to_string()));
}

#[test]
fn defaults_the_contract_gate_settings() {
    // The JS side always sends the normalized config, but a config without the
    // section (direct crate use) must still mean "gate on, error".
    let config: aruna_compiler::ArunaConfig = serde_json::from_str("{}").unwrap();

    assert_eq!(config.contract.snapshot, "aruna.contract.json");
    assert_eq!(config.strict.store_compatibility, StrictSeverity::Error);
    // The other strict options keep their warning default.
    assert_eq!(config.strict.domain_boundary, StrictSeverity::Warning);
}

#[test]
fn reads_the_contract_gate_settings() {
    let config: aruna_compiler::ArunaConfig = serde_json::from_str(
        r#"{
  "contract": { "snapshot": "contracts/shipped.json" },
  "strict": { "storeCompatibility": "off" }
}"#,
    )
    .unwrap();

    assert_eq!(config.contract.snapshot, "contracts/shipped.json");
    assert_eq!(config.strict.store_compatibility, StrictSeverity::Off);
}

#[test]
fn allocates_the_contract_gate_diagnostic_codes() {
    assert_eq!(
        aruna_compiler::diagnostic_meta("aruna::578"),
        Some(("store-incompatible-change", DiagnosticSeverity::Error))
    );
    assert_eq!(
        aruna_compiler::diagnostic_meta("aruna::579"),
        Some(("contract-snapshot-invalid", DiagnosticSeverity::Error))
    );
}

#[test]
fn records_store_schema_metadata_for_the_contract() {
    // The gate compares exactly these fields, so the compiler must record the
    // version, migrate presence, and numeric widths it compares on.
    let temp = TempDir::new().unwrap();
    let root = temp.path();

    write_file(
        root,
        "src/server/store.ts",
        r#"
import { definePlayerStore } from "aruna/server";
import { schema } from "aruna/schema";

export const profile = definePlayerStore({
  id: "player.profile",
  version: 3,
  schema: schema.object({
    coins: schema.u8(),
    title: schema.string().default("rookie"),
  }),
  defaultValue: () => ({ coins: 0, title: "rookie" }),
  migrate: (stored) => stored as never,
});
"#,
    );

    let output = check_project(compiler_input(root));

    assert!(output.ok);
    let store = &output.manifest.stores[0];
    assert_eq!(store.version, 3);
    assert!(store.has_migrate);
    let schema = serde_json::to_value(store.schema.as_ref().unwrap()).unwrap();
    assert_eq!(schema["properties"]["coins"]["numericFormat"], "u8");
    assert_eq!(schema["properties"]["title"]["kind"], "optional");
}

fn signal_output(source: &str) -> aruna_compiler::CompilerOutput {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    write_file(root, "src/shared/signals.ts", source);
    check_project(compiler_input(root))
}

#[test]
fn computes_the_largest_binary_frame_of_a_bounded_payload() {
    let output = signal_output(
        r#"
import { defineSignal } from "aruna/server";
import { schema } from "aruna/schema";

export const hit = defineSignal({
  id: "fx.hit",
  unreliable: true,
  wire: "binary",
  payload: schema.object({
    at: schema.vector3(),
    by: schema.string().maxLength(16),
    tags: schema.array(schema.u8()).maxItems(4),
    kind: schema.enum(["melee", "ranged"]),
    crit: schema.optional(schema.boolean()),
    label: schema.union([schema.string().length(10), schema.number()]),
  }),
});
"#,
    );

    assert!(output.ok, "{:?}", output.diagnostics);
    let signal = &output.manifest.signals[0];
    assert_eq!(signal.wire.as_deref(), Some("binary"));
    // vector3 12 + string 4+16 + array 4+4x1 + enum 4 + optional 1+1
    // + union 4+max(4+10, 8) = 64, plus the 4-byte frame header.
    assert_eq!(signal.max_encoded_bytes, Some(68));
    let json = serde_json::to_value(signal).unwrap();
    assert_eq!(json["maxEncodedBytes"], 68);
    assert_eq!(json["payloadSchema"]["properties"]["by"]["maxLength"], 16);
    assert_eq!(json["payloadSchema"]["properties"]["tags"]["maxItems"], 4);
}

#[test]
fn warns_on_an_unreliable_signal_with_an_unbounded_payload() {
    let output = signal_output(
        r#"
import { defineSignal } from "aruna/server";
import { schema } from "aruna/schema";

export const chat = defineSignal({
  id: "chat.said",
  unreliable: true,
  payload: schema.object({ text: schema.string() }),
});

export const scores = defineSignal({
  id: "board.scores",
  unreliable: true,
  payload: schema.record(schema.u32()),
});

// Reliable: no size check at all.
export const log = defineSignal({
  id: "log.line",
  payload: schema.object({ text: schema.string() }),
});
"#,
    );

    assert_eq!(
        diagnostic_codes(&output),
        vec!["aruna::510".to_string(), "aruna::510".to_string()]
    );
    assert!(output.ok, "an unbounded payload only warns");
    assert_eq!(output.manifest.signals[0].max_encoded_bytes, None);
}

#[test]
fn errors_when_an_unreliable_payload_can_exceed_the_limit() {
    // The same 4 + 813-byte payload. As a table its floor plus the wire frame
    // (8 + 75 for "fx.table") is exactly the 900-byte limit: not over, but too
    // close to trust (aruna::513). The binary frame adds its 4-byte header, and
    // with its wire frame (9 + 75) goes over.
    let output = signal_output(
        r#"
import { defineSignal } from "aruna/server";
import { schema } from "aruna/schema";

export const table = defineSignal({
  id: "fx.table",
  unreliable: true,
  payload: schema.array(schema.u8()).maxItems(813),
});

export const binary = defineSignal({
  id: "fx.binary",
  unreliable: true,
  wire: "binary",
  payload: schema.array(schema.u8()).maxItems(813),
});
"#,
    );

    let mut found: Vec<(String, String)> = output
        .diagnostics
        .iter()
        .map(|diagnostic| (diagnostic.code.clone(), diagnostic.message.clone()))
        .collect();
    found.sort();
    assert_eq!(found.len(), 2, "{found:?}");
    assert_eq!(found[0].0, "aruna::511");
    assert!(found[0].1.contains("fx.binary"));
    assert!(found[0].1.contains("905 bytes"));
    assert_eq!(found[1].0, "aruna::513");
    assert!(found[1].1.contains("fx.table"));
    assert!(found[1].1.contains("at least 900 bytes"));
    assert!(!output.ok);
}

#[test]
fn counts_the_wire_frame_toward_the_unreliable_limit() {
    // An 868-byte binary frame fits under 900 on its own; with "fx.burst" (8)
    // and the 75-byte wire frame allowance the message is 951 bytes.
    let output = signal_output(
        r#"
import { defineSignal } from "aruna/server";
import { schema } from "aruna/schema";

export const burst = defineSignal({
  id: "fx.burst",
  unreliable: true,
  wire: "binary",
  payload: schema.array(schema.u8()).maxItems(860),
});
"#,
    );

    assert_eq!(diagnostic_codes(&output), vec!["aruna::511".to_string()]);
    let diagnostic = &output.diagnostics[0];
    assert!(diagnostic.message.contains("951 bytes"), "{}", diagnostic.message);
    let details = diagnostic.details.as_deref().unwrap_or_default();
    assert!(details.contains("868 bytes"), "{details}");
    assert!(details.contains("wire frame (83 bytes)"), "{details}");
    // The manifest still records the binary frame alone; the runtime adds the
    // wire frame.
    assert_eq!(output.manifest.signals[0].max_encoded_bytes, Some(868));
}

#[test]
fn recommends_binary_when_a_table_payload_nears_the_unreliable_limit() {
    // Table floors, wire frame included (7-byte ids + 75): 4 + 599 + 82 = 685
    // is over 75% of 900 (675); 4 + 583 + 82 = 669 is not. A binary frame of
    // the same size (4 + 4 + 595 + 82) is exact, so it is not warned about.
    let output = signal_output(
        r#"
import { defineSignal } from "aruna/server";
import { schema } from "aruna/schema";

export const near = defineSignal({
  id: "fx.near",
  unreliable: true,
  payload: schema.array(schema.u8()).maxItems(599),
});

export const under = defineSignal({
  id: "fx.unde",
  unreliable: true,
  payload: schema.array(schema.u8()).maxItems(583),
});

export const exact = defineSignal({
  id: "fx.exac",
  unreliable: true,
  wire: "binary",
  payload: schema.array(schema.u8()).maxItems(595),
});
"#,
    );

    assert_eq!(diagnostic_codes(&output), vec!["aruna::513".to_string()]);
    let diagnostic = &output.diagnostics[0];
    assert_eq!(diagnostic.name, "unreliable-signal-payload-near-limit");
    assert!(diagnostic.message.contains("fx.near"));
    assert!(diagnostic.message.contains("at least 685 bytes"));
    assert!(diagnostic.suggestion.as_deref().unwrap_or_default().contains("wire: \"binary\""));
    assert!(output.ok, "near the limit only warns");
}

#[test]
fn rejects_an_invalid_signal_wire() {
    let output = signal_output(
        r#"
import { defineSignal } from "aruna/server";
import { schema } from "aruna/schema";

export const json = defineSignal({
  id: "fx.json",
  wire: "json",
  payload: schema.object({ n: schema.number() }),
});

export const noPayload = defineSignal({
  id: "fx.empty",
  wire: "binary",
});

export const withInstance = defineSignal({
  id: "fx.part",
  wire: "binary",
  payload: schema.object({ part: schema.instance() }),
});
"#,
    );

    assert_eq!(
        diagnostic_codes(&output),
        vec![
            "aruna::512".to_string(),
            "aruna::512".to_string(),
            "aruna::512".to_string()
        ]
    );
    assert!(output.manifest.signals.iter().all(|signal| signal.wire.is_none()));
}

fn write_resource_project(root: &Path) {
    write_file(
        root,
        "src/domains/quests/resources.ts",
        r#"
import { defineResource } from "aruna/server";
import { schema } from "aruna/schema";

export const questProgress = defineResource({
  id: "quests.progress",
  schema: schema.object({ quest: schema.string().maxLength(32), step: schema.u16() }),
  load(ctx) {
    return { quest: "intro", step: 0 };
  },
});

export const bossHealth = defineResource({
  id: "encounter.boss",
  scope: "global",
  schema: schema.object({ health: schema.u16() }),
  load: () => ({ health: 100 }),
});
"#,
    );
    write_file(
        root,
        "src/client/hud.ts",
        r#"
import { questProgress, type Resources } from "$aruna/resources/client";

export const hud = (value: Resources["quests.progress"]) => value.step;
export const subscribe = () => questProgress.subscribe();
"#,
    );
    write_file(
        root,
        "src/server/boot.ts",
        r#"
import { resources } from "$aruna/resources/server";

export const registry = resources;
"#,
    );
}

#[test]
fn generates_resource_bindings_and_a_server_registry() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    write_resource_project(root);

    let output = check_project(CompilerInput {
        write_generated: true,
        ..compiler_input(root)
    });
    assert!(output.ok, "{:?}", output.diagnostics);
    assert!(output.diagnostics.is_empty(), "{:?}", diagnostic_codes(&output));

    let ids: Vec<&str> = output.manifest.resources.iter().map(|resource| resource.id.as_str()).collect();
    assert_eq!(ids, vec!["encounter.boss", "quests.progress"]);
    let resource_module = output
        .manifest
        .modules
        .iter()
        .find(|module| module.path == "src/domains/quests/resources.ts")
        .unwrap();
    assert_eq!(resource_module.kind, ModuleKind::Server);

    let generated = output.generated_files.expect("generated files");
    let client = generated
        .iter()
        .find(|file| file.path == "src/.aruna/shared/resources.client.generated.ts")
        .expect("client bindings");
    assert_eq!(
        client.contents,
        "// Generated by Aruna. Do not edit by hand.\n// Source: Aruna resource manifest v1\n\nimport { resourceBinding, type ResourceBinding } from \"aruna/client\";\n\nexport type BossHealthValue = { health: number; };\n\nexport const bossHealth: ResourceBinding<BossHealthValue> = resourceBinding(\"encounter.boss\");\n\nexport type QuestProgressValue = { quest: string; step: number; };\n\nexport const questProgress: ResourceBinding<QuestProgressValue> = resourceBinding(\"quests.progress\");\n\nexport type Resources = { readonly \"encounter.boss\": BossHealthValue; readonly \"quests.progress\": QuestProgressValue; };\n"
    );
    let server = generated
        .iter()
        .find(|file| file.path == "src/.aruna/server/resources.server.generated.ts")
        .expect("server registry");
    assert!(server.contents.contains(
        "import { questProgress as src_domains_quests_resources_questProgress } from \"../../domains/quests/resources\";"
    ));
    assert!(server
        .contents
        .contains("  \"quests.progress\": src_domains_quests_resources_questProgress,"));
}

#[test]
fn resources_enter_the_contract_hash_only_when_declared() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    write_file(
        root,
        "src/domains/shop/actions.ts",
        "import { defineAction } from \"aruna/server\";\nexport const ping = defineAction({ id: \"shop.ping\", run() { return undefined; } });\n",
    );
    let hash_of = |output: &aruna_compiler::CompilerOutput| {
        output
            .generated_files
            .as_ref()
            .unwrap()
            .iter()
            .find(|file| file.path.ends_with("actions.client.generated.ts"))
            .unwrap()
            .contents
            .lines()
            .find(|line| line.starts_with("export const contractHash"))
            .unwrap()
            .to_string()
    };
    let without = check_project(CompilerInput { write_generated: true, ..compiler_input(root) });
    write_resource_project(root);
    let with = check_project(CompilerInput { write_generated: true, ..compiler_input(root) });
    assert_ne!(hash_of(&without), hash_of(&with));
}

#[test]
fn keeps_resource_definitions_off_the_client() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    write_resource_project(root);
    write_file(
        root,
        "src/client/leak.ts",
        "import { questProgress } from \"../domains/quests/resources\";\nexport const leak = questProgress;\n",
    );
    write_file(
        root,
        "src/shared/registry.ts",
        "import { resources } from \"$aruna/resources/server\";\nexport const shared = resources;\n",
    );

    let output = check_project(compiler_input(root));
    let mut codes = diagnostic_codes(&output);
    codes.sort();
    assert_eq!(codes, vec!["aruna::300".to_string(), "aruna::303".to_string()]);
}

#[test]
fn reports_duplicate_resource_ids_and_colliding_bindings() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let definition = |id: &str, name: &str| {
        format!(
            "import {{ defineResource }} from \"aruna/server\";\nimport {{ schema }} from \"aruna/schema\";\nexport const {name} = defineResource({{ id: \"{id}\", schema: schema.u8(), load: () => 1 }});\n"
        )
    };
    write_file(root, "src/server/a.ts", &definition("same.id", "first"));
    write_file(root, "src/server/b.ts", &definition("same.id", "second"));
    write_file(root, "src/server/c.ts", &definition("c.one", "progress"));
    write_file(root, "src/server/d.ts", &definition("d.two", "progress"));

    let output = check_project(CompilerInput {
        write_generated: true,
        ..compiler_input(root)
    });
    let codes = diagnostic_codes(&output);
    assert!(codes.contains(&"aruna::587".to_string()), "{codes:?}");
    assert!(codes.contains(&"aruna::590".to_string()), "{codes:?}");
    assert_eq!(output.manifest.resources.len(), 3);
}

#[test]
fn a_rebuild_with_nothing_changed_rewrites_no_generated_file() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    write_resource_project(root);
    write_file(
        root,
        "src/domains/shop/actions.ts",
        "import { defineAction } from \"aruna/server\";\nexport const ping = defineAction({ id: \"shop.ping\", run() { return undefined; } });\n",
    );
    let build = || {
        check_project(CompilerInput {
            write_generated: true,
            ..compiler_input(root)
        })
    };
    let first = build();
    assert!(first.ok, "{:?}", first.diagnostics);
    let generated = root.join("src/.aruna");
    let mtimes = |dir: &Path| {
        let mut found = BTreeMap::new();
        for entry in walk(dir) {
            found.insert(entry.clone(), fs::metadata(&entry).unwrap().modified().unwrap());
        }
        found
    };
    fn walk(dir: &Path) -> Vec<std::path::PathBuf> {
        let mut files = Vec::new();
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                files.extend(walk(&path));
            } else {
                files.push(path);
            }
        }
        files
    }
    let before = mtimes(&generated);
    assert!(before.len() >= 5, "{before:?}");
    std::thread::sleep(std::time::Duration::from_millis(20));
    let second = build();
    assert_eq!(second.generated_files, first.generated_files);
    assert_eq!(mtimes(&generated), before);

    // An edit rewrites only what it changes.
    write_file(
        root,
        "src/domains/shop/actions.ts",
        "import { defineAction } from \"aruna/server\";\nexport const ping = defineAction({ id: \"shop.pong\", run() { return undefined; } });\n",
    );
    std::thread::sleep(std::time::Duration::from_millis(20));
    build();
    let after = mtimes(&generated);
    let changed: Vec<String> = after
        .iter()
        .filter(|(path, time)| before.get(*path) != Some(time))
        .map(|(path, _)| path.strip_prefix(&generated).unwrap().to_string_lossy().replace('\\', "/"))
        .collect();
    assert!(changed.contains(&"shared/actions.client.generated.ts".to_string()), "{changed:?}");
    assert!(changed.contains(&"manifest.json".to_string()), "{changed:?}");
    // The resources did not change, but the contract hash in the action files
    // did; the resource files carry no hash, so they stay as they were.
    assert!(!changed.contains(&"shared/resources.client.generated.ts".to_string()), "{changed:?}");
}
