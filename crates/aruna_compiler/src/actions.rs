use crate::diagnostics::{create_diagnostic, ArunaDiagnostic, DiagnosticSpan};
use crate::files::project_relative;
use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, BindingPattern, CallExpression, Declaration, Expression, ObjectExpression,
    ObjectPropertyKind, PropertyKey, Statement, VariableDeclarationKind,
};
use oxc_parser::Parser;
use oxc_span::SourceType;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArunaActionRecord {
    pub id: String,
    pub file: String,
    pub export_name: String,
    pub has_input_schema: bool,
    pub has_output_schema: bool,
    pub has_run: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ActionDiscoveryResult {
    pub actions: Vec<ArunaActionRecord>,
    pub action_files: BTreeSet<String>,
    pub diagnostics: Vec<ArunaDiagnostic>,
}

fn source_type_for_path(path: &Path) -> Result<SourceType, String> {
    SourceType::from_path(path).map_err(|error| error.to_string())
}

fn call_span(call: &CallExpression<'_>) -> DiagnosticSpan {
    DiagnosticSpan {
        start: call.span.start as usize,
        end: call.span.end as usize,
    }
}

fn object_span(object: &ObjectExpression<'_>) -> DiagnosticSpan {
    DiagnosticSpan {
        start: object.span.start as usize,
        end: object.span.end as usize,
    }
}

fn property_name(key: &PropertyKey<'_>) -> Option<String> {
    match key {
        PropertyKey::StaticIdentifier(ident) => Some(ident.name.as_str().to_string()),
        PropertyKey::StringLiteral(literal) => Some(literal.value.to_string()),
        _ => None,
    }
}

fn is_function_like(expression: &Expression<'_>) -> bool {
    matches!(
        expression,
        Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_)
    )
}

fn has_valid_run_handler(property: &oxc_ast::ast::ObjectProperty<'_>) -> bool {
    property.method || is_function_like(&property.value)
}

fn find_object_property<'a>(
    object: &'a ObjectExpression<'a>,
    name: &str,
) -> Option<&'a oxc_ast::ast::ObjectProperty<'a>> {
    object.properties.iter().find_map(|property| match property {
        ObjectPropertyKind::ObjectProperty(object_property) => {
            property_name(&object_property.key).and_then(|property_name| {
                if property_name == name {
                    Some(object_property.as_ref())
                } else {
                    None
                }
            })
        }
        ObjectPropertyKind::SpreadProperty(_) => None,
    })
}

fn analyze_define_action_call(
    file: &str,
    export_name: &str,
    call: &CallExpression<'_>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<ArunaActionRecord> {
    let Some(first_argument) = call.arguments.first() else {
        diagnostics.push(create_diagnostic(
            "aruna::550",
            format!("Server action {export_name} in {file} has an invalid defineAction definition."),
            Some(file.to_string()),
            Some(call_span(call)),
            Some("defineAction expects a single object literal with at least an id and run handler.".to_string()),
            Some("Use defineAction({ id: \"domain.action\", run(ctx, input) { ... } }).".to_string()),
        ));
        return None;
    };

    let Argument::ObjectExpression(object) = first_argument else {
        diagnostics.push(create_diagnostic(
            "aruna::550",
            format!("Server action {export_name} in {file} has an invalid defineAction definition."),
            Some(file.to_string()),
            Some(call_span(call)),
            Some("defineAction expects an object literal as its first argument.".to_string()),
            Some("Use defineAction({ id: \"domain.action\", run(ctx, input) { ... } }).".to_string()),
        ));
        return None;
    };

    let Some(id_property) = find_object_property(object, "id") else {
        diagnostics.push(create_diagnostic(
            "aruna::550",
            format!("Server action {export_name} in {file} is missing an id."),
            Some(file.to_string()),
            Some(object_span(object)),
            Some("Action ids must be declared as a static string literal.".to_string()),
            Some("Add id: \"domain.actionName\" to the defineAction object.".to_string()),
        ));
        return None;
    };

    let Some(id) = (match &id_property.value {
        Expression::StringLiteral(literal) => Some(literal.value.to_string()),
        _ => None,
    }) else {
        diagnostics.push(create_diagnostic(
            "aruna::550",
            format!("Server action {export_name} in {file} has an invalid id."),
            Some(file.to_string()),
            Some(DiagnosticSpan {
                start: id_property.span.start as usize,
                end: id_property.span.end as usize,
            }),
            Some("Action ids must be static string literals.".to_string()),
            Some("Use id: \"domain.actionName\" with a literal string value.".to_string()),
        ));
        return None;
    };

    let has_input_schema = find_object_property(object, "input").is_some();
    let has_output_schema = find_object_property(object, "output").is_some();

    let Some(run_property) = find_object_property(object, "run") else {
        diagnostics.push(create_diagnostic(
            "aruna::551",
            format!("Server action {id} is missing a run handler."),
            Some(file.to_string()),
            Some(object_span(object)),
            Some(format!("export name: {export_name}")),
            Some("Add a run(ctx, input) function to the defineAction object.".to_string()),
        ));
        return Some(ArunaActionRecord {
            id,
            file: file.to_string(),
            export_name: export_name.to_string(),
            has_input_schema,
            has_output_schema,
            has_run: false,
        });
    };

    let has_run = has_valid_run_handler(run_property);
    if !has_run {
        diagnostics.push(create_diagnostic(
            "aruna::552",
            format!("Server action {id} has a run handler, but it is not a function."),
            Some(file.to_string()),
            Some(DiagnosticSpan {
                start: run_property.span.start as usize,
                end: run_property.span.end as usize,
            }),
            Some(format!("export name: {export_name}")),
            Some("Make run a function or async function.".to_string()),
        ));
    }

    Some(ArunaActionRecord {
        id,
        file: file.to_string(),
        export_name: export_name.to_string(),
        has_input_schema,
        has_output_schema,
        has_run,
    })
}

fn collect_action_candidates(
    file: &str,
    program: &oxc_ast::ast::Program<'_>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> (Vec<ArunaActionRecord>, bool) {
    let mut actions = Vec::new();
    let mut saw_define_action = false;

    for statement in &program.body {
        let Statement::ExportNamedDeclaration(export_decl) = statement else {
            continue;
        };

        let Some(Declaration::VariableDeclaration(variable_decl)) = &export_decl.declaration else {
            continue;
        };

        if variable_decl.kind != VariableDeclarationKind::Const {
            continue;
        }

        for declarator in &variable_decl.declarations {
            let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
                continue;
            };

            let Some(Expression::CallExpression(call)) = declarator.init.as_ref() else {
                continue;
            };

            let Expression::Identifier(callee) = &call.callee else {
                continue;
            };

            if callee.name.as_str() != "defineAction" {
                continue;
            }

            saw_define_action = true;

            let Some(candidate) = analyze_define_action_call(
                file,
                binding.name.as_str(),
                call,
                diagnostics,
            ) else {
                continue;
            };
            actions.push(candidate);
        }
    }

    (actions, saw_define_action)
}

pub fn collect_action_definitions(
    project_root: &Path,
    path: &Path,
    source_text: &str,
) -> Result<ActionDiscoveryResult, String> {
    let file = project_relative(project_root, path);
    let allocator = Allocator::default();
    let source_type = source_type_for_path(path)?;
    let parser_return = Parser::new(&allocator, source_text, source_type).parse();

    if parser_return.panicked || !parser_return.errors.is_empty() {
        let errors = parser_return
            .errors
            .into_iter()
            .map(|error| error.to_string())
            .collect::<Vec<_>>();
        return Err(if errors.is_empty() {
            "Oxc parser panicked without reporting a recoverable error.".to_string()
        } else {
            errors.join("\n")
        });
    }

    let mut diagnostics = Vec::new();
    let (mut actions, saw_define_action) =
        collect_action_candidates(&file, &parser_return.program, &mut diagnostics);
    let mut action_files = BTreeSet::new();

    if saw_define_action {
        action_files.insert(file.clone());
    }

    actions.sort_by(|left, right| {
        left.id
            .cmp(&right.id)
            .then_with(|| left.file.cmp(&right.file))
            .then_with(|| left.export_name.cmp(&right.export_name))
    });

    Ok(ActionDiscoveryResult {
        actions,
        action_files,
        diagnostics,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_file(root: &Path, relative: &str, contents: &str) -> std::path::PathBuf {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, contents).unwrap();
        path
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
}
