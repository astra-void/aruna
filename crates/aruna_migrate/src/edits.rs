// Span-based text edits: a codemod never reprints a file. It names byte ranges
// of the original source and what to put there, and everything outside those
// ranges — formatting, comments, quote style — stays exactly as written.

use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TextEdit {
    /// Byte offsets into the original source, `start..end`.
    pub start: u32,
    pub end: u32,
    pub replacement: String,
}

/// Applies `edits` to `source`. Edits may come in any order; two that overlap
/// are a codemod bug and are refused rather than guessed at.
pub fn apply_edits(source: &str, edits: &[TextEdit]) -> Result<String, String> {
    let mut sorted: Vec<&TextEdit> = edits.iter().collect();
    sorted.sort_by_key(|edit| (edit.start, edit.end));
    let mut output = String::with_capacity(source.len());
    let mut cursor = 0usize;
    for edit in sorted {
        let (start, end) = (edit.start as usize, edit.end as usize);
        if start < cursor {
            return Err(format!("overlapping edits at byte {start}"));
        }
        if end > source.len() || start > end {
            return Err(format!("edit {start}..{end} is outside the source"));
        }
        if !source.is_char_boundary(start) || !source.is_char_boundary(end) {
            return Err(format!("edit {start}..{end} splits a character"));
        }
        output.push_str(&source[cursor..start]);
        output.push_str(&edit.replacement);
        cursor = end;
    }
    output.push_str(&source[cursor..]);
    Ok(output)
}

/// 1-based line and column (in characters) of a byte offset.
pub fn line_column(source: &str, offset: u32) -> (u32, u32) {
    let offset = (offset as usize).min(source.len());
    let before = &source[..offset];
    let line = before.matches('\n').count() as u32 + 1;
    let line_start = before.rfind('\n').map(|index| index + 1).unwrap_or(0);
    let column = before[line_start..].chars().count() as u32 + 1;
    (line, column)
}
