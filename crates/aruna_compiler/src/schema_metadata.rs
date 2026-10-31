// Static schema extraction: reads a `schema.*` expression (inline, through a
// local const, or through an import) into the metadata the manifest, the
// contract snapshot, and codegen work from, without running project code.

use crate::diagnostics::{ArunaDiagnostic, DiagnosticSpan};
use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, ArrayExpression, ArrayExpressionElement, BindingPattern, CallExpression,
    Declaration, Expression, ObjectExpression, ObjectPropertyKind, PropertyKey, Statement,
    VariableDeclarationKind,
};
use oxc_parser::Parser;
use oxc_span::GetSpan;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use crate::spans::*;
use crate::static_literals::*;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ArunaSchemaLiteralMetadata {
    String { value: String },
    Number { value: String },
    Boolean { value: bool },
    Undefined,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArunaSchemaMetadata {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub numeric_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub properties: Option<BTreeMap<String, ArunaSchemaMetadata>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Box<ArunaSchemaMetadata>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub literal: Option<ArunaSchemaLiteralMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<ArunaSchemaLiteralMetadata>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inner: Option<Box<ArunaSchemaMetadata>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<ArunaSchemaMetadata>>,
    // The bounds a constraint chain declares, kept when the argument is static: a
    // number literal, or a module-level `const` bound to one. `contract diff` and
    // the store gate judge a tightened or loosened schema by them, and the upper
    // ones bound a payload's encoded size. A string's `minLength`/`maxLength` are
    // UTF-8 bytes and `minChars`/`maxChars` code points; `.length(n)` sets both
    // ends of a string's bytes or an array's items. A chain that repeats a bound
    // keeps the tighter one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_length: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_length: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_chars: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_chars: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<serde_json::Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<serde_json::Number>,
    // `.int()` on a number.
    #[serde(default, skip_serializing_if = "is_false")]
    pub int: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_items: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_items: Option<u32>,
    // `.maxEntries(n)` on a record.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_entries: Option<u32>,
    // How many `.refine(...)` calls the chain makes. A predicate cannot be read,
    // but one more is a stricter schema and one fewer a looser one.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub refinements: u32,
    // Bounds whose argument is not static (`.maxLength(limit())`): the value is
    // bounded, but by an amount the compiler cannot compare. Sorted, no repeats.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dynamic_constraints: Vec<String>,
    // A hash of what the chain says that the fields above cannot: every
    // `.refine(...)` and every bound with a non-static argument, in order. A
    // change to it can be seen, though not judged. Omitted when there is none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub constraints_hash: Option<String>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

// FNV-1a, 64-bit: stable across platforms and builds, which a snapshot
// compared between machines needs. Not a security boundary.
pub(crate) fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

// One constraint call as hashed: its name and each argument's source with all
// whitespace removed, so reformatting (line breaks, a trailing comma) does not
// read as a change.
pub(crate) fn canonical_constraint_call(name: &str, call: &CallExpression<'_>, source: &str) -> String {
    let arguments: Vec<String> = call
        .arguments
        .iter()
        .map(|argument| {
            let span = argument.span();
            source
                .get(span.start as usize..span.end as usize)
                .unwrap_or_default()
                .chars()
                .filter(|character| !character.is_whitespace())
                .collect()
        })
        .collect();
    format!(".{name}({})", arguments.join(","))
}

// Extends a chain hash by one call: the hash of the previous hash followed by
// the call, so it covers the whole chain in order.
pub(crate) fn extend_constraints_hash(previous: Option<&str>, call: &str) -> String {
    let input = format!("{}{call}", previous.unwrap_or_default());
    format!("{:016x}", fnv1a_64(input.as_bytes()))
}

pub(crate) fn schema_contains_kind(schema: &ArunaSchemaMetadata, kind: &str) -> bool {
    schema.kind == kind
        || schema
            .properties
            .as_ref()
            .is_some_and(|properties| properties.values().any(|child| schema_contains_kind(child, kind)))
        || schema.items.as_deref().is_some_and(|child| schema_contains_kind(child, kind))
        || schema.inner.as_deref().is_some_and(|child| schema_contains_kind(child, kind))
        || schema
            .members
            .as_ref()
            .is_some_and(|members| members.iter().any(|child| schema_contains_kind(child, kind)))
}

#[derive(Clone, Debug, Copy, PartialEq, Eq)]
pub(crate) enum SchemaRole {
    Input,
    Output,
    Payload,
    Store,
}

impl SchemaRole {
    pub(crate) fn code(self) -> &'static str {
        match self {
            SchemaRole::Input => "aruna::553",
            SchemaRole::Output => "aruna::554",
            SchemaRole::Payload => "aruna::564",
            SchemaRole::Store => "aruna::572",
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            SchemaRole::Input => "input",
            SchemaRole::Output => "output",
            SchemaRole::Payload => "payload",
            SchemaRole::Store => "schema",
        }
    }
}

/// Module-level `const NAME = <schema expr>` bindings within a single file.
/// Lets a schema extracted to a variable resolve to the same metadata as if it
/// were written inline, instead of being rejected as a non-call expression.
pub(crate) type SchemaEnv<'a> = HashMap<&'a str, &'a Expression<'a>>;

pub(crate) fn collect_schema_bindings<'a>(program: &'a oxc_ast::ast::Program<'a>) -> SchemaEnv<'a> {
    let mut env: SchemaEnv<'a> = HashMap::new();

    for statement in &program.body {
        let variable_decl = match statement {
            Statement::VariableDeclaration(decl) => decl,
            Statement::ExportNamedDeclaration(export_decl) => {
                match &export_decl.declaration {
                    Some(Declaration::VariableDeclaration(decl)) => decl,
                    _ => continue,
                }
            }
            _ => continue,
        };

        if variable_decl.kind != VariableDeclarationKind::Const {
            continue;
        }

        for declarator in &variable_decl.declarations {
            let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
                continue;
            };
            let Some(init) = declarator.init.as_ref() else {
                continue;
            };
            // A later binding with the same name shadows an earlier one, matching
            // how the value would resolve at runtime.
            env.insert(binding.name.as_str(), init);
        }
    }

    env
}

/// Outcome of pre-resolving a named import as a schema (single hop).
pub(crate) enum ImportedSchemaResolution {
    Resolved(ArunaSchemaMetadata),
    Failed(String),
}

/// Local `const` bindings plus pre-resolved cross-module schema imports for one
/// file. Import resolution is a single hop: the hop target is parsed with an
/// empty import map, so a schema that itself references another module's import
/// fails with a clear reason instead of chasing the graph.
pub(crate) struct SchemaScope<'a> {
    env: SchemaEnv<'a>,
    imported: HashMap<String, ImportedSchemaResolution>,
    // The file's source, for hashing a schema's constraint chain.
    source: &'a str,
    // Per imported local name, every path the import hop consulted for it: each
    // candidate up to and including the one it read. What the binding resolved
    // to depends on exactly these files (and on whether the earlier candidates
    // exist).
    import_paths: HashMap<String, Vec<PathBuf>>,
    // The import paths of the bindings a schema expression actually looked up:
    // the files this scope's results depend on. A named import never used as a
    // schema (a helper from ./model) is not one, so editing that file does not
    // invalidate this one.
    used_import_paths: std::cell::RefCell<Vec<PathBuf>>,
}

/// Reads another project file during analysis — the one-hop schema import. The
/// one-shot compiler reads the disk; an incremental session reads through its
/// cache, so a check sees the same contents its invalidation tracks.
pub trait SourceReader {
    fn read_source(&self, path: &Path) -> Option<String>;
}

pub struct FsSourceReader;

impl SourceReader for FsSourceReader {
    fn read_source(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }
}

impl<'a> SchemaScope<'a> {
    /// The schemas `program` can name: its own module-level consts, and its
    /// relative imports resolved one hop.
    pub(crate) fn for_program(
        path: &Path,
        program: &'a oxc_ast::ast::Program<'a>,
        reader: &dyn SourceReader,
    ) -> Self {
        let mut import_paths = HashMap::new();
        let imported = resolve_imported_schema_bindings(path, program, reader, &mut import_paths);
        SchemaScope {
            env: collect_schema_bindings(program),
            imported,
            source: program.source_text,
            import_paths,
            used_import_paths: std::cell::RefCell::new(Vec::new()),
        }
    }

    /// An imported schema binding, recording the files it was resolved from as
    /// a dependency.
    fn lookup_imported(&self, name: &str) -> Option<&ImportedSchemaResolution> {
        let resolution = self.imported.get(name)?;
        if let Some(paths) = self.import_paths.get(name) {
            let mut used = self.used_import_paths.borrow_mut();
            for path in paths {
                if !used.contains(path) {
                    used.push(path.clone());
                }
            }
        }
        Some(resolution)
    }

    pub(crate) fn dependencies(&self) -> Vec<PathBuf> {
        self.used_import_paths.borrow().clone()
    }
}

/// Pre-resolves every relative named import of `program` as a potential schema
/// binding. Non-schema imports simply record a `Failed` reason; those entries
/// are only consulted when a schema expression actually references the name, so
/// they cost nothing otherwise.
pub(crate) fn resolve_imported_schema_bindings(
    current_path: &Path,
    program: &oxc_ast::ast::Program<'_>,
    reader: &dyn SourceReader,
    import_paths: &mut HashMap<String, Vec<PathBuf>>,
) -> HashMap<String, ImportedSchemaResolution> {
    let mut resolved: HashMap<String, ImportedSchemaResolution> = HashMap::new();
    let Some(base_dir) = current_path.parent() else {
        return resolved;
    };

    for statement in &program.body {
        let Statement::ImportDeclaration(import_decl) = statement else {
            continue;
        };
        let specifier = import_decl.source.value.as_str();
        if !(specifier.starts_with("./") || specifier.starts_with("../")) {
            continue;
        }
        let Some(specifiers) = &import_decl.specifiers else {
            continue;
        };

        // (local name, exported name in the target module)
        let mut requested: Vec<(String, String)> = Vec::new();
        for entry in specifiers {
            if let oxc_ast::ast::ImportDeclarationSpecifier::ImportSpecifier(named) = entry {
                requested.push((
                    named.local.name.as_str().to_string(),
                    named.imported.name().to_string(),
                ));
            }
        }
        if requested.is_empty() {
            continue;
        }

        let mut consulted = Vec::new();
        let mut target: Option<(std::path::PathBuf, String)> = None;
        for candidate in [
            base_dir.join(format!("{specifier}.ts")),
            base_dir.join(format!("{specifier}.tsx")),
            base_dir.join(specifier).join("index.ts"),
            base_dir.join(specifier).join("index.tsx"),
        ] {
            consulted.push(candidate.clone());
            if let Some(contents) = reader.read_source(&candidate) {
                target = Some((candidate, contents));
                break;
            }
        }
        for (local, _) in &requested {
            import_paths.insert(local.clone(), consulted.clone());
        }
        let Some((target_path, source_text)) = target else {
            for (local, _) in requested {
                resolved.insert(
                    local,
                    ImportedSchemaResolution::Failed(format!(
                        "the imported module `{specifier}` could not be read"
                    )),
                );
            }
            continue;
        };

        let Ok(source_type) = source_type_for_path(&target_path) else {
            continue;
        };
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, &source_text, source_type).parse();
        if parsed.panicked || !parsed.errors.is_empty() {
            for (local, _) in requested {
                resolved.insert(
                    local,
                    ImportedSchemaResolution::Failed(format!(
                        "the imported module `{specifier}` failed to parse"
                    )),
                );
            }
            continue;
        }

        let target_scope = SchemaScope {
            env: collect_schema_bindings(&parsed.program),
            imported: HashMap::new(),
            source: parsed.program.source_text,
            import_paths: HashMap::new(),
            used_import_paths: std::cell::RefCell::new(Vec::new()),
        };
        for (local, exported_name) in requested {
            let Some(expression) = target_scope.env.get(exported_name.as_str()).copied() else {
                resolved.insert(
                    local,
                    ImportedSchemaResolution::Failed(format!(
                        "`{exported_name}` is not a module-level const in `{specifier}`"
                    )),
                );
                continue;
            };
            // Scratch diagnostics: a failed hop parse reports one consolidated
            // reason at the reference site instead of leaking target-file spans.
            let mut scratch = Vec::new();
            match parse_schema_expression(
                "<import>",
                "<import>",
                &exported_name,
                SchemaRole::Input,
                expression,
                &target_scope,
                &mut scratch,
            ) {
                Some(metadata) => {
                    resolved.insert(local, ImportedSchemaResolution::Resolved(metadata));
                }
                None => {
                    resolved.insert(
                        local,
                        ImportedSchemaResolution::Failed(format!(
                            "`{exported_name}` in `{specifier}` is not a statically analyzable schema (only module-level `schema.*` consts resolve across one import hop)"
                        )),
                    );
                }
            }
        }
    }

    resolved
}

pub(crate) fn unwrap_schema_expression<'a>(expression: &'a Expression<'a>) -> &'a Expression<'a> {
    match expression {
        Expression::ParenthesizedExpression(parenthesized) => {
            unwrap_schema_expression(&parenthesized.expression)
        }
        Expression::TSAsExpression(expr) => unwrap_schema_expression(&expr.expression),
        Expression::TSSatisfiesExpression(expr) => unwrap_schema_expression(&expr.expression),
        Expression::TSNonNullExpression(expr) => unwrap_schema_expression(&expr.expression),
        Expression::TSTypeAssertion(expr) => unwrap_schema_expression(&expr.expression),
        Expression::TSInstantiationExpression(expr) => unwrap_schema_expression(&expr.expression),
        Expression::ChainExpression(expr) => match &expr.expression {
            oxc_ast::ast::ChainElement::CallExpression(call) => {
                unwrap_schema_expression(&call.callee)
            }
            oxc_ast::ast::ChainElement::ComputedMemberExpression(member) => {
                unwrap_schema_expression(&member.object)
            }
            oxc_ast::ast::ChainElement::StaticMemberExpression(member) => {
                unwrap_schema_expression(&member.object)
            }
            oxc_ast::ast::ChainElement::PrivateFieldExpression(member) => {
                unwrap_schema_expression(&member.object)
            }
            oxc_ast::ast::ChainElement::TSNonNullExpression(expr) => {
                unwrap_schema_expression(&expr.expression)
            }
        },
        _ => expression,
    }
}

pub(crate) fn literal_metadata_from_argument(argument: &Argument<'_>) -> Option<ArunaSchemaLiteralMetadata> {
    match argument {
        Argument::StringLiteral(literal) => Some(ArunaSchemaLiteralMetadata::String {
            value: literal.value.to_string(),
        }),
        Argument::NumericLiteral(literal) => Some(ArunaSchemaLiteralMetadata::Number {
            value: literal.value.to_string(),
        }),
        Argument::BooleanLiteral(literal) => Some(ArunaSchemaLiteralMetadata::Boolean {
            value: literal.value,
        }),
        Argument::Identifier(identifier) if identifier.name.as_str() == "undefined" => {
            Some(ArunaSchemaLiteralMetadata::Undefined)
        }
        _ => None,
    }
}

pub(crate) fn literal_metadata_from_array_element(
    element: &ArrayExpressionElement<'_>,
) -> Option<ArunaSchemaLiteralMetadata> {
    match element {
        ArrayExpressionElement::StringLiteral(literal) => Some(ArunaSchemaLiteralMetadata::String {
            value: literal.value.to_string(),
        }),
        ArrayExpressionElement::NumericLiteral(literal) => Some(ArunaSchemaLiteralMetadata::Number {
            value: literal.value.to_string(),
        }),
        ArrayExpressionElement::BooleanLiteral(literal) => Some(ArunaSchemaLiteralMetadata::Boolean {
            value: literal.value,
        }),
        ArrayExpressionElement::Identifier(identifier) if identifier.name.as_str() == "undefined" => {
            Some(ArunaSchemaLiteralMetadata::Undefined)
        }
        _ => None,
    }
}

pub(crate) fn parse_schema_expression<'a>(
    file: &str,
    action_id: &str,
    export_name: &str,
    role: SchemaRole,
    expression: &'a Expression<'a>,
    scope: &SchemaScope<'a>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<ArunaSchemaMetadata> {
    let mut current = unwrap_schema_expression(expression);
    // Follow `const a = b; const b = schema.string()` chains, guarding against a
    // binding that refers (directly or transitively) back to itself.
    let mut seen: Vec<&'a str> = Vec::new();

    loop {
        match current {
            Expression::CallExpression(call) => {
                return parse_schema_call(file, action_id, export_name, role, call, scope, diagnostics);
            }
            Expression::Identifier(identifier) => {
                let name = identifier.name.as_str();

                let Some(resolved) = scope.env.get(name).copied() else {
                    // Not a local const — check the pre-resolved import map
                    // (single hop into the module that exports the schema).
                    match scope.lookup_imported(name) {
                        Some(ImportedSchemaResolution::Resolved(metadata)) => {
                            return Some(metadata.clone());
                        }
                        Some(ImportedSchemaResolution::Failed(reason)) => {
                            diagnostics.push(schema_unresolved_diagnostic(
                                file,
                                action_id,
                                export_name,
                                role,
                                schema_span_from_expression(current),
                                format!(
                                    "The imported schema `{name}` could not be resolved: {reason}."
                                ),
                            ));
                            return None;
                        }
                        None => {
                            diagnostics.push(schema_unresolved_diagnostic(
                                file,
                                action_id,
                                export_name,
                                role,
                                schema_span_from_expression(current),
                                format!(
                                    "The schema variable `{name}` could not be resolved. Declare it as a module-level `const` schema in this file, or import it from the module that declares it."
                                ),
                            ));
                            return None;
                        }
                    }
                };

                if seen.contains(&name) {
                    diagnostics.push(schema_invalid_diagnostic(
                        file,
                        action_id,
                        export_name,
                        role,
                        schema_span_from_expression(current),
                        format!("The schema variable `{name}` refers to itself."),
                    ));
                    return None;
                }

                seen.push(name);
                current = unwrap_schema_expression(resolved);
            }
            _ => {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    schema_span_from_expression(current),
                    "The schema expression must be a call such as schema.string() or schema.object({...})."
                        .to_string(),
                ));
                return None;
            }
        }
    }
}

pub(crate) fn parse_schema_union_members<'a>(
    file: &str,
    action_id: &str,
    export_name: &str,
    role: SchemaRole,
    array: &'a ArrayExpression<'a>,
    scope: &SchemaScope<'a>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<Vec<ArunaSchemaMetadata>> {
    if array.elements.is_empty() {
        diagnostics.push(schema_invalid_diagnostic(
            file,
            action_id,
            export_name,
            role,
            DiagnosticSpan {
                start: array.span.start as usize,
                end: array.span.end as usize,
            },
            "union schemas require at least one member schema.".to_string(),
        ));
        return None;
    }

    let mut members = Vec::new();
    for element in &array.elements {
        let Some(expression) = element.as_expression() else {
            diagnostics.push(schema_invalid_diagnostic(
                file,
                action_id,
                export_name,
                role,
                DiagnosticSpan {
                    start: element.span().start as usize,
                    end: element.span().end as usize,
                },
                "union members must be schema expressions such as schema.string().".to_string(),
            ));
            return None;
        };

        let Some(member) = parse_schema_expression(
            file,
            action_id,
            export_name,
            role,
            expression,
            scope,
            diagnostics,
        ) else {
            return None;
        };
        members.push(member);
    }

    Some(members)
}

pub(crate) fn parse_schema_argument<'a>(
    file: &str,
    action_id: &str,
    export_name: &str,
    role: SchemaRole,
    argument: &'a Argument<'a>,
    scope: &SchemaScope<'a>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<ArunaSchemaMetadata> {
    if let Argument::SpreadElement(_) = argument {
        diagnostics.push(schema_invalid_diagnostic(
            file,
            action_id,
            export_name,
            role,
            DiagnosticSpan {
                start: argument.span().start as usize,
                end: argument.span().end as usize,
            },
            "Spread arguments are not valid schema expressions.".to_string(),
        ));
        return None;
    }

    let Some(expression) = argument.as_expression() else {
        diagnostics.push(schema_invalid_diagnostic(
            file,
            action_id,
            export_name,
            role,
            DiagnosticSpan {
                start: argument.span().start as usize,
                end: argument.span().end as usize,
            },
            "The schema argument must be a schema call such as schema.string().".to_string(),
        ));
        return None;
    };

    parse_schema_expression(file, action_id, export_name, role, expression, scope, diagnostics)
}

pub(crate) fn parse_schema_array_values(
    file: &str,
    action_id: &str,
    export_name: &str,
    role: SchemaRole,
    array: &ArrayExpression<'_>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<Vec<ArunaSchemaLiteralMetadata>> {
    let mut values = Vec::new();

    for element in &array.elements {
        let value = match element {
            ArrayExpressionElement::SpreadElement(_) | ArrayExpressionElement::Elision(_) => {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: element.span().start as usize,
                        end: element.span().end as usize,
                    },
                    "Enum values must be a flat array of literal values.".to_string(),
                ));
                return None;
            }
            _ => match literal_metadata_from_array_element(element) {
                Some(value) => value,
                None => {
                    diagnostics.push(schema_invalid_diagnostic(
                        file,
                        action_id,
                        export_name,
                        role,
                        DiagnosticSpan {
                            start: element.span().start as usize,
                            end: element.span().end as usize,
                        },
                    "Enum values must be literal values such as strings, numbers, booleans, or undefined."
                            .to_string(),
                ));
                return None;
            }
            },
        };
        values.push(value);
    }

    Some(values)
}

pub(crate) fn parse_schema_object<'a>(
    file: &str,
    action_id: &str,
    export_name: &str,
    role: SchemaRole,
    object: &'a ObjectExpression<'a>,
    scope: &SchemaScope<'a>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<ArunaSchemaMetadata> {
    let mut properties = BTreeMap::new();

    for property in &object.properties {
        let ObjectPropertyKind::ObjectProperty(object_property) = property else {
            diagnostics.push(schema_invalid_diagnostic(
                file,
                action_id,
                export_name,
                role,
                DiagnosticSpan {
                    start: property.span().start as usize,
                    end: property.span().end as usize,
                },
                "Object schemas cannot use spread properties.".to_string(),
            ));
            return None;
        };

        let Some(name) = (match &object_property.key {
            PropertyKey::StaticIdentifier(ident) => Some(ident.name.as_str().to_string()),
            PropertyKey::StringLiteral(literal) => Some(literal.value.to_string()),
            _ => None,
        }) else {
            diagnostics.push(schema_invalid_diagnostic(
                file,
                action_id,
                export_name,
                role,
                DiagnosticSpan {
                    start: object_property.span.start as usize,
                    end: object_property.span.end as usize,
                },
                "Object schema keys must be static identifiers or string literals.".to_string(),
            ));
            return None;
        };

        let Some(child) = parse_schema_expression(
            file,
            action_id,
            export_name,
            role,
            &object_property.value,
            scope,
            diagnostics,
        ) else {
            return None;
        };

        properties.insert(name, child);
    }

    Some(ArunaSchemaMetadata {
        kind: "object".to_string(),
        properties: Some(properties),
        ..Default::default()
    })
}

// Chainable constraint/refine method names. These attach runtime validation to
// a schema without changing its rendered TypeScript type or wire format, so the
// parser unwraps them to the underlying schema and records them on it.
pub(crate) fn is_chain_constraint_method(name: &str) -> bool {
    matches!(
        name,
        "min" | "max"
            | "int"
            | "length"
            | "minLength"
            | "maxLength"
            | "minItems"
            | "maxItems"
            | "minChars"
            | "maxChars"
            | "maxEntries"
            | "refine"
    )
}

// A constraint's argument as a number, when the compiler can know it: a number
// literal (negated or not), or a module-level `const` bound to one.
fn static_number_argument(call: &CallExpression<'_>, scope: &SchemaScope<'_>) -> Option<f64> {
    if call.arguments.len() != 1 {
        return None;
    }
    static_number(call.arguments.first()?.as_expression()?, scope, 0)
}

fn static_number(expression: &Expression<'_>, scope: &SchemaScope<'_>, depth: u8) -> Option<f64> {
    match unwrap_schema_expression(expression) {
        Expression::NumericLiteral(literal) => Some(literal.value),
        Expression::UnaryExpression(unary)
            if unary.operator == oxc_ast::ast::UnaryOperator::UnaryNegation =>
        {
            static_number(&unary.argument, scope, depth).map(|value| -value)
        }
        // `const MAX = 20` — followed a few hops, so a cycle cannot loop.
        Expression::Identifier(identifier) if depth < 4 => {
            static_number(scope.env.get(identifier.name.as_str())?, scope, depth + 1)
        }
        _ => None,
    }
}

// A length or count bound: a non-negative integer. Anything else is not one the
// compiler can compare (the runtime still checks it).
fn length_bound(value: f64) -> Option<u32> {
    (value >= 0.0 && value.fract() == 0.0 && value <= f64::from(u32::MAX)).then(|| value as u32)
}

// A number bound as JSON: an integer when it is one, so `.min(0)` records `0`
// rather than `0.0`.
fn number_bound(value: f64) -> Option<serde_json::Number> {
    if value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
        Some(serde_json::Number::from(value as i64))
    } else {
        serde_json::Number::from_f64(value)
    }
}

fn raise_length(slot: &mut Option<u32>, value: u32) {
    *slot = Some(slot.map_or(value, |current| current.max(value)));
}

fn lower_length(slot: &mut Option<u32>, value: u32) {
    *slot = Some(slot.map_or(value, |current| current.min(value)));
}

fn raise_number(slot: &mut Option<serde_json::Number>, value: serde_json::Number) {
    let keep_current = slot
        .as_ref()
        .is_some_and(|current| current.as_f64() >= value.as_f64());
    if !keep_current {
        *slot = Some(value);
    }
}

fn lower_number(slot: &mut Option<serde_json::Number>, value: serde_json::Number) {
    let keep_current = slot
        .as_ref()
        .is_some_and(|current| current.as_f64() <= value.as_f64());
    if !keep_current {
        *slot = Some(value);
    }
}

// Records one constraint call on the schema it applies to. A bound with a
// static argument is kept as its value; `.int()` as a flag; a `.refine(...)` is
// counted. What cannot be read — a predicate, a bound computed at runtime — goes
// into `constraints_hash`, and a bound computed at runtime is also named in
// `dynamic_constraints`, so it still counts as a bound.
fn record_constraint(
    schema: &mut ArunaSchemaMetadata,
    name: &str,
    call: &CallExpression<'_>,
    scope: &SchemaScope<'_>,
) {
    let hash_call = |schema: &mut ArunaSchemaMetadata| {
        schema.constraints_hash = Some(extend_constraints_hash(
            schema.constraints_hash.as_deref(),
            &canonical_constraint_call(name, call, scope.source),
        ));
    };
    let kind = schema.kind.clone();
    if name == "refine" {
        schema.refinements += 1;
        hash_call(schema);
        return;
    }
    if (kind.as_str(), name) == ("number", "int") {
        schema.int = true;
        return;
    }

    let value = static_number_argument(call, scope);
    let length = value.and_then(length_bound);
    let recorded = match (kind.as_str(), name) {
        ("string", "minLength") => length.map(|bound| raise_length(&mut schema.min_length, bound)),
        ("string", "maxLength") => length.map(|bound| lower_length(&mut schema.max_length, bound)),
        ("string", "length") => length.map(|bound| {
            raise_length(&mut schema.min_length, bound);
            lower_length(&mut schema.max_length, bound);
        }),
        ("string", "minChars") => length.map(|bound| raise_length(&mut schema.min_chars, bound)),
        ("string", "maxChars") => length.map(|bound| lower_length(&mut schema.max_chars, bound)),
        ("array", "minItems") => length.map(|bound| raise_length(&mut schema.min_items, bound)),
        ("array", "maxItems") => length.map(|bound| lower_length(&mut schema.max_items, bound)),
        ("array", "length") => length.map(|bound| {
            raise_length(&mut schema.min_items, bound);
            lower_length(&mut schema.max_items, bound);
        }),
        ("record", "maxEntries") => {
            length.map(|bound| lower_length(&mut schema.max_entries, bound))
        }
        ("number", "min") => value
            .and_then(number_bound)
            .map(|bound| raise_number(&mut schema.min, bound)),
        ("number", "max") => value
            .and_then(number_bound)
            .map(|bound| lower_number(&mut schema.max, bound)),
        // A method this kind does not have at runtime: nothing to judge it by.
        _ => {
            hash_call(schema);
            return;
        }
    };
    if recorded.is_none() {
        if !schema.dynamic_constraints.iter().any(|existing| existing == name) {
            schema.dynamic_constraints.push(name.to_string());
            schema.dynamic_constraints.sort();
        }
        hash_call(schema);
    }
}

pub(crate) fn parse_schema_call<'a>(
    file: &str,
    action_id: &str,
    export_name: &str,
    role: SchemaRole,
    call: &'a CallExpression<'a>,
    scope: &SchemaScope<'a>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> Option<ArunaSchemaMetadata> {
    let Expression::StaticMemberExpression(member) = unwrap_schema_expression(&call.callee) else {
        diagnostics.push(schema_invalid_diagnostic(
            file,
            action_id,
            export_name,
            role,
            DiagnosticSpan {
                start: call.span.start as usize,
                end: call.span.end as usize,
            },
            "Schema calls must use the schema.<name>() form.".to_string(),
        ));
        return None;
    };

    // Chained constraint/refine methods (schema.number().min(0), .refine(fn, msg),
    // .maxLength(20), ...) are runtime-only: they do not change the rendered type
    // or the wire format. Parse the receiver as the real schema and record the
    // constraint on it (see `record_constraint`), for the contract diff, the
    // store gate, and a payload's size bound.
    let constraint = member.property.name.as_str();
    if is_chain_constraint_method(constraint) {
        if let Expression::CallExpression(inner_call) = unwrap_schema_expression(&member.object) {
            let mut parsed = parse_schema_call(
                file, action_id, export_name, role, inner_call, scope, diagnostics,
            )?;
            record_constraint(&mut parsed, constraint, call, scope);
            return Some(parsed);
        }
    }

    // `.default(v)`: the client may omit the field (server fills it), so the
    // generated type is optional. Emitted as an `optional` wrapper around the
    // inner schema; the default value itself is runtime-only and dropped.
    if member.property.name.as_str() == "default" {
        if let Expression::CallExpression(inner_call) = unwrap_schema_expression(&member.object) {
            let inner = parse_schema_call(
                file, action_id, export_name, role, inner_call, scope, diagnostics,
            )?;
            return Some(ArunaSchemaMetadata {
                kind: "optional".to_string(),
                inner: Some(Box::new(inner)),
                ..Default::default()
            });
        }
    }

    let Expression::Identifier(object) = &member.object else {
        diagnostics.push(schema_invalid_diagnostic(
            file,
            action_id,
            export_name,
            role,
            DiagnosticSpan {
                start: call.span.start as usize,
                end: call.span.end as usize,
            },
            "Schema calls must be invoked from the schema namespace.".to_string(),
        ));
        return None;
    };

    if object.name.as_str() != "schema" {
        diagnostics.push(schema_invalid_diagnostic(
            file,
            action_id,
            export_name,
            role,
            DiagnosticSpan {
                start: call.span.start as usize,
                end: call.span.end as usize,
            },
            "Schema calls must be invoked from the schema namespace.".to_string(),
        ));
        return None;
    }

    let kind = member.property.name.as_str();
    match kind {
        // Argument-less leaf schemas. The Roblox userdata kinds (vector3/color3/
        // cframe) map to native Vector3/Color3/CFrame and travel over the wire
        // natively or as packed f32 components via the binary codec.
        "string" | "number" | "boolean" | "vector3" | "vector2" | "color3" | "cframe" | "udim"
        | "udim2" | "dateTime" | "brickColor" | "instance" => {
            if !call.arguments.is_empty() {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    format!("{kind} schemas do not accept arguments."),
                ));
                return None;
            }

            Some(ArunaSchemaMetadata {
                kind: kind.to_string(),
                ..Default::default()
            })
        }
        "f32" | "u8" | "u16" | "u32" | "i8" | "i16" | "i32" => {
            if !call.arguments.is_empty() {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    format!("{kind} schemas do not accept arguments."),
                ));
                return None;
            }

            // Numeric width hints render as plain `number` in TypeScript; the
            // width is preserved as metadata for the binary codec, inspect, and
            // contract diffs. Plain `schema.number()` stays format-less (f64).
            Some(ArunaSchemaMetadata {
                kind: "number".to_string(),
                numeric_format: Some(kind.to_string()),
                ..Default::default()
            })
        }
        "literal" => {
            let Some(argument) = call.arguments.first() else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "literal schemas require exactly one literal argument.".to_string(),
                ));
                return None;
            };

            if call.arguments.len() != 1 {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "literal schemas require exactly one literal argument.".to_string(),
                ));
                return None;
            }

            let Some(value) = literal_metadata_from_argument(argument) else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: argument.span().start as usize,
                        end: argument.span().end as usize,
                    },
                    "literal schemas only accept string, number, boolean, or undefined values."
                        .to_string(),
                ));
                return None;
            };

            Some(ArunaSchemaMetadata {
                kind: kind.to_string(),
                literal: Some(value),
                ..Default::default()
            })
        }
        "array" => {
            let Some(argument) = call.arguments.first() else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "array schemas require exactly one schema argument.".to_string(),
                ));
                return None;
            };

            if call.arguments.len() != 1 {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "array schemas require exactly one schema argument.".to_string(),
                ));
                return None;
            }

            let Some(items) = parse_schema_argument(
                file,
                action_id,
                export_name,
                role,
                argument,
                scope,
                diagnostics,
            ) else {
                return None;
            };

            Some(ArunaSchemaMetadata {
                kind: kind.to_string(),
                items: Some(Box::new(items)),
                ..Default::default()
            })
        }
        "object" => {
            let Some(argument) = call.arguments.first() else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "object schemas require exactly one object literal argument.".to_string(),
                ));
                return None;
            };

            if call.arguments.len() != 1 {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "object schemas require exactly one object literal argument.".to_string(),
                ));
                return None;
            }

            let Argument::ObjectExpression(object) = argument else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: argument.span().start as usize,
                        end: argument.span().end as usize,
                    },
                    "object schemas require a plain object literal argument.".to_string(),
                ));
                return None;
            };

            parse_schema_object(file, action_id, export_name, role, object, scope, diagnostics)
        }
        "optional" => {
            let Some(argument) = call.arguments.first() else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "optional schemas require exactly one schema argument.".to_string(),
                ));
                return None;
            };

            if call.arguments.len() != 1 {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "optional schemas require exactly one schema argument.".to_string(),
                ));
                return None;
            }

            let Some(inner) = parse_schema_argument(
                file,
                action_id,
                export_name,
                role,
                argument,
                scope,
                diagnostics,
            ) else {
                return None;
            };

            Some(ArunaSchemaMetadata {
                kind: kind.to_string(),
                inner: Some(Box::new(inner)),
                ..Default::default()
            })
        }
        "enum" => {
            let Some(argument) = call.arguments.first() else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "enum schemas require exactly one array literal argument.".to_string(),
                ));
                return None;
            };

            if call.arguments.len() != 1 {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "enum schemas require exactly one array literal argument.".to_string(),
                ));
                return None;
            }

            let Argument::ArrayExpression(array) = argument else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: argument.span().start as usize,
                        end: argument.span().end as usize,
                    },
                    "enum schemas require an array literal of schema.literal(...) values."
                        .to_string(),
                ));
                return None;
            };

            let Some(values) = parse_schema_array_values(
                file,
                action_id,
                export_name,
                role,
                array,
                diagnostics,
            ) else {
                return None;
            };

            Some(ArunaSchemaMetadata {
                kind: kind.to_string(),
                values: Some(values),
                ..Default::default()
            })
        }
        "union" => {
            let Some(argument) = call.arguments.first() else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "union schemas require exactly one array literal argument.".to_string(),
                ));
                return None;
            };

            if call.arguments.len() != 1 {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "union schemas require exactly one array literal argument.".to_string(),
                ));
                return None;
            }

            let Argument::ArrayExpression(array) = argument else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: argument.span().start as usize,
                        end: argument.span().end as usize,
                    },
                    "union schemas require an array literal of schema members.".to_string(),
                ));
                return None;
            };

            let Some(members) = parse_schema_union_members(
                file,
                action_id,
                export_name,
                role,
                array,
                scope,
                diagnostics,
            ) else {
                return None;
            };

            Some(ArunaSchemaMetadata {
                kind: kind.to_string(),
                members: Some(members),
                ..Default::default()
            })
        }
        // A tagged union: `discriminant` key + an array of object schemas. It has
        // the same TS type and wire form as a plain union, so it is emitted as
        // `kind: "union"` and the discriminant (a runtime-only dispatch hint) is
        // dropped from the metadata.
        "discriminatedUnion" => {
            if call.arguments.len() != 2 {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "discriminatedUnion schemas require a discriminant string literal and an array literal of object schemas.".to_string(),
                ));
                return None;
            }

            let Argument::StringLiteral(_) = &call.arguments[0] else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.arguments[0].span().start as usize,
                        end: call.arguments[0].span().end as usize,
                    },
                    "discriminatedUnion's first argument must be a string literal discriminant key.".to_string(),
                ));
                return None;
            };

            let Argument::ArrayExpression(array) = &call.arguments[1] else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.arguments[1].span().start as usize,
                        end: call.arguments[1].span().end as usize,
                    },
                    "discriminatedUnion's second argument must be an array literal of object schemas.".to_string(),
                ));
                return None;
            };

            let Some(members) = parse_schema_union_members(
                file,
                action_id,
                export_name,
                role,
                array,
                scope,
                diagnostics,
            ) else {
                return None;
            };

            Some(ArunaSchemaMetadata {
                kind: "union".to_string(),
                members: Some(members),
                ..Default::default()
            })
        }
        // A homogeneous string-keyed map. The value schema rides the `items`
        // metadata slot (like an array's element), so no new metadata field is
        // needed and existing snapshot consumers stay parseable.
        "record" => {
            let Some(argument) = call.arguments.first() else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "record schemas require exactly one schema argument.".to_string(),
                ));
                return None;
            };

            if call.arguments.len() != 1 {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "record schemas require exactly one schema argument.".to_string(),
                ));
                return None;
            }

            let Some(items) = parse_schema_argument(
                file,
                action_id,
                export_name,
                role,
                argument,
                scope,
                diagnostics,
            ) else {
                return None;
            };

            Some(ArunaSchemaMetadata {
                kind: kind.to_string(),
                items: Some(Box::new(items)),
                ..Default::default()
            })
        }
        // A fixed-length heterogeneous array. Element schemas ride the `members`
        // metadata slot (like a union's members), in positional order.
        "tuple" => {
            let Some(argument) = call.arguments.first() else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "tuple schemas require exactly one array literal argument.".to_string(),
                ));
                return None;
            };

            if call.arguments.len() != 1 {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: call.span.start as usize,
                        end: call.span.end as usize,
                    },
                    "tuple schemas require exactly one array literal argument.".to_string(),
                ));
                return None;
            }

            let Argument::ArrayExpression(array) = argument else {
                diagnostics.push(schema_invalid_diagnostic(
                    file,
                    action_id,
                    export_name,
                    role,
                    DiagnosticSpan {
                        start: argument.span().start as usize,
                        end: argument.span().end as usize,
                    },
                    "tuple schemas require an array literal of element schemas.".to_string(),
                ));
                return None;
            };

            let Some(members) = parse_schema_union_members(
                file,
                action_id,
                export_name,
                role,
                array,
                scope,
                diagnostics,
            ) else {
                return None;
            };

            Some(ArunaSchemaMetadata {
                kind: kind.to_string(),
                members: Some(members),
                ..Default::default()
            })
        }
        _ => {
            diagnostics.push(schema_invalid_diagnostic(
                file,
                action_id,
                export_name,
                role,
                DiagnosticSpan {
                    start: call.span.start as usize,
                    end: call.span.end as usize,
                },
                format!("Unsupported schema helper: schema.{kind}()"),
            ));
            None
        }
    }
}

pub(crate) fn extract_action_schema<'a>(
    file: &str,
    action_id: &str,
    export_name: &str,
    role: SchemaRole,
    object: &'a ObjectExpression<'a>,
    property_name: &str,
    scope: &SchemaScope<'a>,
    diagnostics: &mut Vec<ArunaDiagnostic>,
) -> (bool, Option<ArunaSchemaMetadata>) {
    let Some(property) = find_object_property(object, property_name) else {
        return (false, None);
    };

    (
        true,
        parse_schema_expression(
            file,
            action_id,
            export_name,
            role,
            &property.value,
            scope,
            diagnostics,
        ),
    )
}
