use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    BindingPattern, Declaration, ExportAllDeclaration, ExportNamedDeclaration, ImportDeclaration,
    Statement, StringLiteral,
};
use oxc_parser::Parser;
use oxc_span::SourceType;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StaticImportRecord {
    pub specifier: String,
    pub start: usize,
    pub end: usize,
}

fn source_type_for_path(path: &Path) -> Result<SourceType, String> {
    SourceType::from_path(path).map_err(|error| error.to_string())
}

fn span_to_record(src: &StringLiteral<'_>) -> StaticImportRecord {
    StaticImportRecord {
        specifier: src.value.to_string(),
        start: src.span.start as usize,
        end: src.span.end as usize,
    }
}

fn collect_from_import_decl(decl: &ImportDeclaration<'_>) -> StaticImportRecord {
    span_to_record(&decl.source)
}

fn collect_from_named_export(decl: &ExportNamedDeclaration<'_>) -> Option<StaticImportRecord> {
    decl.source.as_ref().map(span_to_record)
}

fn collect_from_export_all(decl: &ExportAllDeclaration<'_>) -> StaticImportRecord {
    span_to_record(&decl.source)
}

fn collect_from_statement(statement: &Statement<'_>) -> Option<StaticImportRecord> {
    match statement {
        Statement::ImportDeclaration(decl) => Some(collect_from_import_decl(decl)),
        Statement::ExportNamedDeclaration(decl) => collect_from_named_export(decl),
        Statement::ExportAllDeclaration(decl) => Some(collect_from_export_all(decl)),
        _ => None,
    }
}

fn collect_from_program(program: &oxc_ast::ast::Program<'_>) -> Vec<StaticImportRecord> {
    let mut records = Vec::new();

    for statement in &program.body {
        if let Some(record) = collect_from_statement(statement) {
            records.push(record);
        }
    }

    records
}

pub fn collect_static_imports(
    path: &Path,
    source_text: &str,
) -> Result<Vec<StaticImportRecord>, String> {
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

    Ok(collect_from_program(&parser_return.program))
}

// Collects the value-level export names of a module: `export const`/`let`,
// `export function`, `export class`, `export enum`, and `export { a, b as c }`
// specifiers. Type-only exports (`export type`, interfaces, type aliases) are
// skipped — they cannot be runtime hooks. Used to discover hook-module exports
// for the generated entries (entries: "generated").
pub fn collect_module_exports(path: &Path, source_text: &str) -> Result<Vec<String>, String> {
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

    let mut names = Vec::new();
    for statement in &parser_return.program.body {
        match statement {
            Statement::ExportNamedDeclaration(decl) => {
                collect_named_export_names(decl, &mut names);
            }
            Statement::ExportDefaultDeclaration(_) => {
                names.push("default".to_string());
            }
            _ => {}
        }
    }
    Ok(names)
}

fn collect_named_export_names(decl: &ExportNamedDeclaration<'_>, names: &mut Vec<String>) {
    if decl.export_kind.is_type() {
        return;
    }

    if let Some(declaration) = &decl.declaration {
        match declaration {
            Declaration::VariableDeclaration(variable_decl) => {
                for declarator in &variable_decl.declarations {
                    if let BindingPattern::BindingIdentifier(binding) = &declarator.id {
                        names.push(binding.name.to_string());
                    }
                }
            }
            Declaration::FunctionDeclaration(function_decl) => {
                if let Some(id) = &function_decl.id {
                    names.push(id.name.to_string());
                }
            }
            Declaration::ClassDeclaration(class_decl) => {
                if let Some(id) = &class_decl.id {
                    names.push(id.name.to_string());
                }
            }
            Declaration::TSEnumDeclaration(enum_decl) => {
                names.push(enum_decl.id.name.to_string());
            }
            _ => {}
        }
        return;
    }

    for specifier in &decl.specifiers {
        if specifier.export_kind.is_type() {
            continue;
        }
        names.push(specifier.exported.name().to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::{collect_module_exports, collect_static_imports};
    use std::path::Path;

    fn specifiers(source: &str) -> Vec<String> {
        collect_static_imports(Path::new("src/client/main.ts"), source)
            .unwrap()
            .into_iter()
            .map(|entry| entry.specifier)
            .collect()
    }

    #[test]
    fn extracts_default_namespace_named_and_side_effect_imports() {
        let source = r#"
            import defaultExport from "./default";
            import * as namespace from "./namespace";
            import { value } from "./named";
            import "./side-effect";
            export { x } from "./re-export";
            export * from "./star";
        "#;

        assert_eq!(
            specifiers(source),
            vec![
                "./default".to_string(),
                "./namespace".to_string(),
                "./named".to_string(),
                "./side-effect".to_string(),
                "./re-export".to_string(),
                "./star".to_string(),
            ]
        );
    }

    #[test]
    fn extracts_type_only_imports_and_exports() {
        let source = r#"
            import type { X } from "./type-import";
            export type { X } from "./type-export";
        "#;

        assert_eq!(
            specifiers(source),
            vec!["./type-import".to_string(), "./type-export".to_string()]
        );
    }

    #[test]
    fn parses_tsx_files_with_jsx() {
        let source = r#"
            import { view } from "./view";
            export const panel = <div>{view}</div>;
        "#;

        let imports = collect_static_imports(Path::new("src/client/panel.tsx"), source).unwrap();
        assert_eq!(
            imports
                .iter()
                .map(|entry| entry.specifier.as_str())
                .collect::<Vec<_>>(),
            vec!["./view"]
        );
    }

    #[test]
    fn collects_value_level_module_exports() {
        let source = r#"
            import type { ServerApp } from "aruna/server";

            export const middleware = [];
            export function configure(app: ServerApp) {}
            export class Helper {}
            const onError = () => {};
            export { onError };
            export type Ignored = string;
            export interface AlsoIgnored {}
            export default onError;
        "#;

        let exports = collect_module_exports(Path::new("src/server.ts"), source).unwrap();
        assert_eq!(
            exports,
            vec![
                "middleware".to_string(),
                "configure".to_string(),
                "Helper".to_string(),
                "onError".to_string(),
                "default".to_string(),
            ]
        );
    }

    #[test]
    fn skips_type_only_export_specifiers() {
        let source = r#"
            type Local = number;
            export type { Local };
            export {};
        "#;

        let exports = collect_module_exports(Path::new("src/client.ts"), source).unwrap();
        assert!(exports.is_empty());
    }

    #[test]
    fn ignores_comments_and_string_literals_containing_import() {
        let source = r#"
            // import "./ignored-a";
            /*
             * export * from "./ignored-b";
             */
            const text = "import './ignored-c'";
            import "./actual";
        "#;

        assert_eq!(specifiers(source), vec!["./actual".to_string()]);
    }

    #[test]
    fn ignores_dynamic_import_and_require() {
        let source = r#"
            await import("./dynamic");
            const required = require("./require");
            import "./static";
        "#;

        assert_eq!(specifiers(source), vec!["./static".to_string()]);
    }

    #[test]
    fn preserves_literal_spans_including_quotes() {
        let source = r#"
            import { schema } from "./shared/schema";
        "#;

        let imports = collect_static_imports(Path::new("src/client/main.ts"), source).unwrap();
        assert_eq!(imports.len(), 1);
        assert_eq!(imports[0].specifier, "./shared/schema");
        assert_eq!((imports[0].start, imports[0].end), (36, 53));
    }
}
