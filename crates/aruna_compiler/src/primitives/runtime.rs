// `defineRuntime`: long-lived server work started by the generated entry.

use crate::diagnostics::{create_diagnostic, ArunaDiagnostic, DiagnosticSpan};
use crate::files::project_relative;
use oxc_ast::ast::{
    Argument, ArrayExpressionElement, CallExpression, Expression, ObjectExpression,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use super::*;
use crate::spans::*;
use crate::static_literals::*;

// A domain runtime discovered from `export const X = defineRuntime({...})`: the
// long-lived server work a project used to start from a hand-written bootstrap
// script. `after` carries the boot-order edges the build resolves.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArunaRuntimeRecord {
    pub id: String,
    pub file: String,
    pub export_name: String,
    // Ids that must start before this one. Omitted from the manifest JSON when
    // empty, so a project whose runtimes are independent stays terse.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub after: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RuntimeDiscoveryResult {
    pub runtimes: Vec<ArunaRuntimeRecord>,
    pub runtime_files: BTreeSet<String>,
    pub diagnostics: Vec<ArunaDiagnostic>,
}

// Reads the optional `after: [...]` boot-order edges off a defineRuntime object.
// Every entry must be a static string literal — the build resolves the order
// without executing the project, so a computed id has nothing to resolve.
pub(crate) fn extract_runtime_after(
    file: &str,
    export_name: &str,
    object: &ObjectExpression<'_>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Vec<String> {
    let Some(property) = find_object_property(object, "after") else {
        return Vec::new();
    };

    let Expression::ArrayExpression(array) = &property.value else {
        diagnostics.push(create_diagnostic(
            "aruna::580",
            format!("Runtime {export_name} in {file} has an invalid after list."),
            Some(file.to_string()),
            Some(DiagnosticSpan {
                start: property.span.start as usize,
                end: property.span.end as usize,
            }),
            Some("after must be an array of runtime ids.".to_string()),
            Some("Use after: [\"otherRuntimeId\"].".to_string()),
        ));
        return Vec::new();
    };

    let mut after = Vec::new();
    for element in &array.elements {
        match element {
            ArrayExpressionElement::StringLiteral(literal) => {
                after.push(literal.value.to_string());
            }
            _ => {
                diagnostics.push(create_diagnostic(
                    "aruna::580",
                    format!("Runtime {export_name} in {file} has a non-literal after entry."),
                    Some(file.to_string()),
                    Some(DiagnosticSpan {
                        start: property.span.start as usize,
                        end: property.span.end as usize,
                    }),
                    Some("after entries must be static string literals.".to_string()),
                    Some("Use after: [\"otherRuntimeId\"] with literal string values.".to_string()),
                ));
            }
        }
    }
    after
}

pub(crate) fn analyze_define_runtime_call<'a>(
    file: &str,
    export_name: &str,
    call: &'a CallExpression<'a>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<ArunaRuntimeRecord> {
    let Some(Argument::ObjectExpression(object)) = call.arguments.first() else {
        diagnostics.push(create_diagnostic(
            "aruna::580",
            format!("Runtime {export_name} in {file} has an invalid defineRuntime definition."),
            Some(file.to_string()),
            Some(call_span(call)),
            Some("defineRuntime expects a single object literal with an id and a start function.".to_string()),
            Some("Use defineRuntime({ id: \"domain\", start() { ... } }).".to_string()),
        ));
        return None;
    };

    let Some(id_property) = find_object_property(object, "id") else {
        diagnostics.push(create_diagnostic(
            "aruna::580",
            format!("Runtime {export_name} in {file} is missing an id."),
            Some(file.to_string()),
            Some(object_span(object)),
            Some("Runtime ids must be declared as a static string literal.".to_string()),
            Some("Add id: \"domain\" to the defineRuntime object.".to_string()),
        ));
        return None;
    };

    let Some(id) = (match &id_property.value {
        Expression::StringLiteral(literal) => Some(literal.value.to_string()),
        _ => None,
    }) else {
        diagnostics.push(create_diagnostic(
            "aruna::580",
            format!("Runtime {export_name} in {file} has an invalid id."),
            Some(file.to_string()),
            Some(DiagnosticSpan {
                start: id_property.span.start as usize,
                end: id_property.span.end as usize,
            }),
            Some("Runtime ids must be static string literals.".to_string()),
            Some("Use id: \"domain\" with a literal string value.".to_string()),
        ));
        return None;
    };

    // A runtime with no `start` is the one shape that would compile and then do
    // nothing at boot, which is exactly the failure this feature exists to
    // remove — so it is rejected rather than recorded.
    if find_object_property(object, "start").is_none() {
        diagnostics.push(create_diagnostic(
            "aruna::580",
            format!("Runtime {id} in {file} is missing a start function."),
            Some(file.to_string()),
            Some(object_span(object)),
            Some("A runtime must declare the work it starts at boot.".to_string()),
            Some("Add start() { ... } to the defineRuntime object.".to_string()),
        ));
        return None;
    }

    Some(ArunaRuntimeRecord {
        id,
        file: file.to_string(),
        export_name: export_name.to_string(),
        after: extract_runtime_after(file, export_name, object, diagnostics),
    })
}

// Resolves the boot order from the `after` edges: a stable topological sort that
// breaks ties by id, so the emitted sequence is deterministic and a diff only
// moves when the declarations do. Reports an `after` naming a runtime that does
// not exist, and a cycle, as errors — both are boot-order bugs that used to
// surface only in Studio.
pub fn resolve_runtime_order(
    runtimes: &[ArunaRuntimeRecord],
) -> (Vec<ArunaRuntimeRecord>, Vec<ArunaDiagnostic>) {
    let mut diagnostics = Vec::new();
    let known: BTreeSet<&str> = runtimes.iter().map(|entry| entry.id.as_str()).collect();

    // Sorted by id first so the traversal below is deterministic regardless of
    // discovery order (which follows the file walk).
    let mut sorted: Vec<&ArunaRuntimeRecord> = runtimes.iter().collect();
    sorted.sort_by(|left, right| left.id.cmp(&right.id));

    let mut dependencies: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for runtime in &sorted {
        let mut edges = Vec::new();
        for dependency in &runtime.after {
            if dependency == &runtime.id {
                diagnostics.push(create_diagnostic(
                    "aruna::582",
                    format!("Runtime {} lists itself in after.", runtime.id),
                    Some(runtime.file.clone()),
                    None,
                    Some("A runtime cannot start after itself.".to_string()),
                    Some(format!("Remove \"{}\" from its own after list.", runtime.id)),
                ));
                continue;
            }
            if !known.contains(dependency.as_str()) {
                diagnostics.push(create_diagnostic(
                    "aruna::582",
                    format!(
                        "Runtime {} declares after: \"{}\", which no runtime defines.",
                        runtime.id, dependency
                    ),
                    Some(runtime.file.clone()),
                    None,
                    Some(
                        "after entries name other runtimes by their defineRuntime id.".to_string(),
                    ),
                    Some(format!(
                        "Define a runtime with id \"{dependency}\", or remove it from after."
                    )),
                ));
                continue;
            }
            edges.push(dependency.as_str());
        }
        edges.sort_unstable();
        edges.dedup();
        dependencies.insert(runtime.id.as_str(), edges);
    }

    // Depth-first post-order emit: a runtime lands after everything it names.
    let mut ordered_ids: Vec<&str> = Vec::new();
    let mut done: BTreeSet<&str> = BTreeSet::new();
    let mut on_stack: Vec<&str> = Vec::new();

    fn visit<'a>(
        id: &'a str,
        dependencies: &BTreeMap<&'a str, Vec<&'a str>>,
        done: &mut BTreeSet<&'a str>,
        on_stack: &mut Vec<&'a str>,
        ordered_ids: &mut Vec<&'a str>,
        cycles: &mut Vec<Vec<String>>,
    ) {
        if done.contains(id) {
            return;
        }
        if let Some(position) = on_stack.iter().position(|entry| *entry == id) {
            let mut cycle: Vec<String> = on_stack[position..].iter().map(|s| s.to_string()).collect();
            cycle.push(id.to_string());
            cycles.push(cycle);
            return;
        }
        on_stack.push(id);
        for dependency in dependencies.get(id).map(Vec::as_slice).unwrap_or(&[]) {
            visit(dependency, dependencies, done, on_stack, ordered_ids, cycles);
        }
        on_stack.pop();
        done.insert(id);
        ordered_ids.push(id);
    }

    let mut cycles: Vec<Vec<String>> = Vec::new();
    for runtime in &sorted {
        visit(
            runtime.id.as_str(),
            &dependencies,
            &mut done,
            &mut on_stack,
            &mut ordered_ids,
            &mut cycles,
        );
    }

    for cycle in cycles {
        diagnostics.push(create_diagnostic(
            "aruna::582",
            format!("Runtime start order has a cycle: {}.", cycle.join(" -> ")),
            None,
            None,
            Some("Every runtime in the cycle waits for another one in it.".to_string()),
            Some("Break the cycle by dropping one after edge.".to_string()),
        ));
    }

    let by_id: BTreeMap<&str, &ArunaRuntimeRecord> = sorted
        .iter()
        .map(|runtime| (runtime.id.as_str(), *runtime))
        .collect();
    let ordered = ordered_ids
        .into_iter()
        .filter_map(|id| by_id.get(id).map(|runtime| (*runtime).clone()))
        .collect();

    (ordered, diagnostics)
}

pub struct RuntimePrimitive;

impl Primitive for RuntimePrimitive {
    type Record = ArunaRuntimeRecord;

    const NAME: &'static str = "runtime";
    const CALLEES: &'static [&'static str] = &["defineRuntime"];
    const DEFINING_MODULE: Option<DefiningModule> = None;
    const IN_CONTRACT: bool = false;

    fn analyze(
        site: &DefinitionSite<'_, '_>,
        diagnostics: &mut Vec<ArunaDiagnostic>,
    ) -> Option<Self::Record> {
        analyze_define_runtime_call(site.file, site.export_name, site.call, diagnostics)
    }

    fn sort_key(record: &Self::Record) -> (&str, &str, &str) {
        (&record.id, &record.file, &record.export_name)
    }

    // A duplicated runtime id makes `after` ambiguous and the boot order
    // unresolvable, so it is rejected before the order is computed. The order
    // is resolved here rather than in codegen so `aruna check` reports a bad
    // boot order without writing anything, and so the manifest records the
    // order the generated entry will actually use.
    fn finalize(
        mut records: Vec<Self::Record>,
        diagnostics: &mut Vec<ArunaDiagnostic>,
    ) -> Vec<Self::Record> {
        let mut seen_runtime_ids = BTreeMap::new();
        let mut duplicate_runtime_ids = BTreeSet::new();
        for runtime in &records {
            if let Some(previous_file) =
                seen_runtime_ids.insert(runtime.id.clone(), runtime.file.clone())
            {
                duplicate_runtime_ids.insert(runtime.id.clone());
                diagnostics.push(create_diagnostic(
                    "aruna::581",
                    format!("Runtime id {} is defined more than once.", runtime.id),
                    Some(runtime.file.clone()),
                    None,
                    Some(format!(
                        "First defined in {}, then again in {}. An after edge naming it could mean either.",
                        previous_file, runtime.file
                    )),
                    Some("Use one defineRuntime per id, such as one per domain.".to_string()),
                ));
            }
        }
        records.retain(|runtime| !duplicate_runtime_ids.contains(&runtime.id));

        let (records, order_diagnostics) = resolve_runtime_order(&records);
        diagnostics.extend(order_diagnostics);
        records
    }
}

pub fn collect_runtime_definitions(
    project_root: &Path,
    path: &Path,
    source_text: &str,
) -> Result<RuntimeDiscoveryResult, String> {
    let found = collect_definitions::<RuntimePrimitive>(project_root, path, source_text)?;
    let mut runtime_files = BTreeSet::new();
    if found.defines {
        runtime_files.insert(project_relative(project_root, path));
    }
    Ok(RuntimeDiscoveryResult {
        runtimes: found.records,
        runtime_files,
        diagnostics: found.diagnostics,
    })
}
