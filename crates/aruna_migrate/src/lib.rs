// `aruna migrate`: codemods for Aruna's breaking changes (docs/codemods.md).
//
// A codemod reads a parsed file and returns byte-range edits plus the sites it
// found but could not rewrite with confidence. The engine applies the edits to
// the original text — the file is never reprinted, so everything a codemod
// does not touch stays byte for byte as written — and reports, per file, a
// unified diff and the unhandled sites with their line and column.
//
// Every codemod must be idempotent: running it on its own output changes
// nothing. The fixture tests check that for every case.

mod codemods;
pub mod diff;
pub mod edits;

use edits::{apply_edits, line_column, TextEdit};
use oxc_allocator::Allocator;
use oxc_ast::ast::Program;
use oxc_parser::Parser;
use oxc_span::SourceType;
use serde::Serialize;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// One file as a codemod sees it.
pub struct SourceFile<'a> {
    /// Project-relative, with `/` separators.
    pub path: &'a str,
    pub text: &'a str,
    pub program: &'a Program<'a>,
}

/// A site a codemod recognized but could not rewrite safely.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unhandled {
    /// Byte offset of the site in the file.
    pub offset: u32,
    pub message: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FileOutcome {
    pub edits: Vec<TextEdit>,
    pub unhandled: Vec<Unhandled>,
}

pub trait Codemod: Sync {
    /// The name `aruna migrate <name>` takes.
    fn name(&self) -> &'static str;
    /// One line for `aruna migrate --list`.
    fn description(&self) -> &'static str;
    fn transform(&self, file: &SourceFile<'_>) -> FileOutcome;
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodemodInfo {
    pub name: &'static str,
    pub description: &'static str,
}

pub fn list_codemods() -> Vec<CodemodInfo> {
    codemods::ALL
        .iter()
        .map(|codemod| CodemodInfo {
            name: codemod.name(),
            description: codemod.description(),
        })
        .collect()
}

fn find_codemod(name: &str) -> Option<&'static dyn Codemod> {
    codemods::ALL.iter().copied().find(|codemod| codemod.name() == name)
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub file: String,
    pub diff: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnhandledSite {
    pub file: String,
    pub line: u32,
    pub column: u32,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub codemod: String,
    pub dry_run: bool,
    pub files_scanned: usize,
    pub changed: Vec<ChangedFile>,
    pub unhandled: Vec<UnhandledSite>,
}

/// Transforms one file's text: the new text and the sites the codemod could not
/// handle. A file that does not parse comes back unchanged, with one unhandled
/// site saying so.
pub fn transform_source(
    codemod_name: &str,
    path: &str,
    text: &str,
) -> Result<(String, Vec<UnhandledSite>), String> {
    let codemod = find_codemod(codemod_name)
        .ok_or_else(|| format!("unknown codemod `{codemod_name}`; see aruna migrate --list"))?;
    transform_with(codemod, path, text)
}

fn transform_with(
    codemod: &dyn Codemod,
    path: &str,
    text: &str,
) -> Result<(String, Vec<UnhandledSite>), String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(Path::new(path)).map_err(|error| error.to_string())?;
    let parsed = Parser::new(&allocator, text, source_type).parse();
    if parsed.panicked || !parsed.errors.is_empty() {
        let site = UnhandledSite {
            file: path.to_string(),
            line: 1,
            column: 1,
            message: "the file does not parse, so the codemod skipped it".to_string(),
        };
        return Ok((text.to_string(), vec![site]));
    }
    let outcome = codemod.transform(&SourceFile {
        path,
        text,
        program: &parsed.program,
    });
    let after = apply_edits(text, &outcome.edits).map_err(|error| format!("{path}: {error}"))?;
    let mut unhandled: Vec<UnhandledSite> = outcome
        .unhandled
        .into_iter()
        .map(|site| {
            let (line, column) = line_column(text, site.offset);
            UnhandledSite {
                file: path.to_string(),
                line,
                column,
                message: site.message,
            }
        })
        .collect();
    unhandled.sort_by(|left, right| (left.line, left.column).cmp(&(right.line, right.column)));
    Ok((after, unhandled))
}

/// The project's TypeScript sources: every `.ts` / `.tsx` under `project_root`
/// except declaration files and build output (`node_modules`, `out`,
/// `include`, `dist`, `.git`, any `.aruna`, and `exclude_dirs`, relative to the
/// root).
pub fn project_sources(project_root: &Path, exclude_dirs: &[String]) -> Vec<PathBuf> {
    let excluded: Vec<PathBuf> = exclude_dirs
        .iter()
        .map(|dir| project_root.join(dir))
        .collect();
    let mut files: Vec<PathBuf> = WalkDir::new(project_root)
        .into_iter()
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            !(entry.file_type().is_dir()
                && (matches!(name.as_ref(), "node_modules" | "out" | "include" | "dist" | ".git" | ".aruna")
                    || excluded.iter().any(|dir| entry.path() == dir)))
        })
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| {
            let name = path.to_string_lossy();
            (name.ends_with(".ts") || name.ends_with(".tsx")) && !name.ends_with(".d.ts")
        })
        .collect();
    files.sort();
    files
}

fn relative(project_root: &Path, path: &Path) -> String {
    path.strip_prefix(project_root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Runs a codemod over the project. Writes the changed files unless
/// `dry_run`; reports each change as a unified diff either way.
pub fn run_codemod(
    codemod_name: &str,
    project_root: &Path,
    exclude_dirs: &[String],
    dry_run: bool,
) -> Result<MigrationReport, String> {
    let codemod = find_codemod(codemod_name)
        .ok_or_else(|| format!("unknown codemod `{codemod_name}`; see aruna migrate --list"))?;
    let files = project_sources(project_root, exclude_dirs);
    let mut changed = Vec::new();
    let mut unhandled = Vec::new();
    for file in &files {
        let text = std::fs::read_to_string(file).map_err(|error| format!("{}: {error}", file.display()))?;
        let path = relative(project_root, file);
        let (after, sites) = transform_with(codemod, &path, &text)?;
        unhandled.extend(sites);
        if after != text {
            if !dry_run {
                std::fs::write(file, &after).map_err(|error| format!("{}: {error}", file.display()))?;
            }
            changed.push(ChangedFile {
                diff: diff::unified_diff(&path, &text, &after),
                file: path,
            });
        }
    }
    Ok(MigrationReport {
        codemod: codemod_name.to_string(),
        dry_run,
        files_scanned: files.len(),
        changed,
        unhandled,
    })
}
