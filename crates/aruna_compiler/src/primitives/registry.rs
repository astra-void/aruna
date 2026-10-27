// The `Primitive` abstraction and the machinery every primitive shares: one
// parse per file, one walk over its `export const x = define*(...)`
// declarations, and the registry that runs each primitive's discovery and
// whole-project checks in a fixed order.
//
// A primitive is a trait implementation rather than a row in a table of
// function pointers. Its manifest record is a concrete serde type (field
// order, omitted-when-empty fields, and casing are part of the byte-stable
// manifest), and an associated `Record` type keeps that type end to end:
// discovery, finalization, codegen, and the manifest all see
// `Vec<ArunaActionRecord>`, never an erased value that could serialize
// differently. The descriptive parts — callee names, which module kind a
// defining file becomes, whether records enter the contract — are associated
// consts, so the registry can still list them as a table (`DESCRIPTORS`).

use crate::diagnostics::ArunaDiagnostic;
use crate::files::project_relative;
use crate::module_kind::ModuleKind;
use crate::schema_metadata::{FsSourceReader, SchemaScope, SourceReader};
use crate::spans::source_type_for_path;
use oxc_allocator::Allocator;
use oxc_ast::ast::{
    BindingPattern, CallExpression, Declaration, Expression, Program, Statement,
    VariableDeclarationKind,
};
use oxc_parser::Parser;
use std::cell::OnceCell;
use std::path::Path;

/// When a primitive's whole-project checks (`Primitive::finalize`) run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FinalizeStage {
    /// Right after every file has been discovered.
    AfterDiscovery,
    /// After the import graph has been built.
    AfterImports,
}

/// The module kind a file that defines a primitive is reclassified to, and the
/// reason `aruna inspect modules` gives for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DefiningModule {
    pub kind: ModuleKind,
    pub reason_detail: &'static str,
}

/// One primitive the compiler discovers statically: `export const <name> =
/// <callee>({ ... })` in project source, read without running it.
pub trait Primitive {
    /// What the manifest records for one definition.
    type Record: Clone;

    /// A short name for docs and tooling ("action").
    const NAME: &'static str;
    /// The callees that define one.
    const CALLEES: &'static [&'static str];
    /// The module kind a defining file becomes, if any. When a file defines
    /// several primitives, the earliest-registered one with a kind wins.
    const DEFINING_MODULE: Option<DefiningModule>;
    /// Whether records enter the contract snapshot (`aruna inspect contract`,
    /// `aruna contract diff`).
    const IN_CONTRACT: bool;
    /// When `finalize` runs.
    const FINALIZE_STAGE: FinalizeStage = FinalizeStage::AfterDiscovery;

    /// Static field extraction for one definition. Reports what it cannot read
    /// as diagnostics; `None` drops the definition from the manifest.
    fn analyze(
        site: &DefinitionSite<'_, '_>,
        diagnostics: &mut Vec<ArunaDiagnostic>,
    ) -> Option<Self::Record>;

    /// `(id, file, export name)`: the order records are listed in.
    fn sort_key(record: &Self::Record) -> (&str, &str, &str);

    /// Whole-project checks once every file is discovered: duplicate ids, the
    /// runtime boot order. Returns the records the project keeps.
    fn finalize(
        records: Vec<Self::Record>,
        _diagnostics: &mut Vec<ArunaDiagnostic>,
    ) -> Vec<Self::Record> {
        records
    }
}

/// A row of the registry's table view of a primitive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PrimitiveDescriptor {
    pub name: &'static str,
    pub callees: &'static [&'static str],
    pub defining_module: Option<DefiningModule>,
    pub in_contract: bool,
}

/// A source file parsed once for every primitive's discovery.
pub struct ParsedFile<'a> {
    path: &'a Path,
    program: &'a Program<'a>,
    reader: &'a dyn SourceReader,
    // Built on first use: most files define nothing, and building it resolves
    // the file's relative imports through `reader`.
    schema_scope: OnceCell<SchemaScope<'a>>,
}

impl<'a> ParsedFile<'a> {
    /// A file whose schema imports are read from disk.
    pub fn new(path: &'a Path, program: &'a Program<'a>) -> Self {
        Self::with_reader(path, program, &FsSourceReader)
    }

    pub fn with_reader(
        path: &'a Path,
        program: &'a Program<'a>,
        reader: &'a dyn SourceReader,
    ) -> Self {
        ParsedFile {
            path,
            program,
            reader,
            schema_scope: OnceCell::new(),
        }
    }

    pub(crate) fn schema_scope(&self) -> &SchemaScope<'a> {
        self.schema_scope
            .get_or_init(|| SchemaScope::for_program(self.path, self.program, self.reader))
    }

    /// The other files discovery read, if it read any: what its result depends
    /// on besides this file's own contents.
    pub fn dependencies(&self) -> Vec<std::path::PathBuf> {
        self.schema_scope
            .get()
            .map(|scope| scope.dependencies())
            .unwrap_or_default()
    }
}

/// Parses `source_text` into `allocator`, or returns the parser's errors.
pub fn parse_source<'a>(
    allocator: &'a Allocator,
    path: &Path,
    source_text: &'a str,
) -> Result<Program<'a>, String> {
    let source_type = source_type_for_path(path)?;
    let parser_return = Parser::new(allocator, source_text, source_type).parse();

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

    Ok(parser_return.program)
}

/// One `export const <export_name> = <callee>(...)` handed to `Primitive::analyze`.
pub struct DefinitionSite<'s, 'a> {
    /// The defining file, project-relative.
    pub file: &'s str,
    pub export_name: &'s str,
    /// Which of the primitive's `CALLEES` it was.
    pub callee: &'s str,
    pub call: &'a CallExpression<'a>,
    parsed: &'s ParsedFile<'a>,
}

impl<'s, 'a> DefinitionSite<'s, 'a> {
    /// The schemas the defining file can name, for reading `schema.*` fields.
    pub(crate) fn schema_scope(&self) -> &SchemaScope<'a> {
        self.parsed.schema_scope()
    }
}

/// What one primitive found in one file.
#[derive(Clone, Debug)]
pub struct Discovered<R> {
    /// Sorted by `Primitive::sort_key`.
    pub records: Vec<R>,
    /// Whether the file calls one of the primitive's callees at all — true even
    /// when every definition was invalid, so the boundary rules still keep the
    /// client away from the file.
    pub defines: bool,
    pub diagnostics: Vec<ArunaDiagnostic>,
}

/// Runs one primitive's discovery over a parsed file.
pub fn discover<P: Primitive>(file: &str, parsed: &ParsedFile<'_>) -> Discovered<P::Record> {
    let mut records = Vec::new();
    let mut defines = false;
    let mut diagnostics = Vec::new();

    for statement in &parsed.program.body {
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
            let callee = callee.name.as_str();
            if !P::CALLEES.contains(&callee) {
                continue;
            }

            defines = true;
            let site = DefinitionSite {
                file,
                export_name: binding.name.as_str(),
                callee,
                call,
                parsed,
            };
            if let Some(record) = P::analyze(&site, &mut diagnostics) {
                records.push(record);
            }
        }
    }

    records.sort_by(|left, right| P::sort_key(left).cmp(&P::sort_key(right)));
    Discovered {
        records,
        defines,
        diagnostics,
    }
}

/// Parses one file and runs one primitive's discovery over it: the single-file
/// entry point behind the public `collect_*_definitions` functions.
pub fn collect_definitions<P: Primitive>(
    project_root: &Path,
    path: &Path,
    source_text: &str,
) -> Result<Discovered<P::Record>, String> {
    let file = project_relative(project_root, path);
    let allocator = Allocator::default();
    let program = parse_source(&allocator, path, source_text)?;
    let parsed = ParsedFile::new(path, &program);
    Ok(discover::<P>(&file, &parsed))
}

/// Declares the registered primitives, in order. Registration order is
/// discovery order: per file, every primitive's diagnostics follow the previous
/// primitive's. `finalize` runs per stage in reverse registration order, which
/// is the order the whole-project checks ran in before the registry existed
/// and keeps diagnostic output byte-stable.
///
/// Generates `PrimitiveRecords` (one `Vec` of records per primitive),
/// `PrimitiveFiles` (the files defining each), and `DESCRIPTORS`.
macro_rules! register_primitives {
    ($($field:ident: $primitive:ty),+ $(,)?) => {
        /// Every registered primitive's records, one field per primitive.
        #[derive(Clone, Debug, Default)]
        pub struct PrimitiveRecords {
            $(pub $field: Vec<<$primitive as $crate::primitives::Primitive>::Record>,)+
        }

        /// The project files that define each registered primitive.
        #[derive(Clone, Debug, Default)]
        pub struct PrimitiveFiles {
            $(pub $field: std::collections::BTreeSet<String>,)+
        }

        /// The registered primitives as a table, in registration order.
        pub const DESCRIPTORS: &[$crate::primitives::PrimitiveDescriptor] = &[
            $($crate::primitives::PrimitiveDescriptor {
                name: <$primitive as $crate::primitives::Primitive>::NAME,
                callees: <$primitive as $crate::primitives::Primitive>::CALLEES,
                defining_module: <$primitive as $crate::primitives::Primitive>::DEFINING_MODULE,
                in_contract: <$primitive as $crate::primitives::Primitive>::IN_CONTRACT,
            },)+
        ];

        impl PrimitiveRecords {
            /// Runs every primitive's discovery over one parsed file, in
            /// registration order.
            pub fn discover_file(
                &mut self,
                files: &mut PrimitiveFiles,
                file: &str,
                parsed: &$crate::primitives::ParsedFile<'_>,
                diagnostics: &mut Vec<$crate::diagnostics::ArunaDiagnostic>,
            ) {
                $({
                    let found = $crate::primitives::discover::<$primitive>(file, parsed);
                    if found.defines {
                        files.$field.insert(file.to_string());
                    }
                    self.$field.extend(found.records);
                    diagnostics.extend(found.diagnostics);
                })+
            }

            /// Runs the whole-project checks of every primitive finalized at
            /// `stage`, in reverse registration order.
            pub fn finalize(
                &mut self,
                stage: $crate::primitives::FinalizeStage,
                diagnostics: &mut Vec<$crate::diagnostics::ArunaDiagnostic>,
            ) {
                let PrimitiveRecords { $($field),+ } = self;
                let mut steps: Vec<Box<dyn FnMut(&mut Vec<$crate::diagnostics::ArunaDiagnostic>) + '_>> = vec![
                    $(Box::new(move |diagnostics: &mut Vec<$crate::diagnostics::ArunaDiagnostic>| {
                        if <$primitive as $crate::primitives::Primitive>::FINALIZE_STAGE == stage {
                            *$field = <$primitive as $crate::primitives::Primitive>::finalize(
                                std::mem::take($field),
                                diagnostics,
                            );
                        }
                    }),)+
                ];
                for step in steps.iter_mut().rev() {
                    step(diagnostics);
                }
            }
        }

        impl PrimitiveRecords {
            /// Appends another set's records after this one's, per primitive.
            pub fn append(&mut self, other: &PrimitiveRecords) {
                $(self.$field.extend(other.$field.iter().cloned());)+
            }
        }

        impl PrimitiveFiles {
            /// Adds another set's defining files, per primitive.
            pub fn append(&mut self, other: &PrimitiveFiles) {
                $(self.$field.extend(other.$field.iter().cloned());)+
            }

            /// The module kind `path` becomes because of what it defines: the
            /// earliest-registered primitive it defines that has one.
            pub fn defining_module(&self, path: &str) -> Option<$crate::primitives::DefiningModule> {
                $(
                    if let Some(module) =
                        <$primitive as $crate::primitives::Primitive>::DEFINING_MODULE
                    {
                        if self.$field.contains(path) {
                            return Some(module);
                        }
                    }
                )+
                None
            }
        }
    };
}

pub(crate) use register_primitives;
