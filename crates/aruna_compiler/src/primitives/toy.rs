// A toy primitive that exists only in this test: `defineEmote({ id, animation })`.
// It is the worked example in docs/compiler-primitives.md, and it registers
// through the same macro as the real primitives, so it checks that a new
// primitive needs nothing beyond its module and a registry line.

use super::*;
use crate::diagnostics::{create_diagnostic, ArunaDiagnostic};
use crate::module_kind::ModuleKind;
use crate::spans::object_span;
use crate::static_literals::find_object_property;
use oxc_allocator::Allocator;
use oxc_ast::ast::{Argument, Expression};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToyEmoteRecord {
    pub id: String,
    pub file: String,
    pub export_name: String,
    pub animation: Option<String>,
}

pub struct EmotePrimitive;

// A string-literal property, or None when absent or computed.
fn string_property(
    object: &oxc_ast::ast::ObjectExpression<'_>,
    name: &str,
) -> Option<String> {
    match find_object_property(object, name).map(|property| &property.value) {
        Some(Expression::StringLiteral(literal)) => Some(literal.value.to_string()),
        _ => None,
    }
}

impl Primitive for EmotePrimitive {
    type Record = ToyEmoteRecord;

    const NAME: &'static str = "emote";
    const CALLEES: &'static [&'static str] = &["defineEmote"];
    // An emote is shared code: a defining file keeps its convention kind.
    const DEFINING_MODULE: Option<DefiningModule> = None;
    const IN_CONTRACT: bool = true;

    fn analyze(
        site: &DefinitionSite<'_, '_>,
        diagnostics: &mut Vec<ArunaDiagnostic>,
    ) -> Option<Self::Record> {
        let Some(Argument::ObjectExpression(object)) = site.call.arguments.first() else {
            diagnostics.push(create_diagnostic(
                "aruna::999",
                format!("{} must be called with an object literal.", site.callee),
                Some(site.file.to_string()),
                None,
                None,
                None,
            ));
            return None;
        };
        let Some(id) = string_property(object, "id") else {
            let mut diagnostic = create_diagnostic(
                "aruna::999",
                format!("Emote {} needs a static string id.", site.export_name),
                Some(site.file.to_string()),
                None,
                None,
                None,
            );
            diagnostic.span = Some(object_span(object));
            diagnostics.push(diagnostic);
            return None;
        };
        Some(ToyEmoteRecord {
            id,
            file: site.file.to_string(),
            export_name: site.export_name.to_string(),
            animation: string_property(object, "animation"),
        })
    }

    fn sort_key(record: &Self::Record) -> (&str, &str, &str) {
        (&record.id, &record.file, &record.export_name)
    }

    fn finalize(
        records: Vec<Self::Record>,
        diagnostics: &mut Vec<ArunaDiagnostic>,
    ) -> Vec<Self::Record> {
        let mut seen = BTreeMap::new();
        for emote in &records {
            if let Some(previous) = seen.insert(emote.id.clone(), emote.file.clone()) {
                diagnostics.push(create_diagnostic(
                    "aruna::999",
                    format!("Emote id {} is defined more than once.", emote.id),
                    Some(emote.file.clone()),
                    None,
                    Some(format!("First defined in {previous}.")),
                    None,
                ));
            }
        }
        records
    }
}

// A registry with the toy next to a real primitive, built by the same macro.
mod registry {
    use super::EmotePrimitive;
    use crate::primitives::ActionPrimitive;

    crate::primitives::registry::register_primitives! {
        action: ActionPrimitive,
        emote: EmotePrimitive,
    }
}

fn discover_source(
    records: &mut registry::PrimitiveRecords,
    files: &mut registry::PrimitiveFiles,
    file: &str,
    source: &str,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) {
    let allocator = Allocator::default();
    let path = Path::new(file);
    let program = parse_source(&allocator, path, source).unwrap();
    let parsed = ParsedFile::new(path, &program);
    records.discover_file(files, file, &parsed, diagnostics);
}

#[test]
fn a_toy_primitive_registers_with_one_line() {
    let mut records = registry::PrimitiveRecords::default();
    let mut files = registry::PrimitiveFiles::default();
    let mut diagnostics = Vec::new();

    discover_source(
        &mut records,
        &mut files,
        "src/shared/emotes.ts",
        r#"
export const wave = defineEmote({ id: "wave", animation: "rbxassetid://1" });
export const bow = defineEmote({ id: "bow" });
export const broken = defineEmote({ id: computeId() });
const notExported = defineEmote({ id: "hidden" });
"#,
        &mut diagnostics,
    );
    discover_source(
        &mut records,
        &mut files,
        "src/shared/more-emotes.ts",
        r#"export const waveAgain = defineEmote({ id: "wave" });"#,
        &mut diagnostics,
    );
    records.finalize(FinalizeStage::AfterDiscovery, &mut diagnostics);

    // Sorted by id within a file, kept in discovery order across files.
    let ids: Vec<&str> = records.emote.iter().map(|emote| emote.id.as_str()).collect();
    assert_eq!(ids, ["bow", "wave", "wave"]);
    assert_eq!(records.emote[1].animation.as_deref(), Some("rbxassetid://1"));
    assert!(records.action.is_empty());

    let messages: Vec<&str> = diagnostics.iter().map(|d| d.message.as_str()).collect();
    assert_eq!(
        messages,
        [
            "Emote broken needs a static string id.",
            "Emote id wave is defined more than once."
        ]
    );

    // Both files define emotes; neither is reclassified.
    assert_eq!(files.emote.len(), 2);
    assert_eq!(files.defining_module("src/shared/emotes.ts"), None);

    assert_eq!(registry::DESCRIPTORS.len(), 2);
    assert_eq!(registry::DESCRIPTORS[1].name, "emote");
    assert!(registry::DESCRIPTORS[1].in_contract);
}

#[test]
fn an_action_still_reclassifies_its_file_next_to_the_toy() {
    let mut records = registry::PrimitiveRecords::default();
    let mut files = registry::PrimitiveFiles::default();
    let mut diagnostics = Vec::new();

    discover_source(
        &mut records,
        &mut files,
        "src/server/actions.ts",
        r#"export const buy = defineAction({ id: "shop.buy", run() {} });
export const cheer = defineEmote({ id: "cheer" });"#,
        &mut diagnostics,
    );

    assert_eq!(records.action.len(), 1);
    assert_eq!(records.emote.len(), 1);
    assert_eq!(
        files.defining_module("src/server/actions.ts").map(|module| module.kind),
        Some(ModuleKind::ServerAction)
    );
}
