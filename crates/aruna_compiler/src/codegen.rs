use crate::actions::{
    ArunaActionRecord, ArunaSchemaLiteralMetadata, ArunaSchemaMetadata, ArunaSignalRecord,
};
use crate::config::ActionRateLimitConfig;
use crate::diagnostics::{create_diagnostic, ArunaDiagnostic};
use crate::files::normalize_path;
use crate::resolver::{
    GENERATED_CLIENT_ACTIONS_FILE, GENERATED_SERVER_ACTIONS_FILE, GENERATED_SIGNALS_FILE,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedFile {
    pub path: String,
    pub contents: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GeneratedActionOutput {
    pub files: Vec<GeneratedFile>,
    pub diagnostics: Vec<ArunaDiagnostic>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GeneratedSignalOutput {
    pub files: Vec<GeneratedFile>,
    pub diagnostics: Vec<ArunaDiagnostic>,
}

fn sanitize_identifier(input: &str) -> String {
    let mut output = String::new();

    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            output.push(ch);
        } else {
            output.push('_');
        }
    }

    if output.is_empty() {
        output.push('_');
    }

    if output
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_digit())
    {
        output.insert(0, '_');
    }

    output
}

fn pascal_case_identifier(input: &str) -> String {
    let mut output = String::new();
    let mut capitalize_next = true;

    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() {
            if output.is_empty() && ch.is_ascii_digit() {
                output.push('_');
            }

            if capitalize_next {
                output.push(ch.to_ascii_uppercase());
                capitalize_next = false;
            } else {
                output.push(ch);
            }
        } else {
            capitalize_next = true;
        }
    }

    if output.is_empty() {
        output.push('_');
    }

    output
}

fn is_valid_ts_identifier(text: &str) -> bool {
    let mut characters = text.chars();
    let Some(first) = characters.next() else {
        return false;
    };

    if !(first == '_' || first == '$' || first.is_ascii_alphabetic()) {
        return false;
    }

    characters.all(|character| {
        character == '_' || character == '$' || character.is_ascii_alphanumeric()
    })
}

fn ts_string_literal(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn render_property_key(key: &str) -> String {
    if is_valid_ts_identifier(key) {
        key.to_string()
    } else {
        ts_string_literal(key)
    }
}

fn render_literal_metadata(literal: &ArunaSchemaLiteralMetadata) -> String {
    match literal {
        ArunaSchemaLiteralMetadata::String { value } => ts_string_literal(value),
        ArunaSchemaLiteralMetadata::Number { value } => value.clone(),
        ArunaSchemaLiteralMetadata::Boolean { value } => value.to_string(),
        ArunaSchemaLiteralMetadata::Undefined => "undefined".to_string(),
    }
}

fn wrap_type_for_array(rendered: String) -> String {
    if rendered.contains(" | ") || rendered.starts_with('{') {
        format!("({rendered})")
    } else {
        rendered
    }
}

fn render_schema_metadata(schema: &ArunaSchemaMetadata) -> String {
    match schema.kind.as_str() {
        "string" => "string".to_string(),
        "number" => "number".to_string(),
        "boolean" => "boolean".to_string(),
        "literal" => schema
            .literal
            .as_ref()
            .map(render_literal_metadata)
            .unwrap_or_else(|| "unknown".to_string()),
        "array" => schema
            .items
            .as_deref()
            .map(|item| format!("{}[]", wrap_type_for_array(render_schema_metadata(item))))
            .unwrap_or_else(|| "unknown".to_string()),
        "object" => render_object_schema(schema.properties.as_ref()),
        "optional" => schema
            .inner
            .as_deref()
            .map(|inner| format!("{} | undefined", render_schema_metadata(inner)))
            .unwrap_or_else(|| "unknown".to_string()),
        "enum" => render_enum_schema(schema.values.as_ref()),
        "union" => render_union_schema(schema.members.as_ref()),
        // Roblox userdata kinds render to the native @rbxts/types globals so the
        // generated client/signal stubs are typed against the real value types.
        "vector3" => "Vector3".to_string(),
        "color3" => "Color3".to_string(),
        "cframe" => "CFrame".to_string(),
        _ => "unknown".to_string(),
    }
}

fn render_union_schema(members: Option<&Vec<ArunaSchemaMetadata>>) -> String {
    let Some(members) = members else {
        return "unknown".to_string();
    };

    if members.is_empty() {
        return "never".to_string();
    }

    members
        .iter()
        .map(render_schema_metadata)
        .collect::<Vec<_>>()
        .join(" | ")
}

fn render_enum_schema(values: Option<&Vec<ArunaSchemaLiteralMetadata>>) -> String {
    let Some(values) = values else {
        return "unknown".to_string();
    };

    if values.is_empty() {
        return "never".to_string();
    }

    values
        .iter()
        .map(render_literal_metadata)
        .collect::<Vec<_>>()
        .join(" | ")
}

fn render_object_schema(properties: Option<&BTreeMap<String, ArunaSchemaMetadata>>) -> String {
    let Some(properties) = properties else {
        return "unknown".to_string();
    };

    if properties.is_empty() {
        return "{}".to_string();
    }

    let mut rendered = Vec::new();

    for (key, schema) in properties {
        if schema.kind == "optional" {
            let inner = schema
                .inner
                .as_deref()
                .map(render_schema_metadata)
                .unwrap_or_else(|| "unknown".to_string());
            rendered.push(format!(
                "{}?: {} | undefined;",
                render_property_key(key),
                inner
            ));
        } else {
            rendered.push(format!(
                "{}: {};",
                render_property_key(key),
                render_schema_metadata(schema)
            ));
        }
    }

    format!("{{ {} }}", rendered.join(" "))
}

fn relative_path(from_file: &str, to_file: &str) -> String {
    let from_dir = Path::new(from_file).parent().unwrap_or_else(|| Path::new(""));
    let from_components: Vec<Component<'_>> = from_dir.components().collect();
    let to_components: Vec<Component<'_>> = Path::new(to_file).components().collect();
    let common = from_components
        .iter()
        .zip(&to_components)
        .take_while(|(left, right)| left == right)
        .count();

    let mut relative = PathBuf::new();
    for _ in common..from_components.len() {
        relative.push("..");
    }
    for component in &to_components[common..] {
        match component {
            Component::Normal(part) => relative.push(part),
            Component::CurDir => {}
            Component::ParentDir => relative.push(".."),
            Component::RootDir => {}
            Component::Prefix(prefix) => relative.push(prefix.as_os_str()),
        }
    }

    let text = normalize_path(&relative.to_string_lossy());
    if text.is_empty() {
        ".".to_string()
    } else {
        text
    }
}

fn generated_file_path(generated_dir: &str, filename: &str) -> String {
    normalize_path(&Path::new(generated_dir).join(filename).to_string_lossy())
}

fn type_alias_base_name(export_name: &str) -> String {
    pascal_case_identifier(export_name)
}

fn type_alias_name(export_name: &str, suffix: &str) -> String {
    format!("{}{}", type_alias_base_name(export_name), suffix)
}

#[derive(Clone, Debug)]
struct AliasReservation {
    first_action_id: String,
    first_file: String,
    count: usize,
}

fn reserve_alias(
    alias: String,
    action: &ArunaActionRecord,
    reservations: &mut BTreeMap<String, AliasReservation>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> String {
    let reservation = reservations.entry(alias.clone()).or_insert_with(|| AliasReservation {
        first_action_id: action.id.clone(),
        first_file: action.file.clone(),
        count: 0,
    });

    if reservation.count == 0 {
        reservation.count = 1;
        return alias;
    }

    reservation.count += 1;
    diagnostics.push(create_diagnostic(
        "aruna::558",
        format!(
            "Generated action type alias {alias} is used by more than one action."
        ),
        Some(action.file.clone()),
        None,
        Some(format!(
            "First defined by {} in {}. Collides with {} in {}.",
            reservation.first_action_id, reservation.first_file, action.id, action.file
        )),
        Some(
            "Rename one action export or allow Aruna to disambiguate the generated type aliases in a future release."
                .to_string(),
        ),
    ));

    format!("{}{}", alias, reservation.count)
}

fn action_import_alias(action: &ArunaActionRecord) -> String {
    let source_without_extension = Path::new(&action.file).with_extension("");
    let source_text = normalize_path(&source_without_extension.to_string_lossy());
    format!(
        "{}_{}",
        sanitize_identifier(&source_text),
        sanitize_identifier(&action.export_name)
    )
}

fn client_stub_lines(action: &ArunaActionRecord, input_type: &str, output_type: &str) -> Vec<String> {
    // Fire-and-forget actions are one-way: the client does not wait for a server
    // ack, so the stub resolves void and tells the invoker to skip the response
    // roundtrip. The declared output type is intentionally ignored — there is no
    // response to type.
    if action.fire_and_forget {
        return vec![
            format!(
                "export const {} = (input: {}): Promise<void> => {{",
                action.export_name, input_type
            ),
            format!(
                "  return invokeAction(\"{}\", input, {{ fireAndForget: true }}) as Promise<void>;",
                action.id
            ),
            "};".to_string(),
        ];
    }

    vec![
        format!(
            "export const {} = (input: {}): Promise<{}> => {{",
            action.export_name, input_type, output_type
        ),
        format!(
            "  return invokeAction(\"{}\", input) as Promise<{}>;",
            action.id, output_type
        ),
        "};".to_string(),
    ]
}

fn render_client_file(
    generated_dir: &str,
    actions: &[ArunaActionRecord],
    diagnostics: &mut Vec<ArunaDiagnostic>,
    preserve_generated_comments: bool,
) -> GeneratedFile {
    let path = generated_file_path(generated_dir, GENERATED_CLIENT_ACTIONS_FILE);
    let mut lines = vec![
        "import { invokeAction } from \"aruna/client\";".to_string(),
        "".to_string(),
    ];

    if preserve_generated_comments {
        lines.splice(
            0..0,
            [
                "// Generated by Aruna. Do not edit by hand.".to_string(),
                "// Source: Aruna action manifest v1".to_string(),
                "".to_string(),
            ],
        );
    }

    let mut seen_export_names = BTreeSet::new();
    let mut alias_reservations = BTreeMap::new();
    for action in actions {
        if !seen_export_names.insert(action.export_name.clone()) {
            continue;
        }

        let input_alias_base = type_alias_name(&action.export_name, "Input");
        let output_alias_base = type_alias_name(&action.export_name, "Output");
        let input_alias = reserve_alias(input_alias_base, action, &mut alias_reservations, diagnostics);
        let output_alias = reserve_alias(output_alias_base, action, &mut alias_reservations, diagnostics);

        let input_type = action
            .input_schema
            .as_ref()
            .map(render_schema_metadata)
            .unwrap_or_else(|| "unknown".to_string());
        let output_type = action
            .output_schema
            .as_ref()
            .map(render_schema_metadata)
            .unwrap_or_else(|| "unknown".to_string());

        lines.push(format!("export type {} = {};", input_alias, input_type));
        lines.push(String::new());
        lines.push(format!("export type {} = {};", output_alias, output_type));
        lines.push(String::new());
        lines.extend(client_stub_lines(action, &input_alias, &output_alias));
        lines.push(String::new());
    }

    if lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }

    GeneratedFile {
        path,
        contents: format!("{}\n", lines.join("\n")),
    }
}

fn render_default_rate_limit(rate_limit: &ActionRateLimitConfig) -> String {
    format!(
        "export const defaultRateLimit = {{ key: \"{}\", windowMs: {}, max: {} }} as const;",
        rate_limit.key, rate_limit.window_ms, rate_limit.max
    )
}

fn render_server_file(
    generated_dir: &str,
    actions: &[ArunaActionRecord],
    default_rate_limit: &ActionRateLimitConfig,
    preserve_generated_comments: bool,
) -> GeneratedFile {
    let path = generated_file_path(generated_dir, GENERATED_SERVER_ACTIONS_FILE);
    let mut lines = vec![
    ];

    if preserve_generated_comments {
        lines.extend([
            "// Generated by Aruna. Do not edit by hand.".to_string(),
            "// Source: Aruna action manifest v1".to_string(),
            "".to_string(),
        ]);
    }

    for action in actions {
        let import_path = relative_path(
            &path,
            &normalize_path(&Path::new(&action.file).with_extension("").to_string_lossy()),
        );
        lines.push(format!(
            "import {{ {} as {} }} from \"{}\";",
            action.export_name,
            action_import_alias(action),
            import_path
        ));
    }

    if !actions.is_empty() {
        lines.push(String::new());
    }

    lines.push("export const actions = {".to_string());
    for action in actions {
        lines.push(format!(
            "  \"{}\": {},",
            action.id,
            action_import_alias(action)
        ));
    }
    lines.push("} as const;".to_string());

    // Emit the resolved app-wide default rate limit so the runtime can enforce
    // it for actions that do not declare their own `rateLimit`.
    lines.push(String::new());
    lines.push(render_default_rate_limit(default_rate_limit));

    GeneratedFile {
        path,
        contents: format!("{}\n", lines.join("\n")),
    }
}

fn duplicate_export_diagnostic(
    action: &ArunaActionRecord,
    previous_file: &str,
) -> ArunaDiagnostic {
    create_diagnostic(
        "aruna::557",
        format!(
            "Generated action export name {} is used by more than one action.",
            action.export_name
        ),
        Some(action.file.clone()),
        None,
        Some(format!(
            "First defined in {}, then again in {}.",
            previous_file, action.file
        )),
        Some(
            "Rename one action export or import the generated action through a namespaced layout in a future release."
                .to_string(),
        ),
    )
}

pub fn generate_action_files(
    generated_dir: &str,
    actions: &[ArunaActionRecord],
    default_rate_limit: &ActionRateLimitConfig,
    preserve_generated_comments: bool,
) -> GeneratedActionOutput {
    let mut diagnostics = Vec::new();
    let mut unique_client_actions = Vec::new();
    let mut seen_export_names = BTreeSet::new();
    let mut previous_export_files: std::collections::BTreeMap<String, String> =
        std::collections::BTreeMap::new();

    for action in actions {
        if let Some(previous_file) = previous_export_files.get(action.export_name.as_str()) {
            diagnostics.push(duplicate_export_diagnostic(action, previous_file));
            continue;
        }

        previous_export_files.insert(action.export_name.clone(), action.file.clone());
        if seen_export_names.insert(action.export_name.clone()) {
            unique_client_actions.push(action.clone());
        }
    }

    let client_file = render_client_file(
        generated_dir,
        &unique_client_actions,
        &mut diagnostics,
        preserve_generated_comments,
    );

    GeneratedActionOutput {
        files: vec![
            client_file,
            render_server_file(
                generated_dir,
                actions,
                default_rate_limit,
                preserve_generated_comments,
            ),
        ],
        diagnostics,
    }
}

fn signal_import_alias(signal: &ArunaSignalRecord) -> String {
    let source_without_extension = Path::new(&signal.file).with_extension("");
    let source_text = normalize_path(&source_without_extension.to_string_lossy());
    format!(
        "{}_{}",
        sanitize_identifier(&source_text),
        sanitize_identifier(&signal.export_name)
    )
}

fn signal_payload_type_name(export_name: &str) -> String {
    format!("{}Payload", pascal_case_identifier(export_name))
}

/// Emits a single typed signal module: a `signals` registry the publisher and
/// subscriber bind to, plus a payload type alias per signal. This is the signal
/// counterpart to the action client/server files — it removes the hand-rolled
/// SignalMap and the `unknown` payload casts callers previously needed.
fn render_signal_file(
    generated_dir: &str,
    signals: &[ArunaSignalRecord],
    preserve_generated_comments: bool,
) -> GeneratedFile {
    let path = generated_file_path(generated_dir, GENERATED_SIGNALS_FILE);
    let mut lines = Vec::new();

    if preserve_generated_comments {
        lines.extend([
            "// Generated by Aruna. Do not edit by hand.".to_string(),
            "// Source: Aruna signal manifest v1".to_string(),
            "".to_string(),
        ]);
    }

    for signal in signals {
        let import_path = relative_path(
            &path,
            &normalize_path(&Path::new(&signal.file).with_extension("").to_string_lossy()),
        );
        lines.push(format!(
            "import {{ {} as {} }} from \"{}\";",
            signal.export_name,
            signal_import_alias(signal),
            import_path
        ));
    }

    if !signals.is_empty() {
        lines.push(String::new());
    }

    lines.push("export const signals = {".to_string());
    for signal in signals {
        lines.push(format!(
            "  \"{}\": {},",
            signal.id,
            signal_import_alias(signal)
        ));
    }
    lines.push("} as const;".to_string());

    if !signals.is_empty() {
        lines.push(String::new());
    }

    // Payload type aliases. A signal with no payload schema carries `unknown`,
    // matching SignalPayload<undefined> in the runtime types.
    for signal in signals {
        let rendered = signal
            .payload_schema
            .as_ref()
            .map(render_schema_metadata)
            .unwrap_or_else(|| "unknown".to_string());
        lines.push(format!(
            "export type {} = {};",
            signal_payload_type_name(&signal.export_name),
            rendered
        ));
    }

    GeneratedFile {
        path,
        contents: format!("{}\n", lines.join("\n")),
    }
}

pub fn generate_signal_files(
    generated_dir: &str,
    signals: &[ArunaSignalRecord],
    preserve_generated_comments: bool,
) -> GeneratedSignalOutput {
    let mut diagnostics = Vec::new();
    let mut unique_signals = Vec::new();
    let mut seen_payload_types: BTreeSet<String> = BTreeSet::new();

    for signal in signals {
        // Two signals whose export names pascal-case to the same payload type
        // alias would emit a duplicate `export type`. Keep the first and report
        // the collision rather than producing a file that fails to type-check.
        let payload_type = signal_payload_type_name(&signal.export_name);
        if !seen_payload_types.insert(payload_type.clone()) {
            diagnostics.push(create_diagnostic(
                "aruna::566",
                format!(
                    "Generated signal payload type {payload_type} is used by more than one signal."
                ),
                Some(signal.file.clone()),
                None,
                Some(format!("Collides at signal id {}.", signal.id)),
                Some(
                    "Rename one signal export so its generated payload type is unique.".to_string(),
                ),
            ));
            continue;
        }
        unique_signals.push(signal.clone());
    }

    GeneratedSignalOutput {
        files: vec![render_signal_file(
            generated_dir,
            &unique_signals,
            preserve_generated_comments,
        )],
        diagnostics,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_rate_limit() -> ActionRateLimitConfig {
        ActionRateLimitConfig::default()
    }

    fn action(id: &str, file: &str, export_name: &str) -> ArunaActionRecord {
        ArunaActionRecord {
            id: id.to_string(),
            file: file.to_string(),
            export_name: export_name.to_string(),
            has_input_schema: false,
            has_output_schema: false,
            has_run: true,
            fire_and_forget: false,
            serialization: Default::default(),
            rate_limit: None,
            input_schema: None,
            output_schema: None,
        }
    }

    fn signal(
        id: &str,
        file: &str,
        export_name: &str,
        payload_schema: Option<ArunaSchemaMetadata>,
    ) -> ArunaSignalRecord {
        ArunaSignalRecord {
            id: id.to_string(),
            file: file.to_string(),
            export_name: export_name.to_string(),
            has_payload_schema: payload_schema.is_some(),
            serialization: Default::default(),
            payload_schema,
        }
    }

    #[test]
    fn renders_deterministic_generated_files() {
        let actions = vec![
            action("inventory.restockItem", "src/domains/inventory/actions.ts", "restockItem"),
            action("shop.purchaseItem", "src/domains/shop/actions.ts", "purchaseItem"),
        ];

        let output = generate_action_files("src/.aruna", &actions, &test_rate_limit(), true);

        assert!(output.diagnostics.is_empty());
        assert_eq!(output.files.len(), 2);
        assert_eq!(output.files[0].path, "src/.aruna/shared/actions.client.generated.ts");
        assert_eq!(output.files[1].path, "src/.aruna/server/actions.server.generated.ts");
        assert!(output
            .files[0]
            .contents
            .contains("export type RestockItemInput = unknown;"));
        assert!(output
            .files[0]
            .contents
            .contains("export type RestockItemOutput = unknown;"));
        assert!(output.files[0]
            .contents
            .contains("return invokeAction(\"inventory.restockItem\", input) as Promise<RestockItemOutput>;"));
        assert!(output.files[0]
            .contents
            .contains("export const restockItem = (input: RestockItemInput): Promise<RestockItemOutput> => {"));
        assert!(output.files[0]
            .contents
            .contains("export type PurchaseItemInput = unknown;"));
        assert!(output.files[0]
            .contents
            .contains("export type PurchaseItemOutput = unknown;"));
        assert!(output.files[0]
            .contents
            .contains("export const purchaseItem = (input: PurchaseItemInput): Promise<PurchaseItemOutput> => {"));
        assert!(output.files[1]
            .contents
            .contains("import { restockItem as src_domains_inventory_actions_restockItem } from \"../../domains/inventory/actions\";"));
        assert!(output.files[1]
            .contents
            .contains("import { purchaseItem as src_domains_shop_actions_purchaseItem } from \"../../domains/shop/actions\";"));
        assert!(output.files[1]
            .contents
            .contains("\"inventory.restockItem\": src_domains_inventory_actions_restockItem,"));
        assert!(output.files[1]
            .contents
            .contains("\"shop.purchaseItem\": src_domains_shop_actions_purchaseItem,"));
        assert!(output.files[1].contents.contains(
            "export const defaultRateLimit = { key: \"player\", windowMs: 1000, max: 20 } as const;"
        ));
    }

    #[test]
    fn renders_fire_and_forget_client_stub_as_one_way() {
        let mut paint = action("spray.paint", "src/shared/spray/actions.ts", "paint");
        paint.fire_and_forget = true;
        let actions = vec![paint];

        let output = generate_action_files("src/.aruna", &actions, &test_rate_limit(), true);

        assert!(output.diagnostics.is_empty());
        let client = &output.files[0].contents;
        // One-way stub: resolves void and asks the invoker to skip the ack.
        assert!(client.contains("export const paint = (input: PaintInput): Promise<void> => {"));
        assert!(client.contains(
            "return invokeAction(\"spray.paint\", input, { fireAndForget: true }) as Promise<void>;"
        ));
        // The server registry still imports the definition unchanged.
        assert!(output.files[1]
            .contents
            .contains("\"spray.paint\": src_shared_spray_actions_paint,"));
    }

    #[test]
    fn renders_typed_signal_registry_and_payload_aliases() {
        let signals = vec![
            signal(
                "combat.damaged",
                "src/shared/combat/signals.ts",
                "damaged",
                Some(ArunaSchemaMetadata {
                    kind: "object".to_string(),
                    properties: Some(BTreeMap::from([(
                        "amount".to_string(),
                        ArunaSchemaMetadata {
                            kind: "number".to_string(),
                            ..Default::default()
                        },
                    )])),
                    ..Default::default()
                }),
            ),
            signal("world.tick", "src/shared/world/signals.ts", "tick", None),
        ];

        let output = generate_signal_files("src/.aruna", &signals, true);

        assert!(output.diagnostics.is_empty());
        assert_eq!(output.files.len(), 1);
        assert_eq!(output.files[0].path, "src/.aruna/shared/signals.generated.ts");

        let contents = &output.files[0].contents;
        assert!(contents.contains(
            "import { damaged as src_shared_combat_signals_damaged } from \"../../shared/combat/signals\";"
        ));
        assert!(contents.contains("export const signals = {"));
        assert!(contents.contains("\"combat.damaged\": src_shared_combat_signals_damaged,"));
        assert!(contents.contains("\"world.tick\": src_shared_world_signals_tick,"));
        assert!(contents.contains("} as const;"));
        assert!(contents.contains("export type DamagedPayload = { amount: number; };"));
        // A signal without a payload schema carries `unknown`.
        assert!(contents.contains("export type TickPayload = unknown;"));
    }

    #[test]
    fn reports_signal_payload_type_collision() {
        let signals = vec![
            signal("combat.damaged", "src/shared/a/signals.ts", "damaged", None),
            signal("world.damaged", "src/shared/b/signals.ts", "damaged", None),
        ];

        let output = generate_signal_files("src/.aruna", &signals, true);

        assert_eq!(output.diagnostics.len(), 1);
        assert_eq!(output.diagnostics[0].code, "aruna::566");
        // The colliding second alias is dropped; the first still emits once.
        let occurrences = output.files[0].contents.matches("export type DamagedPayload").count();
        assert_eq!(occurrences, 1);
    }

    #[test]
    fn reports_duplicate_generated_action_exports() {
        let actions = vec![
            action("inventory.restockItem", "src/domains/inventory/actions.ts", "purchaseItem"),
            action("shop.purchaseItem", "src/domains/shop/actions.ts", "purchaseItem"),
        ];

        let output = generate_action_files("src/.aruna", &actions, &test_rate_limit(), true);

        assert_eq!(output.diagnostics.len(), 1);
        assert_eq!(output.diagnostics[0].code, "aruna::557");
        assert!(output
            .files[0]
            .contents
            .contains("export type PurchaseItemInput = unknown;"));
        assert!(output.files[0].contents.contains("export const purchaseItem"));
        assert!(output
            .files[0]
            .contents
            .contains("return invokeAction(\"inventory.restockItem\", input) as Promise<PurchaseItemOutput>;"));
        assert!(!output.files[0].contents.contains("shop.purchaseItem"));
        assert!(output.files[1].contents.contains("inventory.restockItem"));
        assert!(output.files[1].contents.contains("shop.purchaseItem"));
    }

    #[test]
    fn renders_roblox_userdata_schema_metadata_to_typescript() {
        let kind = |name: &str| ArunaSchemaMetadata {
            kind: name.to_string(),
            ..Default::default()
        };

        assert_eq!(render_schema_metadata(&kind("vector3")), "Vector3");
        assert_eq!(render_schema_metadata(&kind("color3")), "Color3");
        assert_eq!(render_schema_metadata(&kind("cframe")), "CFrame");

        // Nested inside an object property, the userdata type renders inline.
        let object = ArunaSchemaMetadata {
            kind: "object".to_string(),
            properties: Some(BTreeMap::from([("at".to_string(), kind("vector3"))])),
            ..Default::default()
        };
        assert_eq!(render_schema_metadata(&object), "{ at: Vector3; }");
    }

    #[test]
    fn renders_supported_schema_metadata_to_typescript() {
        let action = ArunaActionRecord {
            id: "shop.purchaseItem".to_string(),
            file: "src/domains/shop/actions.ts".to_string(),
            export_name: "purchaseItem".to_string(),
            has_input_schema: true,
            has_output_schema: true,
            has_run: true,
            fire_and_forget: false,
            serialization: Default::default(),
            rate_limit: None,
            input_schema: Some(ArunaSchemaMetadata {
                kind: "object".to_string(),
                properties: Some(BTreeMap::from([
                    (
                        "itemId".to_string(),
                        ArunaSchemaMetadata {
                            kind: "string".to_string(),
                            ..Default::default()
                        },
                    ),
                    (
                        "labels".to_string(),
                        ArunaSchemaMetadata {
                            kind: "array".to_string(),
                            items: Some(Box::new(ArunaSchemaMetadata {
                                kind: "enum".to_string(),
                                values: Some(vec![
                                    ArunaSchemaLiteralMetadata::String {
                                        value: "rare".to_string(),
                                    },
                                    ArunaSchemaLiteralMetadata::String {
                                        value: "legendary".to_string(),
                                    },
                                ]),
                                ..Default::default()
                            })),
                            ..Default::default()
                        },
                    ),
                    (
                        "note".to_string(),
                        ArunaSchemaMetadata {
                            kind: "optional".to_string(),
                            inner: Some(Box::new(ArunaSchemaMetadata {
                                kind: "literal".to_string(),
                                literal: Some(ArunaSchemaLiteralMetadata::String {
                                    value: "gift".to_string(),
                                }),
                                ..Default::default()
                            })),
                            ..Default::default()
                        },
                    ),
                ])),
                ..Default::default()
            }),
            output_schema: Some(ArunaSchemaMetadata {
                kind: "object".to_string(),
                properties: Some(BTreeMap::from([(
                    "ok".to_string(),
                    ArunaSchemaMetadata {
                        kind: "boolean".to_string(),
                        ..Default::default()
                    },
                )])),
                ..Default::default()
            }),
        };

        let output = generate_action_files("src/.aruna", &[action], &test_rate_limit(), true);

        assert!(output.diagnostics.is_empty());
        let client = &output.files[0].contents;
        assert!(client.contains(
            "export type PurchaseItemInput = { itemId: string; labels: (\"rare\" | \"legendary\")[]; note?: \"gift\" | undefined; };"
        ));
        assert!(client.contains("export type PurchaseItemOutput = { ok: boolean; };"));
        assert!(client.contains(
            "export const purchaseItem = (input: PurchaseItemInput): Promise<PurchaseItemOutput> => {"
        ));
    }
}
