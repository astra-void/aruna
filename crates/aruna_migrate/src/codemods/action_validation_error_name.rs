// `action-validation-error-name`: the client-visible error name for an action
// whose input or output fails its schema changed from "SchemaValidationError" to
// "ActionValidationError". Code that branched on the old name silently stopped
// matching.
//
// Rewrites the string literal where it is compared against an error's `name`:
//   err.name === "SchemaValidationError"   (also ==, !==, !=, either side)
//   err?.name / err["name"] / (err as X).name / err!.name
//   switch (err.name) { case "SchemaValidationError": ... }
// The quote style is kept. Every other occurrence of the exact literal — stored
// in a constant, passed to a function, compared against something that is not
// a `name` — is left alone and reported, because whether it is an error name
// is not something the syntax says. Strings that merely contain the name (a log
// message) are not occurrences.

use crate::edits::TextEdit;
use crate::{Codemod, FileOutcome, SourceFile, Unhandled};
use oxc_ast::ast::{
    BinaryExpression, ChainElement, Expression, StringLiteral, SwitchStatement,
};
use oxc_ast_visit::{walk, Visit};
use oxc_span::GetSpan;
use oxc_span::Span;
use std::collections::BTreeSet;

const OLD_NAME: &str = "SchemaValidationError";
const NEW_NAME: &str = "ActionValidationError";

pub(crate) struct ActionValidationErrorName;

impl Codemod for ActionValidationErrorName {
    fn name(&self) -> &'static str {
        "action-validation-error-name"
    }

    fn description(&self) -> &'static str {
        "Compare error names against \"ActionValidationError\" instead of \"SchemaValidationError\" (the client error for a failed action schema)"
    }

    fn transform(&self, file: &SourceFile<'_>) -> FileOutcome {
        let mut visitor = Rewriter {
            text: file.text,
            rewritten: BTreeSet::new(),
            occurrences: Vec::new(),
            edits: Vec::new(),
        };
        visitor.visit_program(file.program);
        let unhandled = visitor
            .occurrences
            .iter()
            .filter(|span| !visitor.rewritten.contains(&(span.start, span.end)))
            .map(|span| Unhandled {
                offset: span.start,
                message: format!(
                    "\"{OLD_NAME}\" used outside a comparison against an error's name; if it names the error, change it to \"{NEW_NAME}\""
                ),
            })
            .collect();
        FileOutcome {
            edits: visitor.edits,
            unhandled,
        }
    }
}

struct Rewriter<'t> {
    text: &'t str,
    // Spans of the literals already rewritten.
    rewritten: BTreeSet<(u32, u32)>,
    // Every exact "SchemaValidationError" literal in the file.
    occurrences: Vec<Span>,
    edits: Vec<TextEdit>,
}

// The old name as a string literal, through parentheses.
fn old_name_literal<'b>(expression: &'b Expression<'_>) -> Option<&'b StringLiteral<'b>> {
    match expression {
        Expression::StringLiteral(literal) if literal.value == OLD_NAME => Some(literal),
        Expression::ParenthesizedExpression(inner) => old_name_literal(&inner.expression),
        _ => None,
    }
}

// Whether `expression` reads a `name` property: `x.name`, `x?.name`,
// `x["name"]`, through parentheses, `as` / `satisfies`, and `!`.
fn is_name_access(expression: &Expression<'_>) -> bool {
    match expression {
        Expression::StaticMemberExpression(member) => member.property.name == "name",
        Expression::ComputedMemberExpression(member) => {
            matches!(&member.expression, Expression::StringLiteral(key) if key.value == "name")
        }
        Expression::ChainExpression(chain) => match &chain.expression {
            ChainElement::StaticMemberExpression(member) => member.property.name == "name",
            ChainElement::ComputedMemberExpression(member) => {
                matches!(&member.expression, Expression::StringLiteral(key) if key.value == "name")
            }
            ChainElement::TSNonNullExpression(inner) => is_name_access(&inner.expression),
            _ => false,
        },
        Expression::ParenthesizedExpression(inner) => is_name_access(&inner.expression),
        Expression::TSAsExpression(inner) => is_name_access(&inner.expression),
        Expression::TSSatisfiesExpression(inner) => is_name_access(&inner.expression),
        Expression::TSNonNullExpression(inner) => is_name_access(&inner.expression),
        _ => false,
    }
}

impl Rewriter<'_> {
    fn rewrite(&mut self, literal: &StringLiteral<'_>) {
        let key = (literal.span.start, literal.span.end);
        if !self.rewritten.insert(key) {
            return;
        }
        // Keep the literal's own quote character.
        let quote = self.text[literal.span.start as usize..]
            .chars()
            .next()
            .unwrap_or('"');
        self.edits.push(TextEdit {
            start: literal.span.start,
            end: literal.span.end,
            replacement: format!("{quote}{NEW_NAME}{quote}"),
        });
    }
}

impl<'a> Visit<'a> for Rewriter<'_> {
    fn visit_binary_expression(&mut self, it: &BinaryExpression<'a>) {
        if it.operator.is_equality() {
            if is_name_access(&it.left) {
                if let Some(literal) = old_name_literal(&it.right) {
                    self.rewrite(literal);
                }
            }
            if is_name_access(&it.right) {
                if let Some(literal) = old_name_literal(&it.left) {
                    self.rewrite(literal);
                }
            }
        }
        walk::walk_binary_expression(self, it);
    }

    fn visit_switch_statement(&mut self, it: &SwitchStatement<'a>) {
        if is_name_access(&it.discriminant) {
            for case in &it.cases {
                if let Some(literal) = case.test.as_ref().and_then(old_name_literal) {
                    self.rewrite(literal);
                }
            }
        }
        walk::walk_switch_statement(self, it);
    }

    fn visit_string_literal(&mut self, it: &StringLiteral<'a>) {
        if it.value == OLD_NAME {
            self.occurrences.push(it.span());
        }
    }
}
