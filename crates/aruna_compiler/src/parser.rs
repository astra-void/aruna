use std::collections::HashSet;
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    BindingPattern, Declaration, ExportAllDeclaration, ExportNamedDeclaration, IdentifierReference,
    ImportDeclaration, ImportDeclarationSpecifier, Statement, StringLiteral, TSClassImplements,
    TSInterfaceHeritage, TSModuleDeclaration, TSType,
};
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::SourceType;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StaticImportRecord {
    pub specifier: String,
    pub start: usize,
    pub end: usize,
    // True when the import is erased from the compiled Luau, so it can never
    // load the imported module at runtime: `import type`, `export type ... from`,
    // `export type * from`, an import whose every specifier is `type`, or an
    // import none of whose bindings is read as a value (TypeScript, and so
    // roblox-ts, elides those). See `ValueReferences`.
    pub type_only: bool,
}

fn source_type_for_path(path: &Path) -> Result<SourceType, String> {
    SourceType::from_path(path).map_err(|error| error.to_string())
}

fn span_to_record(src: &StringLiteral<'_>, type_only: bool) -> StaticImportRecord {
    StaticImportRecord {
        specifier: src.value.to_string(),
        start: src.span.start as usize,
        end: src.span.end as usize,
        type_only,
    }
}

// The names a module reads as values: every identifier reference outside a
// type position. TypeScript elides an import whose bindings are never read as a
// value (only named in types, in `typeof` queries, in `implements`/interface
// `extends` clauses, or not at all), and roblox-ts compiles what TypeScript
// emits, so such an import never requires its module in Luau.
//
// Deliberately coarse, and always toward "runtime": it matches by name without
// scope analysis, so a local that shadows an import makes the import count as
// read. A shadowed name can only make an erased import look like a runtime one
// (an extra boundary report), never the other way round.
#[derive(Default)]
struct ValueReferences {
    names: HashSet<String>,
    type_depth: usize,
}

impl ValueReferences {
    fn in_type<F: FnOnce(&mut Self)>(&mut self, body: F) {
        self.type_depth += 1;
        body(self);
        self.type_depth -= 1;
    }
}

impl<'a> Visit<'a> for ValueReferences {
    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
        if self.type_depth == 0 {
            self.names.insert(it.name.to_string());
        }
    }

    fn visit_ts_type(&mut self, it: &TSType<'a>) {
        self.in_type(|this| walk::walk_ts_type(this, it));
    }

    fn visit_ts_interface_heritage(&mut self, it: &TSInterfaceHeritage<'a>) {
        self.in_type(|this| walk::walk_ts_interface_heritage(this, it));
    }

    fn visit_ts_class_implements(&mut self, it: &TSClassImplements<'a>) {
        self.in_type(|this| walk::walk_ts_class_implements(this, it));
    }

    // `declare module "x" { ... }` and `declare global { ... }` compile to nothing.
    fn visit_ts_module_declaration(&mut self, it: &TSModuleDeclaration<'a>) {
        if it.declare {
            self.in_type(|this| walk::walk_ts_module_declaration(this, it));
        } else {
            walk::walk_ts_module_declaration(self, it);
        }
    }

    // `export type { a }` and `export { type a }` re-export a name without
    // reading it as a value.
    fn visit_export_named_declaration(&mut self, it: &ExportNamedDeclaration<'a>) {
        if it.export_kind.is_type() {
            return;
        }
        if let Some(declaration) = &it.declaration {
            self.visit_declaration(declaration);
        }
        for specifier in &it.specifiers {
            if specifier.export_kind.is_type() || it.source.is_some() {
                continue;
            }
            self.visit_module_export_name(&specifier.local);
        }
    }

    fn visit_import_declaration(&mut self, _it: &ImportDeclaration<'a>) {}
}

fn import_is_type_only(decl: &ImportDeclaration<'_>, value_names: &HashSet<String>) -> bool {
    if decl.import_kind.is_type() {
        return true;
    }
    // `import "./x"` runs the module for its side effects, and `import {} from
    // "./x"` is kept the same way.
    let Some(specifiers) = &decl.specifiers else {
        return false;
    };
    if specifiers.is_empty() {
        return false;
    }
    specifiers.iter().all(|specifier| match specifier {
        ImportDeclarationSpecifier::ImportSpecifier(named) => {
            named.import_kind.is_type() || !value_names.contains(named.local.name.as_str())
        }
        ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
            !value_names.contains(default.local.name.as_str())
        }
        ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
            !value_names.contains(namespace.local.name.as_str())
        }
    })
}

// A re-export with a source is only known to be erased when it says so: whether
// `export { a } from "./x"` names a type is the imported module's business.
fn named_export_is_type_only(decl: &ExportNamedDeclaration<'_>) -> bool {
    decl.export_kind.is_type()
        || (!decl.specifiers.is_empty()
            && decl
                .specifiers
                .iter()
                .all(|specifier| specifier.export_kind.is_type()))
}

fn collect_from_statement(
    statement: &Statement<'_>,
    value_names: &HashSet<String>,
) -> Option<StaticImportRecord> {
    match statement {
        Statement::ImportDeclaration(decl) => Some(span_to_record(
            &decl.source,
            import_is_type_only(decl, value_names),
        )),
        Statement::ExportNamedDeclaration(decl) => decl
            .source
            .as_ref()
            .map(|source| span_to_record(source, named_export_is_type_only(decl))),
        Statement::ExportAllDeclaration(decl) => Some(collect_from_export_all(decl)),
        _ => None,
    }
}

fn collect_from_export_all(decl: &ExportAllDeclaration<'_>) -> StaticImportRecord {
    span_to_record(&decl.source, decl.export_kind.is_type())
}

fn collect_from_program(program: &oxc_ast::ast::Program<'_>) -> Vec<StaticImportRecord> {
    let mut references = ValueReferences::default();
    references.visit_program(program);

    let mut records = Vec::new();
    for statement in &program.body {
        if let Some(record) = collect_from_statement(statement, &references.names) {
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

    fn type_only_flags(source: &str) -> Vec<(String, bool)> {
        collect_static_imports(Path::new("src/shared/probe.tsx"), source)
            .unwrap()
            .into_iter()
            .map(|entry| (entry.specifier, entry.type_only))
            .collect()
    }

    #[test]
    fn marks_imports_typescript_erases_as_type_only() {
        let source = r#"
            import type { A } from "./type-import";
            import { type B, type C } from "./all-type-specifiers";
            import { D } from "./only-in-types";
            import * as Ns from "./namespace-in-types";
            import Default from "./default-in-types";
            import { Base } from "./heritage";
            import { Unused } from "./unused";
            export type { E } from "./type-reexport";
            export { type F } from "./type-specifier-reexport";
            export type * from "./type-star";
            type Uses = [A, B, C, D, Ns.Thing, Default, typeof Default];
            interface I extends Base {}
            class K implements Base {}
            declare module "./augmented" { const x: D; }
        "#;
        assert!(type_only_flags(source).iter().all(|(_, type_only)| *type_only));
    }

    #[test]
    fn keeps_imports_read_as_values_as_runtime_imports() {
        let source = r#"
            import { type T, value } from "./mixed";
            import Default from "./default-value";
            import * as Ns from "./namespace-value";
            import { Component } from "./jsx";
            import { reexported } from "./local-reexport";
            import "./side-effect";
            import {} from "./empty";
            export { named } from "./reexport";
            export * from "./star";
            export { reexported };
            const read = [value, Default, Ns.thing];
            const view = <Component />;
            class Derived extends Default {}
        "#;
        assert!(type_only_flags(source).iter().all(|(_, type_only)| !*type_only));
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
