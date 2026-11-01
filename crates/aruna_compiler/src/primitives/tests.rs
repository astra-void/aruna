// Discovery tests for the built-in primitives, through the public
// `collect_*_definitions` entry points.
use super::*;
use crate::diagnostics::ArunaDiagnostic;
use crate::schema_metadata::*;
use std::path::Path;
use std::collections::BTreeMap;
use tempfile::TempDir;

fn write_file(root: &Path, relative: &str, contents: &str) -> std::path::PathBuf {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(&path, contents).unwrap();
    path
}

fn collect_single_action(source: &str) -> (ArunaActionRecord, Vec<ArunaDiagnostic>) {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let path = write_file(root, "src/action.ts", source);

    let result = collect_action_definitions(root, &path, &std::fs::read_to_string(&path).unwrap())
        .unwrap();

    assert_eq!(result.actions.len(), 1);
    (result.actions[0].clone(), result.diagnostics)
}

fn collect_stores(source: &str) -> StoreDiscoveryResult {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let path = write_file(root, "src/stores.ts", source);
    collect_store_definitions(root, &path, &std::fs::read_to_string(&path).unwrap()).unwrap()
}

#[test]
fn collects_store_and_player_store_definitions() {
    let result = collect_stores(
        r#"
import { defineStore, definePlayerStore } from "aruna/server";
import { schema } from "aruna/schema";

export const settings = defineStore({
  id: "game.settings",
  scope: "live",
  schema: schema.object({ musicEnabled: schema.boolean() }),
  defaultValue: { musicEnabled: true },
});

export const profile = definePlayerStore({
  id: "player.profile",
  schema: schema.object({ coins: schema.u32() }),
  defaultValue: () => ({ coins: 0 }),
});
"#,
    );

    assert!(result.diagnostics.is_empty());
    assert_eq!(result.stores.len(), 2);
    assert!(result.store_files.contains("src/stores.ts"));

    let settings = &result.stores[0];
    assert_eq!(settings.id, "game.settings");
    assert_eq!(settings.export_name, "settings");
    assert_eq!(settings.kind, ArunaStoreKind::Store);
    assert_eq!(settings.scope.as_deref(), Some("live"));
    assert_eq!(settings.version, 1);
    assert!(!settings.has_migrate);
    assert!(settings.schema.is_some());

    let profile = &result.stores[1];
    assert_eq!(profile.id, "player.profile");
    assert_eq!(profile.kind, ArunaStoreKind::PlayerStore);
}

#[test]
fn records_the_declared_version_and_migrate() {
    let result = collect_stores(
        r#"
import { definePlayerStore } from "aruna/server";
import { schema } from "aruna/schema";

export const profile = definePlayerStore({
  id: "player.profile",
  version: 3,
  schema: schema.object({ coins: schema.u32() }),
  defaultValue: { coins: 0 },
  migrate: (stored, from) => (from === 2 ? (stored as { coins: number }) : undefined),
});
"#,
    );

    assert!(result.diagnostics.is_empty());
    assert_eq!(result.stores[0].version, 3);
    assert!(result.stores[0].has_migrate);
}

#[test]
fn reports_a_bumped_version_without_a_migrate() {
    let result = collect_stores(
        r#"
import { defineStore } from "aruna/server";
import { schema } from "aruna/schema";

export const settings = defineStore({
  id: "game.settings",
  version: 2,
  schema: schema.object({ musicEnabled: schema.boolean() }),
  defaultValue: { musicEnabled: true },
});
"#,
    );

    // Still discovered — the store works, it just cannot read its own history.
    assert_eq!(result.stores.len(), 1);
    assert_eq!(result.diagnostics.len(), 1);
    assert_eq!(result.diagnostics[0].code, "aruna::577");
}

fn store_fields(source_schema: &str) -> BTreeMap<String, ArunaSchemaMetadata> {
    store_fields_after("", source_schema)
}

// `prelude` is module-level code the schema can refer to (a `const` bound).
fn store_fields_after(prelude: &str, source_schema: &str) -> BTreeMap<String, ArunaSchemaMetadata> {
    let result = collect_stores(&format!(
        r#"
import {{ defineStore }} from "aruna/server";
import {{ schema }} from "aruna/schema";
{prelude}
export const profile = defineStore({{
  id: "player.profile",
  schema: {source_schema},
  defaultValue: {{}},
}});
"#
    ));
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    result.stores[0]
        .schema
        .as_ref()
        .expect("expected store schema")
        .properties
        .clone()
        .expect("expected object properties")
}

#[test]
fn records_each_literal_constraint_on_the_schema_it_bounds() {
    let fields = store_fields(
        r#"schema.object({
name: schema.string().minLength(2).maxLength(16),
plain: schema.string(),
code: schema.string().length(6),
level: schema.number().min(0).max(99.5).int(),
debt: schema.number().min(-10),
tags: schema.array(schema.string()).minItems(1).maxItems(8),
slots: schema.array(schema.string()).length(4),
inventory: schema.record(schema.number()).maxEntries(32),
  })"#,
    );

    assert_eq!((fields["name"].min_length, fields["name"].max_length), (Some(2), Some(16)));
    assert_eq!(
        fields["plain"],
        ArunaSchemaMetadata { kind: "string".to_string(), ..Default::default() }
    );
    // `.length(n)` is both ends.
    assert_eq!((fields["code"].min_length, fields["code"].max_length), (Some(6), Some(6)));
    assert_eq!(fields["level"].min, Some(0.into()));
    assert_eq!(fields["level"].max.as_ref().and_then(|max| max.as_f64()), Some(99.5));
    assert!(fields["level"].int);
    assert_eq!(fields["debt"].min, Some((-10).into()));
    assert_eq!((fields["tags"].min_items, fields["tags"].max_items), (Some(1), Some(8)));
    assert_eq!((fields["slots"].min_items, fields["slots"].max_items), (Some(4), Some(4)));
    assert_eq!(fields["inventory"].max_entries, Some(32));
    // Every bound was readable, so nothing is left to hash.
    for field in fields.values() {
        assert_eq!(field.constraints_hash, None);
        assert!(field.dynamic_constraints.is_empty());
    }
}

#[test]
fn keeps_the_tighter_of_two_bounds() {
    let fields = store_fields(
        r#"schema.object({
name: schema.string().maxLength(40).maxLength(20).minLength(1).minLength(3),
score: schema.number().min(0).min(-5).max(10).max(100),
  })"#,
    );

    assert_eq!((fields["name"].min_length, fields["name"].max_length), (Some(3), Some(20)));
    assert_eq!((fields["score"].min.clone(), fields["score"].max.clone()), (Some(0.into()), Some(10.into())));
}

#[test]
fn counts_refinements_and_hashes_their_predicates() {
    let fields = store_fields(
        r#"schema.object({
level: schema.number().min(0).refine((value) => value % 2 === 0, "even"),
  })"#,
    );
    assert_eq!(fields["level"].refinements, 1);
    let level = fields["level"].constraints_hash.as_deref().expect("expected a hash");
    assert_eq!(level.len(), 16);

    // Reformatting the chain is not a change, and neither is moving a bound
    // within it: bounds are recorded as values, not hashed.
    let reformatted = store_fields(
        r#"schema.object({ level: schema.number()
  .refine(
    (value) => value % 2 === 0,
    "even",
  )
  .min( 0 ) })"#,
    );
    assert_eq!(reformatted["level"].constraints_hash.as_deref(), Some(level));

    // Another predicate is.
    let changed = store_fields(
        r#"schema.object({ level: schema.number().min(0).refine((value) => value % 3 === 0, "even") })"#,
    );
    assert_ne!(changed["level"].constraints_hash.as_deref(), Some(level));
}

#[test]
fn names_a_bound_it_cannot_read_and_reads_a_const_one() {
    let fields = store_fields_after(
        "const NAME_LIMIT = 20;\nconst FLOOR = -NAME_LIMIT;\nfunction limit(): number { return 5; }\n",
        r#"schema.object({
fromConst: schema.string().maxLength(NAME_LIMIT),
negated: schema.number().min(FLOOR),
computed: schema.string().maxLength(limit()),
mixed: schema.string().maxLength(40).maxLength(limit()),
  })"#,
    );

    assert_eq!(fields["fromConst"].max_length, Some(20));
    assert!(fields["fromConst"].dynamic_constraints.is_empty());
    assert_eq!(fields["negated"].min, Some((-20).into()));

    // Bounded, by an amount the compiler cannot read.
    assert_eq!(fields["computed"].max_length, None);
    assert_eq!(fields["computed"].dynamic_constraints, vec!["maxLength".to_string()]);
    assert!(fields["computed"].constraints_hash.is_some());

    // The literal bound is kept; the computed one is still named.
    assert_eq!(fields["mixed"].max_length, Some(40));
    assert_eq!(fields["mixed"].dynamic_constraints, vec!["maxLength".to_string()]);
}

#[test]
fn bounds_a_max_chars_string_at_four_bytes_a_character() {
    let fields = store_fields(
        r#"schema.object({
chat: schema.string().maxChars(50),
both: schema.string().maxChars(50).maxLength(120),
  })"#,
    );

    // Characters and bytes are recorded apart; the payload bound combines them.
    assert_eq!((fields["chat"].max_chars, fields["chat"].max_length), (Some(50), None));
    assert_eq!(crate::payload_size::max_string_bytes(&fields["chat"]), Some(200));
    assert_eq!((fields["both"].max_chars, fields["both"].max_length), (Some(50), Some(120)));
    assert_eq!(crate::payload_size::max_string_bytes(&fields["both"]), Some(120));
}

#[test]
fn rejects_a_store_without_a_schema() {
    let result = collect_stores(
        r#"
import { defineStore } from "aruna/server";

export const settings = defineStore({
  id: "game.settings",
  defaultValue: { musicEnabled: true },
});
"#,
    );

    assert!(result.stores.is_empty());
    assert_eq!(result.diagnostics[0].code, "aruna::571");
    // The file is still marked as a store module, so the boundary rules keep
    // the client away from it even while the definition is broken.
    assert!(result.store_files.contains("src/stores.ts"));
}

#[test]
fn rejects_a_store_without_a_default_value() {
    let result = collect_stores(
        r#"
import { defineStore } from "aruna/server";
import { schema } from "aruna/schema";

export const settings = defineStore({
  id: "game.settings",
  schema: schema.object({ musicEnabled: schema.boolean() }),
});
"#,
    );

    assert!(result.stores.is_empty());
    assert_eq!(result.diagnostics[0].code, "aruna::576");
}

#[test]
fn rejects_a_non_literal_store_id() {
    let result = collect_stores(
        r#"
import { defineStore } from "aruna/server";
import { schema } from "aruna/schema";

const id = "game.settings";

export const settings = defineStore({
  id,
  schema: schema.object({ musicEnabled: schema.boolean() }),
  defaultValue: { musicEnabled: true },
});
"#,
    );

    assert!(result.stores.is_empty());
    assert_eq!(result.diagnostics[0].code, "aruna::570");
}

#[test]
fn rejects_an_invalid_store_version() {
    let result = collect_stores(
        r#"
import { defineStore } from "aruna/server";
import { schema } from "aruna/schema";

export const settings = defineStore({
  id: "game.settings",
  version: 0,
  schema: schema.object({ musicEnabled: schema.boolean() }),
  defaultValue: { musicEnabled: true },
});
"#,
    );

    assert_eq!(result.diagnostics[0].code, "aruna::575");
}

fn collect_signals(source: &str) -> SignalDiscoveryResult {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let path = write_file(root, "src/signals.ts", source);
    collect_signal_definitions(root, &path, &std::fs::read_to_string(&path).unwrap()).unwrap()
}

#[test]
fn collects_define_signal_with_payload_schema() {
    let result = collect_signals(
        r#"
import { defineSignal } from "aruna/server";
import { schema } from "aruna/schema";

export const damaged = defineSignal({
  id: "combat.damaged",
  payload: schema.object({ amount: schema.u16(), source: schema.string() }),
});

export const tick = defineSignal({ id: "world.tick" });
"#,
    );

    assert!(result.diagnostics.is_empty());
    assert_eq!(result.signals.len(), 2);

    let damaged = &result.signals[0];
    assert_eq!(damaged.id, "combat.damaged");
    assert_eq!(damaged.export_name, "damaged");
    assert!(damaged.has_payload_schema);

    let tick = &result.signals[1];
    assert_eq!(tick.id, "world.tick");
    assert!(!tick.has_payload_schema);
    assert_eq!(tick.payload_schema, None);
    assert!(!tick.unreliable);
}

#[test]
fn records_the_unreliable_signal_flag() {
    let result = collect_signals(
        r#"
import { defineSignal } from "aruna/server";
import { schema } from "aruna/schema";

export const moved = defineSignal({
  id: "player.moved",
  unreliable: true,
  payload: schema.object({ x: schema.f32(), y: schema.f32(), z: schema.f32() }),
});

export const broken = defineSignal({
  id: "player.broken",
  unreliable: "yes",
});
"#,
    );

    assert_eq!(result.signals.len(), 2);
    let moved = result.signals.iter().find(|s| s.id == "player.moved").unwrap();
    assert!(moved.unreliable);

    // Non-literal flag is a hard error and falls back to reliable.
    let broken = result.signals.iter().find(|s| s.id == "player.broken").unwrap();
    assert!(!broken.unreliable);
    assert!(result
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.details.as_deref().is_some_and(|d| d.contains("broken"))
            && diagnostic.message.contains("invalid unreliable option")));
}

#[test]
fn parses_record_and_tuple_schemas() {
    let (action, diagnostics) = collect_single_action(
        r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const syncInventory = defineAction({
  id: "inventory.sync",
  input: schema.object({
counts: schema.record(schema.u16()),
position: schema.tuple([schema.number(), schema.number()]),
  }),
  run() {
return undefined;
  },
});
"#,
    );

    assert!(diagnostics.is_empty());
    let input = action.input_schema.expect("input schema");
    let properties = input.properties.expect("object properties");

    let counts = properties.get("counts").expect("counts field");
    assert_eq!(counts.kind, "record");
    assert_eq!(counts.items.as_deref().map(|item| item.kind.as_str()), Some("number"));

    let position = properties.get("position").expect("position field");
    assert_eq!(position.kind, "tuple");
    let members = position.members.as_ref().expect("tuple members");
    assert_eq!(members.len(), 2);
    assert!(members.iter().all(|member| member.kind == "number"));
}

#[test]
fn reports_record_without_value_schema() {
    let (_, diagnostics) = collect_single_action_allow_empty(
        r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const broken = defineAction({
  id: "inventory.broken",
  input: schema.record(),
  run() {
return undefined;
  },
});
"#,
    );

    assert!(diagnostics.iter().any(|d| d
        .details
        .as_deref()
        .is_some_and(|details| details.contains("record schemas require exactly one schema argument"))));
}

fn collect_single_action_allow_empty(source: &str) -> (Option<ArunaActionRecord>, Vec<ArunaDiagnostic>) {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let path = write_file(root, "src/action.ts", source);

    let result = collect_action_definitions(root, &path, &std::fs::read_to_string(&path).unwrap())
        .unwrap();

    (result.actions.first().cloned(), result.diagnostics)
}

#[test]
fn reports_signal_missing_id() {
    let result = collect_signals(
        r#"
import { defineSignal } from "aruna/server";

export const broken = defineSignal({});
"#,
    );

    assert!(result.signals.is_empty());
    assert!(result.diagnostics.iter().any(|d| d.code == "aruna::560"));
}

fn schema(kind: &str) -> ArunaSchemaMetadata {
    ArunaSchemaMetadata {
        kind: kind.to_string(),
        ..Default::default()
    }
}

fn object_schema(properties: &[(&str, ArunaSchemaMetadata)]) -> ArunaSchemaMetadata {
    ArunaSchemaMetadata {
        kind: "object".to_string(),
        properties: Some(
            properties
                .iter()
                .map(|(key, value)| (key.to_string(), value.clone()))
                .collect::<BTreeMap<_, _>>(),
        ),
        ..Default::default()
    }
}

#[test]
fn collects_define_action_with_method_run_handler() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let path = write_file(
        root,
        "src/action.ts",
        r#"
import { defineAction } from "aruna/server";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  async run(ctx, input) {
return { ok: true };
  },
});
"#,
    );

    let result = collect_action_definitions(root, &path, &std::fs::read_to_string(&path).unwrap())
        .unwrap();

    assert_eq!(result.actions.len(), 1);
    assert!(result.diagnostics.is_empty());
    assert_eq!(result.actions[0].has_run, true);
    assert_eq!(result.actions[0].id, "shop.purchaseItem");
}

#[test]
fn collects_define_action_with_arrow_run_handler_property() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let path = write_file(
        root,
        "src/action.ts",
        r#"
import { defineAction } from "aruna/server";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  run: async (ctx, input) => {
return { ok: true };
  },
});
"#,
    );

    let result = collect_action_definitions(root, &path, &std::fs::read_to_string(&path).unwrap())
        .unwrap();

    assert_eq!(result.actions.len(), 1);
    assert!(result.diagnostics.is_empty());
    assert_eq!(result.actions[0].has_run, true);
    assert_eq!(result.actions[0].id, "shop.purchaseItem");
}

#[test]
fn extracts_string_schema_metadata() {
    let (action, diagnostics) = collect_single_action(
        r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: schema.string(),
  output: schema.boolean(),
  run(ctx, input) {
return true;
  },
});
"#,
    );

    assert!(diagnostics.is_empty());
    assert!(action.has_input_schema);
    assert!(action.has_output_schema);
    assert_eq!(action.input_schema, Some(schema("string")));
    assert_eq!(action.output_schema, Some(schema("boolean")));
}

#[test]
fn extracts_roblox_userdata_schema_metadata() {
    let result = collect_signals(
        r#"
import { defineSignal } from "aruna/server";
import { schema } from "aruna/schema";

export const moved = defineSignal({
  id: "world.moved",
  payload: schema.object({
position: schema.vector3(),
tint: schema.color3(),
pivot: schema.cframe(),
  }),
});
"#,
    );

    assert!(result.diagnostics.is_empty());
    let moved = &result.signals[0];
    assert_eq!(
        moved.payload_schema,
        Some(object_schema(&[
            ("pivot", schema("cframe")),
            ("position", schema("vector3")),
            ("tint", schema("color3")),
        ]))
    );
}

#[test]
fn rejects_arguments_to_userdata_schemas() {
    let (action, diagnostics) = collect_single_action(
        r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: schema.vector3(schema.number()),
  run(ctx, input) {
return true;
  },
});
"#,
    );

    assert!(action.input_schema.is_none());
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code, "aruna::553");
}

#[test]
fn extracts_number_and_boolean_schema_metadata() {
    let (action, diagnostics) = collect_single_action(
        r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: schema.number(),
  output: schema.boolean(),
  run(ctx, input) {
return true;
  },
});
"#,
    );

    assert!(diagnostics.is_empty());
    assert_eq!(action.input_schema, Some(schema("number")));
    assert_eq!(action.output_schema, Some(schema("boolean")));
}

#[test]
fn extracts_numeric_width_hint_metadata() {
    let (action, diagnostics) = collect_single_action(
        r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const move = defineAction({
  id: "player.move",
  input: schema.object({ x: schema.i16(), team: schema.u8() }),
  output: schema.f32(),
  run(ctx, input) {
return 1.0;
  },
});
"#,
    );

    assert!(diagnostics.is_empty());

    let numeric = |format: &str| ArunaSchemaMetadata {
        kind: "number".to_string(),
        numeric_format: Some(format.to_string()),
        ..Default::default()
    };

    assert_eq!(
        action.input_schema,
        Some(object_schema(&[("team", numeric("u8")), ("x", numeric("i16"))]))
    );
    assert_eq!(action.output_schema, Some(numeric("f32")));
}

#[test]
fn extracts_array_schema_metadata() {
    let (action, diagnostics) = collect_single_action(
        r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: schema.array(schema.string()),
  run(ctx, input) {
return input;
  },
});
"#,
    );

    assert!(diagnostics.is_empty());
    assert!(action.has_input_schema);
    assert_eq!(
        action.input_schema,
        Some(ArunaSchemaMetadata {
            kind: "array".to_string(),
            items: Some(Box::new(schema("string"))),
            ..Default::default()
        })
    );
}

#[test]
fn extracts_union_schema_metadata() {
    let (action, diagnostics) = collect_single_action(
        r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: schema.union([schema.string(), schema.number()]),
  run(ctx, input) {
return input;
  },
});
"#,
    );

    assert!(diagnostics.is_empty());
    assert!(action.has_input_schema);
    assert_eq!(
        action.input_schema,
        Some(ArunaSchemaMetadata {
            kind: "union".to_string(),
            members: Some(vec![schema("string"), schema("number")]),
            ..Default::default()
        })
    );
}

#[test]
fn extracts_object_schema_metadata() {
    let (action, diagnostics) = collect_single_action(
        r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: schema.object({
itemId: schema.string(),
  }),
  run(ctx, input) {
return input;
  },
});
"#,
    );

    assert!(diagnostics.is_empty());
    assert_eq!(
        action.input_schema,
        Some(object_schema(&[("itemId", schema("string"))]))
    );
}

#[test]
fn reports_unsupported_schema_expressions() {
    let (action, diagnostics) = collect_single_action(
        r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

function getSchema() {
  return schema.string();
}

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: schema.array(getSchema()),
  run(ctx, input) {
return input;
  },
});
"#,
    );

    assert!(action.input_schema.is_none());
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code, "aruna::553");
    assert_eq!(diagnostics[0].name, "action-input-schema-invalid");
    assert_eq!(diagnostics[0].severity, crate::diagnostics::DiagnosticSeverity::Warning);
    assert!(diagnostics[0].message.contains("invalid input schema"));
}

#[test]
fn resolves_action_schema_extracted_to_a_const() {
    let (action, diagnostics) = collect_single_action(
        r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

const purchaseInput = schema.object({ itemId: schema.string() });

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: purchaseInput,
  run(ctx, input) {
return input;
  },
});
"#,
    );

    assert!(diagnostics.is_empty());
    assert!(action.has_input_schema);
    assert_eq!(
        action.input_schema,
        Some(object_schema(&[("itemId", schema("string"))]))
    );
}

#[test]
fn resolves_signal_payload_schema_extracted_to_a_const() {
    let result = collect_signals(
        r#"
import { defineSignal } from "aruna/server";
import { schema } from "aruna/schema";

const damagePayload = schema.object({ amount: schema.u16() });

export const damaged = defineSignal({
  id: "combat.damaged",
  payload: damagePayload,
});
"#,
    );

    assert!(result.diagnostics.is_empty());
    assert_eq!(result.signals.len(), 1);

    let damaged = &result.signals[0];
    assert!(damaged.has_payload_schema);

    let amount = ArunaSchemaMetadata {
        kind: "number".to_string(),
        numeric_format: Some("u16".to_string()),
        ..Default::default()
    };
    assert_eq!(
        damaged.payload_schema,
        Some(object_schema(&[("amount", amount)]))
    );
}

#[test]
fn resolves_schema_variable_nested_inside_a_schema() {
    let (action, _diagnostics) = collect_single_action(
        r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

const tag = schema.string();

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: schema.object({ tags: schema.array(tag) }),
  run(ctx, input) {
return input;
  },
});
"#,
    );

    let tags = ArunaSchemaMetadata {
        kind: "array".to_string(),
        items: Some(Box::new(schema("string"))),
        ..Default::default()
    };
    assert_eq!(action.input_schema, Some(object_schema(&[("tags", tags)])));
}

#[test]
fn follows_a_chain_of_schema_variables() {
    let (action, diagnostics) = collect_single_action(
        r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

const base = schema.string();
const alias = base;

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: alias,
  run(ctx, input) {
return input;
  },
});
"#,
    );

    assert!(diagnostics.is_empty());
    assert_eq!(action.input_schema, Some(schema("string")));
}

#[test]
fn reports_unresolved_schema_variable() {
    let (action, diagnostics) = collect_single_action(
        r#"
import { defineAction } from "aruna/server";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: missingSchema,
  run(ctx, input) {
return input;
  },
});
"#,
    );

    assert!(action.input_schema.is_none());
    assert_eq!(diagnostics.len(), 1);
    // Unresolved references are a hard error (aruna::565), not the shape
    // warning: they would silently drop typed clients and contract data.
    assert_eq!(diagnostics[0].code, "aruna::565");
    assert_eq!(diagnostics[0].severity, crate::diagnostics::DiagnosticSeverity::Error);
    assert!(diagnostics[0]
        .details
        .as_ref()
        .is_some_and(|details| details.contains("could not be resolved")));
}

#[test]
fn resolves_schema_imported_from_sibling_module() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    write_file(
        root,
        "src/domains/shop/schema.ts",
        r#"
import { schema } from "aruna/schema";

export const purchaseInput = schema.object({
  itemId: schema.string(),
  quantity: schema.u8(),
});
"#,
    );
    let path = write_file(
        root,
        "src/domains/shop/actions.ts",
        r#"
import { defineAction } from "aruna/server";
import { purchaseInput } from "./schema";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: purchaseInput,
  run(ctx, input) {
return input;
  },
});
"#,
    );

    let result =
        collect_action_definitions(root, &path, &std::fs::read_to_string(&path).unwrap())
            .unwrap();

    assert_eq!(result.diagnostics.len(), 0);
    let action = &result.actions[0];
    assert!(action.has_input_schema);
    let input_schema = action.input_schema.as_ref().expect("imported schema resolves");
    assert_eq!(input_schema.kind, "object");
}

#[test]
fn reports_import_that_is_not_a_schema() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    write_file(
        root,
        "src/domains/shop/helpers.ts",
        r#"
export function makeSchema() {
  return undefined;
}
"#,
    );
    let path = write_file(
        root,
        "src/domains/shop/actions.ts",
        r#"
import { defineAction } from "aruna/server";
import { makeSchema } from "./helpers";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: makeSchema,
  run(ctx, input) {
return input;
  },
});
"#,
    );

    let result =
        collect_action_definitions(root, &path, &std::fs::read_to_string(&path).unwrap())
            .unwrap();

    assert_eq!(result.diagnostics.len(), 1);
    assert_eq!(result.diagnostics[0].code, "aruna::565");
    assert!(result.diagnostics[0]
        .details
        .as_ref()
        .is_some_and(|details| details.contains("not a module-level const")));
    assert!(result.actions[0].input_schema.is_none());
}

#[test]
fn imported_schema_resolution_is_single_hop() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    write_file(
        root,
        "src/base.ts",
        r#"
import { schema } from "aruna/schema";

export const baseSchema = schema.string();
"#,
    );
    write_file(
        root,
        "src/middle.ts",
        r#"
import { baseSchema } from "./base";

export const reexported = baseSchema;
"#,
    );
    let path = write_file(
        root,
        "src/actions.ts",
        r#"
import { defineAction } from "aruna/server";
import { reexported } from "./middle";

export const act = defineAction({
  id: "shop.act",
  input: reexported,
  run(ctx, input) {
return input;
  },
});
"#,
    );

    let result =
        collect_action_definitions(root, &path, &std::fs::read_to_string(&path).unwrap())
            .unwrap();

    // Two hops deep: the middle module's binding is itself an import, which
    // the single-hop resolver rejects with a clear reason.
    assert_eq!(result.diagnostics.len(), 1);
    assert_eq!(result.diagnostics[0].code, "aruna::565");
    assert!(result.diagnostics[0]
        .details
        .as_ref()
        .is_some_and(|details| details.contains("not a statically analyzable schema")));
}

#[test]
fn reports_self_referential_schema_variable() {
    let result = collect_signals(
        r#"
import { defineSignal } from "aruna/server";

const loopSchema = loopSchema;

export const ticked = defineSignal({
  id: "world.ticked",
  payload: loopSchema,
});
"#,
    );

    let signal = &result.signals[0];
    assert!(signal.payload_schema.is_none());
    assert_eq!(result.diagnostics.len(), 1);
    assert_eq!(result.diagnostics[0].code, "aruna::564");
    assert!(result.diagnostics[0]
        .details
        .as_ref()
        .is_some_and(|details| details.contains("refers to itself")));
}

#[test]
fn records_declared_errors_sorted_by_name() {
    let (action, diagnostics) = collect_single_action(
        r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const buy = defineAction({
  id: "shop.buy",
  errors: {
    OutOfStock: { data: schema.object({ itemId: schema.string() }) },
    NotEnoughCoins: {},
    "Banned": {},
  },
  run(ctx) {
    throw ctx.fail("NotEnoughCoins");
  },
});
"#,
    );

    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let names: Vec<_> = action.errors.iter().map(|error| error.name.as_str()).collect();
    assert_eq!(names, vec!["Banned", "NotEnoughCoins", "OutOfStock"]);
    assert!(!action.errors[1].has_data);
    assert!(action.errors[1].data_schema.is_none());
    assert!(action.errors[2].has_data);
    assert_eq!(action.errors[2].data_schema.as_ref().map(|schema| schema.kind.as_str()), Some("object"));
}

#[test]
fn reports_an_errors_declaration_it_cannot_read() {
    let (action, diagnostics) = collect_single_action(
        r#"
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const buy = defineAction({
  id: "shop.buy",
  errors: {
    ActionValidationError: {},
    "not a name": {},
    Typo: { date: schema.string() },
    Loose: schema.object({}),
    Kept: { data: schema.number() },
  },
  run() {},
});
"#,
    );

    // Each problem is reported on its own; what could be read is kept.
    let details: Vec<_> = diagnostics
        .iter()
        .map(|diagnostic| (diagnostic.code.as_str(), diagnostic.details.clone().unwrap_or_default()))
        .collect();
    assert_eq!(details.len(), 4, "{details:?}");
    assert!(details.iter().all(|(code, _)| *code == "aruna::584"));
    assert!(details[0].1.contains("ActionValidationError is one of Aruna's own error names."));
    assert!(details[1].1.contains("not a name is not a valid error name"));
    assert!(details[2].1.contains("errors.Typo does not support the date key; only data."));
    assert!(details[3].1.contains("errors.Loose must be an object literal"));
    assert_eq!(action.errors.iter().map(|error| error.name.as_str()).collect::<Vec<_>>(), vec!["Kept"]);
}

#[test]
fn reports_errors_on_a_fire_and_forget_action() {
    let (action, diagnostics) = collect_single_action(
        r#"
import { defineAction } from "aruna/server";

export const wave = defineAction({
  id: "emote.wave",
  fireAndForget: true,
  errors: { TooSoon: {} },
  run() {},
});
"#,
    );

    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code, "aruna::584");
    assert!(action.errors.is_empty());
}

fn collect_resources(source: &str) -> ResourceDiscoveryResult {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let path = write_file(root, "src/domains/quests/resources.ts", source);
    collect_resource_definitions(root, &path, &std::fs::read_to_string(&path).unwrap()).unwrap()
}

#[test]
fn collects_resource_definitions() {
    let result = collect_resources(
        r#"
import { defineResource } from "aruna/server";
import { schema } from "aruna/schema";

const progress = schema.object({ step: schema.u16() });

export const questProgress = defineResource({
  id: "quests.progress",
  schema: progress,
  load(ctx) {
    return { step: 0 };
  },
});

export const boss = defineResource({
  id: "encounter.boss",
  scope: "global",
  schema: schema.object({ health: schema.u16() }),
  load: async () => ({ health: 1 }),
  authorize: (ctx) => true,
});
"#,
    );

    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    assert_eq!(result.resources.len(), 2);
    let boss = &result.resources[0];
    assert_eq!(boss.id, "encounter.boss");
    assert_eq!(boss.scope, "global");
    assert!(boss.has_authorize);
    let progress = &result.resources[1];
    assert_eq!(progress.id, "quests.progress");
    assert_eq!(progress.scope, "player");
    assert!(!progress.has_authorize);
    assert_eq!(progress.schema.as_ref().unwrap().kind, "object");
    assert_eq!(result.resource_files.len(), 1);
}

#[test]
fn reports_invalid_resource_definitions() {
    let result = collect_resources(
        r#"
import { defineResource } from "aruna/server";
import { schema } from "aruna/schema";

const dynamicId = "quests.dynamic";
export const a = defineResource({ id: dynamicId, schema: schema.string(), load: () => "" });
export const b = defineResource({ id: "b", scope: "team", schema: schema.string(), load: () => "" });
export const c = defineResource({ id: "c", load: () => "" });
export const d = defineResource({ id: "d", schema: schema.string() });
export const e = defineResource({ id: "e", schema: schema.string(), load: () => "", authorize: true });
export const f = defineResource({ id: "f", schema: 5, load: () => "" });
"#,
    );

    let codes: Vec<&str> = result.diagnostics.iter().map(|diagnostic| diagnostic.code.as_str()).collect();
    assert_eq!(
        codes,
        vec!["aruna::586", "aruna::586", "aruna::589", "aruna::586", "aruna::586", "aruna::588"]
    );
    // An invalid schema degrades the record; everything else drops it.
    assert_eq!(result.resources.len(), 1);
    assert_eq!(result.resources[0].id, "f");
    assert!(result.resource_files.contains("src/domains/quests/resources.ts"));
}
