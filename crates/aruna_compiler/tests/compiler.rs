use aruna_compiler::{
    check_project, classify_relative_path, CompilerInput, ConventionSet, ModuleKind,
    TsconfigResolverOptions,
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
        })
    );
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
    assert!(entry.contents.contains("import { startRuntimes } from \"aruna/server\";"));
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
