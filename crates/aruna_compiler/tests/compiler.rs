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
