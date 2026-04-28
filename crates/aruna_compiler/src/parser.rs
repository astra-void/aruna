use std::path::Path;
use swc_common::{sync::Lrc, FileName, SourceMap};
use swc_ecma_ast::{ExportAll, ImportDecl, Module, ModuleDecl, ModuleItem, NamedExport, Str};
use swc_ecma_parser::{lexer::Lexer, Parser, StringInput, Syntax, TsSyntax};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StaticImportRecord {
    pub specifier: String,
    pub start: usize,
    pub end: usize,
}

fn syntax_for_path(path: &Path) -> Syntax {
    let is_tsx = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("tsx"));
    Syntax::Typescript(TsSyntax {
        tsx: is_tsx,
        ..Default::default()
    })
}

fn span_to_record(source_map: &SourceMap, src: &Str) -> Result<StaticImportRecord, String> {
    let start = source_map.lookup_byte_offset(src.span.lo()).pos.0 as usize;
    let end = source_map.lookup_byte_offset(src.span.hi()).pos.0 as usize;
    let specifier = src
        .value
        .as_str()
        .map(|value| value.to_string())
        .unwrap_or_else(|| src.value.to_string_lossy().to_string());
    Ok(StaticImportRecord {
        specifier,
        start,
        end,
    })
}

fn collect_from_import_decl(
    source_map: &SourceMap,
    decl: &ImportDecl,
) -> Result<StaticImportRecord, String> {
    span_to_record(source_map, &decl.src)
}

fn collect_from_named_export(
    source_map: &SourceMap,
    decl: &NamedExport,
) -> Result<Option<StaticImportRecord>, String> {
    match &decl.src {
        Some(src) => Ok(Some(span_to_record(source_map, src)?)),
        None => Ok(None),
    }
}

fn collect_from_export_all(
    source_map: &SourceMap,
    decl: &ExportAll,
) -> Result<StaticImportRecord, String> {
    span_to_record(source_map, &decl.src)
}

fn collect_from_module(
    source_map: &SourceMap,
    module: &Module,
) -> Result<Vec<StaticImportRecord>, String> {
    let mut records = Vec::new();

    for item in &module.body {
        let ModuleItem::ModuleDecl(module_decl) = item else {
            continue;
        };

        match module_decl {
            ModuleDecl::Import(decl) => records.push(collect_from_import_decl(source_map, decl)?),
            ModuleDecl::ExportNamed(decl) => {
                if let Some(record) = collect_from_named_export(source_map, decl)? {
                    records.push(record);
                }
            }
            ModuleDecl::ExportAll(decl) => records.push(collect_from_export_all(source_map, decl)?),
            _ => {}
        }
    }

    Ok(records)
}

pub fn collect_static_imports(
    path: &Path,
    source_text: &str,
) -> Result<Vec<StaticImportRecord>, String> {
    let source_map: Lrc<SourceMap> = Default::default();
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    let filename = FileName::Custom(filename);
    let source_file = source_map.new_source_file(filename.into(), source_text.to_string());
    let lexer = Lexer::new(
        syntax_for_path(path),
        Default::default(),
        StringInput::from(&*source_file),
        None,
    );
    let mut parser = Parser::new_from(lexer);

    let module = parser
        .parse_module()
        .map_err(|error| format!("{error:?}"))?;

    let recoverable_errors = parser.take_errors();
    if !recoverable_errors.is_empty() {
        return Err(recoverable_errors
            .into_iter()
            .map(|error| format!("{error:?}"))
            .collect::<Vec<_>>()
            .join("\n"));
    }

    collect_from_module(&source_map, &module)
}

#[cfg(test)]
mod tests {
    use super::collect_static_imports;
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
