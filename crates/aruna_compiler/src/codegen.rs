use crate::actions::{
    ArunaActionRecord, ArunaRuntimeRecord, ArunaSchemaLiteralMetadata, ArunaSchemaMetadata,
    ArunaSignalRecord,
};
use crate::config::ActionRateLimitConfig;
use crate::diagnostics::{create_diagnostic, ArunaDiagnostic};
use crate::files::normalize_path;
use crate::resolver::{
    GENERATED_CLIENT_ACTIONS_FILE, GENERATED_CLIENT_ENTRY_FILE, GENERATED_SERVER_ACTIONS_FILE,
    GENERATED_SERVER_ENTRY_FILE, GENERATED_SIGNALS_FILE,
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

// A user hook module discovered next to the recommended entry paths
// (`src/server.ts`, `src/client.ts(x)`) under `entries: "generated"`. The
// generated mains import it and wire its recognized exports; `exports` holds
// the module's value-level export names as parsed from the source.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookModuleRecord {
    pub file: String,
    pub exports: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryHooks {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<HookModuleRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<HookModuleRecord>,
}

// The hook exports the generated mains know how to wire. Anything else exported
// from a hook module is reported (aruna::568) rather than silently ignored.
pub const RECOGNIZED_SERVER_HOOKS: [&str; 3] = ["configure", "middleware", "onError"];
pub const RECOGNIZED_CLIENT_HOOKS: [&str; 2] = ["createRequestId", "onStart"];

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GeneratedEntryOutput {
    pub files: Vec<GeneratedFile>,
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
        // Record's value schema rides the `items` slot (see actions.rs).
        "record" => schema
            .items
            .as_deref()
            .map(|value| format!("Record<string, {}>", render_schema_metadata(value)))
            .unwrap_or_else(|| "unknown".to_string()),
        // Tuple element schemas ride the `members` slot, in positional order.
        "tuple" => schema
            .members
            .as_ref()
            .map(|items| {
                format!(
                    "[{}]",
                    items
                        .iter()
                        .map(render_schema_metadata)
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })
            .unwrap_or_else(|| "unknown".to_string()),
        // Roblox userdata kinds render to the native @rbxts/types globals so the
        // generated client/signal stubs are typed against the real value types.
        "vector3" => "Vector3".to_string(),
        "vector2" => "Vector2".to_string(),
        "color3" => "Color3".to_string(),
        "cframe" => "CFrame".to_string(),
        "udim" => "UDim".to_string(),
        "udim2" => "UDim2".to_string(),
        "dateTime" => "DateTime".to_string(),
        "brickColor" => "BrickColor".to_string(),
        "instance" => "Instance".to_string(),
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
    contract_hash: &str,
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
        // An action with no declared output schema resolves to `void` (not
        // `unknown`): the handler may return nothing and the client awaits a
        // `Promise<void>`. Only a declared output schema produces a concrete
        // payload type. Input keeps `unknown` when unschematized — an unvalidated
        // request body genuinely has no known shape.
        let output_type = action
            .output_schema
            .as_ref()
            .map(render_schema_metadata)
            .unwrap_or_else(|| "void".to_string());

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

    // The client's compiled-in contract hash, compared against the server's
    // advertised hash on boot to detect a deploy skew.
    lines.push(String::new());
    lines.push(format!("export const contractHash = \"{contract_hash}\";"));

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
    contract_hash: &str,
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

    // The server's contract hash, advertised on the action remote (via
    // `robloxRemoteEvent({ contractHash })`) so clients can detect a deploy skew.
    lines.push(String::new());
    lines.push(format!("export const contractHash = \"{contract_hash}\";"));

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

// A stable hash of the wire-relevant contract — action ids, ack behavior,
// serialization, and input/output schema layout, plus signal ids, reliability,
// serialization, and payload layout. Emitted as `contractHash` into both the
// server and client modules so a client can detect a deploy skew against the
// server. Rate limits are deliberately excluded (server-enforced, not on the
// wire). FNV-1a over a canonical string; the manifest already orders records
// deterministically, so the same contract always hashes the same.
pub fn compute_contract_hash(
    actions: &[ArunaActionRecord],
    signals: &[ArunaSignalRecord],
) -> String {
    fn schema_part(schema: &Option<ArunaSchemaMetadata>) -> String {
        schema
            .as_ref()
            .map(|value| serde_json::to_string(value).unwrap_or_default())
            .unwrap_or_default()
    }

    let mut canonical = String::new();
    for action in actions {
        canonical.push_str("A|");
        canonical.push_str(&action.id);
        canonical.push('|');
        canonical.push_str(if action.fire_and_forget { "faf" } else { "req" });
        canonical.push('|');
        canonical.push_str(&serde_json::to_string(&action.serialization).unwrap_or_default());
        canonical.push('|');
        canonical.push_str(&schema_part(&action.input_schema));
        canonical.push('|');
        canonical.push_str(&schema_part(&action.output_schema));
        canonical.push('\n');
    }
    for signal in signals {
        canonical.push_str("S|");
        canonical.push_str(&signal.id);
        canonical.push('|');
        canonical.push_str(if signal.unreliable { "unrel" } else { "rel" });
        canonical.push('|');
        canonical.push_str(&serde_json::to_string(&signal.serialization).unwrap_or_default());
        canonical.push('|');
        canonical.push_str(&schema_part(&signal.payload_schema));
        canonical.push('\n');
    }

    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in canonical.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

pub fn generate_action_files(
    generated_dir: &str,
    actions: &[ArunaActionRecord],
    signals: &[ArunaSignalRecord],
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

    let contract_hash = compute_contract_hash(actions, signals);

    let client_file = render_client_file(
        generated_dir,
        &unique_client_actions,
        &contract_hash,
        &mut diagnostics,
        preserve_generated_comments,
    );

    GeneratedActionOutput {
        files: vec![
            client_file,
            render_server_file(
                generated_dir,
                actions,
                &contract_hash,
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


// Import alias for a runtime binding in the generated entry. Two domains may
// both export `runtime`, so the alias carries the id to keep them apart.
fn runtime_import_alias(runtime: &ArunaRuntimeRecord) -> String {
    let sanitized: String = runtime
        .id
        .chars()
        .map(|character| if character.is_ascii_alphanumeric() { character } else { '_' })
        .collect();
    format!("{}_runtime", sanitized)
}

fn generated_entry_header(preserve_generated_comments: bool) -> Vec<String> {
    if preserve_generated_comments {
        vec![
            "// Generated by Aruna. Do not edit by hand.".to_string(),
            "// Source: Aruna entry manifest v1".to_string(),
            "".to_string(),
        ]
    } else {
        Vec::new()
    }
}

fn hook_exports(hooks: Option<&HookModuleRecord>, name: &str) -> bool {
    hooks.is_some_and(|module| module.exports.iter().any(|export| export == name))
}

fn hook_import_specifier(entry_path: &str, hook_file: &str) -> String {
    relative_path(
        entry_path,
        &normalize_path(&Path::new(hook_file).with_extension("").to_string_lossy()),
    )
}

// The generated server entry: constructs the app from the manifest — registry +
// default rate limit always, signal publisher iff the project declares signals,
// and the user hook module's recognized exports iff it declares them. The
// `.server.ts` suffix makes roblox-ts emit a real Script.
fn render_server_entry_file(
    generated_dir: &str,
    has_signals: bool,
    runtimes: &[ArunaRuntimeRecord],
    hooks: Option<&HookModuleRecord>,
    preserve_generated_comments: bool,
) -> GeneratedFile {
    let path = generated_file_path(generated_dir, GENERATED_SERVER_ENTRY_FILE);
    let mut lines = generated_entry_header(preserve_generated_comments);

    let wires_middleware = hook_exports(hooks, "middleware");
    let wires_on_error = hook_exports(hooks, "onError");
    let wires_configure = hook_exports(hooks, "configure");
    let uses_hook_exports = wires_middleware || wires_on_error || wires_configure;

    // One import per module, not one per binding: the generated entry is code a
    // user reads when they want to know what Aruna wired for them.
    let mut server_imports = vec!["createServerApp"];
    if !runtimes.is_empty() {
        server_imports.push("startRuntimes");
    }
    lines.push(format!(
        "import {{ {} }} from \"aruna/server\";",
        server_imports.join(", ")
    ));
    if has_signals {
        lines.push(
            "import { createSignalPublisher, robloxRemoteEvent } from \"aruna/roblox\";"
                .to_string(),
        );
    } else {
        lines.push("import { robloxRemoteEvent } from \"aruna/roblox\";".to_string());
    }
    lines.push("import { actions, defaultRateLimit } from \"$aruna/actions/server\";".to_string());
    if has_signals {
        lines.push("import { signals } from \"$aruna/signals\";".to_string());
    }
    // Domain runtimes, imported in the boot order the compiler resolved from
    // their `after` edges.
    for runtime in runtimes {
        let import_path = relative_path(
            &path,
            &normalize_path(&Path::new(&runtime.file).with_extension("").to_string_lossy()),
        );
        lines.push(format!(
            "import {{ {} as {} }} from \"{}\";",
            runtime.export_name,
            runtime_import_alias(runtime),
            import_path
        ));
    }
    if let Some(hook_module) = hooks {
        let specifier = hook_import_specifier(&path, &hook_module.file);
        if uses_hook_exports {
            lines.push(format!("import * as hooks from \"{specifier}\";"));
        } else {
            // No recognized hook exports — still load the module so its boot
            // side effects run (it is the user's server bootstrap code).
            lines.push(format!("import \"{specifier}\";"));
        }
    }

    lines.push(String::new());
    lines.push(if wires_configure {
        "const app = createServerApp<Player>({".to_string()
    } else {
        "createServerApp<Player>({".to_string()
    });
    lines.push("  actions,".to_string());
    lines.push("  defaultRateLimit,".to_string());
    lines.push("  transport: robloxRemoteEvent(),".to_string());
    if has_signals {
        lines.push("  signals,".to_string());
        lines.push("  createPublisher: createSignalPublisher,".to_string());
    }
    if wires_middleware {
        lines.push("  middleware: hooks.middleware,".to_string());
    }
    if wires_on_error {
        lines.push("  onError: hooks.onError,".to_string());
    }
    lines.push("});".to_string());

    if wires_configure {
        lines.push(String::new());
        lines.push("hooks.configure(app);".to_string());
    }

    // Domain runtimes start last, and from inside this Script rather than a
    // hand-written one: the app is wired by the time the first heartbeat or
    // PlayerAdded handler runs, and the two no longer race as separate Scripts
    // (Roblox does not order Scripts against each other).
    if !runtimes.is_empty() {
        lines.push(String::new());
        lines.push("startRuntimes([".to_string());
        for runtime in runtimes {
            lines.push(format!("  {},", runtime_import_alias(runtime)));
        }
        lines.push("]);".to_string());
    }

    GeneratedFile {
        path,
        contents: format!("{}\n", lines.join("\n")),
    }
}

// The generated client entry: owns the invoker (so the generated action stubs
// work), wires the signal subscriber iff signals exist, and hands the app to
// the user hook module's `onStart`. The `.client.ts` suffix makes roblox-ts
// emit a real LocalScript.
fn render_client_entry_file(
    generated_dir: &str,
    has_signals: bool,
    hooks: Option<&HookModuleRecord>,
    preserve_generated_comments: bool,
) -> GeneratedFile {
    let path = generated_file_path(generated_dir, GENERATED_CLIENT_ENTRY_FILE);
    let mut lines = generated_entry_header(preserve_generated_comments);

    let wires_create_request_id = hook_exports(hooks, "createRequestId");
    let wires_on_start = hook_exports(hooks, "onStart");
    let uses_hook_exports = wires_create_request_id || wires_on_start;

    lines.push("import { createClientApp } from \"aruna/client\";".to_string());
    match (wires_create_request_id, has_signals) {
        (true, true) => lines.push(
            "import { createActionInvoker, createSignalSubscriber } from \"aruna/roblox\";"
                .to_string(),
        ),
        (true, false) => {
            lines.push("import { createActionInvoker } from \"aruna/roblox\";".to_string());
        }
        (false, true) => {
            lines.push("import { createSignalSubscriber } from \"aruna/roblox\";".to_string());
        }
        (false, false) => {}
    }
    if has_signals {
        lines.push("import { signals } from \"$aruna/signals\";".to_string());
    }
    if let Some(hook_module) = hooks {
        let specifier = hook_import_specifier(&path, &hook_module.file);
        if uses_hook_exports {
            lines.push(format!("import * as hooks from \"{specifier}\";"));
        } else {
            lines.push(format!("import \"{specifier}\";"));
        }
    }

    lines.push(String::new());

    let mut options = Vec::new();
    if wires_create_request_id {
        options.push(
            "  transport: createActionInvoker({ createRequestId: hooks.createRequestId }),"
                .to_string(),
        );
    }
    if has_signals {
        options.push("  signals,".to_string());
        options.push("  createSubscriber: createSignalSubscriber,".to_string());
    }

    let binding = if wires_on_start { "const app = " } else { "" };
    if options.is_empty() {
        lines.push(format!("{binding}createClientApp();"));
    } else {
        lines.push(format!("{binding}createClientApp({{"));
        lines.extend(options);
        lines.push("});".to_string());
    }

    if wires_on_start {
        lines.push(String::new());
        lines.push("hooks.onStart(app);".to_string());
    }

    GeneratedFile {
        path,
        contents: format!("{}\n", lines.join("\n")),
    }
}

// Emits the generated runtime entries (entries: "generated"): the manifest — not
// hand-written bootstrap files — decides what gets wired. Signals wire iff the
// project declares any; hook-module exports wire iff the user declares them.
pub fn generate_entry_files(
    generated_dir: &str,
    has_signals: bool,
    runtimes: &[ArunaRuntimeRecord],
    hooks: &EntryHooks,
    preserve_generated_comments: bool,
) -> GeneratedEntryOutput {
    GeneratedEntryOutput {
        files: vec![
            render_server_entry_file(
                generated_dir,
                has_signals,
                runtimes,
                hooks.server.as_ref(),
                preserve_generated_comments,
            ),
            render_client_entry_file(
                generated_dir,
                has_signals,
                hooks.client.as_ref(),
                preserve_generated_comments,
            ),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_rate_limit() -> ActionRateLimitConfig {
        ActionRateLimitConfig::default()
    }

    #[test]
    fn renders_record_and_tuple_types() {
        let leaf = |kind: &str| ArunaSchemaMetadata {
            kind: kind.to_string(),
            ..Default::default()
        };

        let record = ArunaSchemaMetadata {
            kind: "record".to_string(),
            items: Some(Box::new(leaf("number"))),
            ..Default::default()
        };
        assert_eq!(render_schema_metadata(&record), "Record<string, number>");

        let tuple = ArunaSchemaMetadata {
            kind: "tuple".to_string(),
            members: Some(vec![leaf("string"), leaf("number")]),
            ..Default::default()
        };
        assert_eq!(render_schema_metadata(&tuple), "[string, number]");
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
            unreliable: false,
            serialization: Default::default(),
            payload_schema,
        }
    }

    #[test]
    fn contract_hash_is_stable_and_wire_sensitive() {
        let base = vec![
            action("shop.buy", "src/shop.ts", "buy"),
            action("shop.sell", "src/shop.ts", "sell"),
        ];
        let signals = vec![signal("shop.changed", "src/shop.ts", "changed", None)];

        // Deterministic: the same contract hashes to the same 16-char value.
        let hash = compute_contract_hash(&base, &signals);
        assert_eq!(hash, compute_contract_hash(&base, &signals));
        assert_eq!(hash.len(), 16);

        // A wire-relevant change (adding an output schema) changes the hash.
        let mut with_output = base.clone();
        with_output[0].output_schema = Some(ArunaSchemaMetadata {
            kind: "string".to_string(),
            ..Default::default()
        });
        assert_ne!(compute_contract_hash(&with_output, &signals), hash);

        // A rate-limit change is NOT wire-relevant, so the hash is unchanged.
        let mut with_rate_limit = base.clone();
        with_rate_limit[0].rate_limit = Some(crate::actions::ArunaActionRateLimitMetadata {
            key: "player".to_string(),
            window_ms: 1000,
            max: 5,
        });
        assert_eq!(compute_contract_hash(&with_rate_limit, &signals), hash);

        // A signal reliability change is wire-relevant (routing), so it changes.
        let mut unreliable_signals = signals.clone();
        unreliable_signals[0].unreliable = true;
        assert_ne!(compute_contract_hash(&base, &unreliable_signals), hash);
    }

    #[test]
    fn renders_deterministic_generated_files() {
        let actions = vec![
            action("inventory.restockItem", "src/domains/inventory/actions.ts", "restockItem"),
            action("shop.purchaseItem", "src/domains/shop/actions.ts", "purchaseItem"),
        ];

        let output = generate_action_files("src/.aruna", &actions, &[], &test_rate_limit(), true);

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
            .contains("export type RestockItemOutput = void;"));
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
            .contains("export type PurchaseItemOutput = void;"));
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

        let output = generate_action_files("src/.aruna", &actions, &[], &test_rate_limit(), true);

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

        let output = generate_action_files("src/.aruna", &actions, &[], &test_rate_limit(), true);

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
    fn renders_generated_entries_with_signals_and_hooks() {
        let hooks = EntryHooks {
            server: Some(HookModuleRecord {
                file: "src/server.ts".to_string(),
                exports: vec![
                    "middleware".to_string(),
                    "onError".to_string(),
                    "configure".to_string(),
                ],
            }),
            client: Some(HookModuleRecord {
                file: "src/client.tsx".to_string(),
                exports: vec!["createRequestId".to_string(), "onStart".to_string()],
            }),
        };

        let output = generate_entry_files("src/.aruna", true, &[], &hooks, true);

        assert_eq!(output.files.len(), 2);
        assert_eq!(output.files[0].path, "src/.aruna/server/main.server.ts");
        assert_eq!(output.files[1].path, "src/.aruna/client/main.client.ts");

        let server = &output.files[0].contents;
        assert!(server.contains("import { createServerApp } from \"aruna/server\";"));
        assert!(server
            .contains("import { createSignalPublisher, robloxRemoteEvent } from \"aruna/roblox\";"));
        assert!(server
            .contains("import { actions, defaultRateLimit } from \"$aruna/actions/server\";"));
        assert!(server.contains("import { signals } from \"$aruna/signals\";"));
        assert!(server.contains("import * as hooks from \"../../server\";"));
        assert!(server.contains("const app = createServerApp<Player>({"));
        assert!(server.contains("  transport: robloxRemoteEvent(),"));
        assert!(server.contains("  createPublisher: createSignalPublisher,"));
        assert!(server.contains("  middleware: hooks.middleware,"));
        assert!(server.contains("  onError: hooks.onError,"));
        assert!(server.contains("hooks.configure(app);"));

        let client = &output.files[1].contents;
        assert!(client.contains("import { createClientApp } from \"aruna/client\";"));
        assert!(client.contains(
            "import { createActionInvoker, createSignalSubscriber } from \"aruna/roblox\";"
        ));
        assert!(client.contains("import * as hooks from \"../../client\";"));
        assert!(client.contains("const app = createClientApp({"));
        assert!(client.contains(
            "  transport: createActionInvoker({ createRequestId: hooks.createRequestId }),"
        ));
        assert!(client.contains("  signals,"));
        assert!(client.contains("  createSubscriber: createSignalSubscriber,"));
        assert!(client.contains("hooks.onStart(app);"));
    }

    #[test]
    fn renders_minimal_generated_entries_without_signals_or_hooks() {
        let output = generate_entry_files("src/.aruna", false, &[], &EntryHooks::default(), true);

        let server = &output.files[0].contents;
        assert!(server.contains("import { robloxRemoteEvent } from \"aruna/roblox\";"));
        assert!(!server.contains("createSignalPublisher"));
        assert!(!server.contains("$aruna/signals"));
        assert!(!server.contains("hooks"));
        // No configure hook: the app handle is not bound.
        assert!(server.contains("createServerApp<Player>({"));
        assert!(!server.contains("const app ="));

        let client = &output.files[1].contents;
        assert!(client.contains("createClientApp();"));
        assert!(!client.contains("aruna/roblox"));
        assert!(!client.contains("hooks"));
    }

    #[test]
    fn side_effect_imports_hook_module_without_recognized_exports() {
        let hooks = EntryHooks {
            server: Some(HookModuleRecord {
                file: "src/server.ts".to_string(),
                exports: vec!["bootstrap".to_string()],
            }),
            client: None,
        };

        let output = generate_entry_files("src/.aruna", false, &[], &hooks, true);

        let server = &output.files[0].contents;
        assert!(server.contains("import \"../../server\";"));
        assert!(!server.contains("import * as hooks"));
    }

    #[test]
    fn starts_domain_runtimes_in_the_order_the_records_carry() {
        let runtime = |id: &str| ArunaRuntimeRecord {
            id: id.to_string(),
            file: format!("src/domains/{id}/runtime.ts"),
            export_name: format!("{id}Runtime"),
            after: Vec::new(),
        };
        // Already resolved upstream, so codegen emits them verbatim rather than
        // sorting again — the order is the record.
        let runtimes = vec![runtime("score"), runtime("grab"), runtime("world")];

        let output = generate_entry_files(
            "src/.aruna",
            false,
            &runtimes,
            &EntryHooks::default(),
            true,
        );
        let server = &output.files[0].contents;

        assert!(server.contains("import { createServerApp, startRuntimes } from \"aruna/server\";"));
        assert!(server
            .contains("import { scoreRuntime as score_runtime } from \"../../domains/score/runtime\";"));
        assert!(server.contains("startRuntimes([\n  score_runtime,\n  grab_runtime,\n  world_runtime,\n]);"));

        // The starts come after the app is constructed: a runtime's first
        // heartbeat must not beat the action transport into existence.
        let app_at = server.find("createServerApp").expect("app");
        let start_at = server.find("startRuntimes([").expect("starts");
        assert!(app_at < start_at);
    }

    #[test]
    fn omits_the_runtime_boot_sequence_when_no_runtime_is_declared() {
        let output =
            generate_entry_files("src/.aruna", false, &[], &EntryHooks::default(), true);
        let server = &output.files[0].contents;

        assert!(!server.contains("startRuntimes"));
        assert!(!server.contains("aruna/server\";\nimport { startRuntimes"));
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

        let output = generate_action_files("src/.aruna", &[action], &[], &test_rate_limit(), true);

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
