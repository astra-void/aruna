use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, ComputedMemberExpression, Expression, NewExpression, StaticMemberExpression,
};
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::{SourceType, Span};

use crate::config::StrictSeverity;
use crate::diagnostics::{create_diagnostic, ArunaDiagnostic, DiagnosticSeverity, DiagnosticSpan};

// Remote classes whose construction bypasses the action/signal layer.
const RAW_REMOTE_CLASSES: [&str; 3] = ["RemoteEvent", "RemoteFunction", "UnreliableRemoteEvent"];

// Remote members whose use means traffic is going around generated actions and
// signals: the methods that send, and the events and callback that receive.
const RAW_REMOTE_MEMBERS: [&str; 7] = [
    "FireServer",
    "FireClient",
    "FireAllClients",
    "InvokeServer",
    "OnServerEvent",
    "OnClientEvent",
    "OnServerInvoke",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawRemoteUsage {
    // What was found, as it reads in source: `new Instance("RemoteEvent")` or
    // `.FireServer`.
    pub usage: String,
    pub span: DiagnosticSpan,
}

#[derive(Default)]
struct RawRemoteCollector {
    usages: Vec<RawRemoteUsage>,
}

impl RawRemoteCollector {
    fn push(&mut self, usage: String, span: Span) {
        self.usages.push(RawRemoteUsage {
            usage,
            span: DiagnosticSpan {
                start: span.start as usize,
                end: span.end as usize,
            },
        });
    }

    fn check_member(&mut self, name: &str, span: Span) {
        if RAW_REMOTE_MEMBERS.contains(&name) {
            self.push(format!(".{name}"), span);
        }
    }
}

impl<'a> Visit<'a> for RawRemoteCollector {
    fn visit_new_expression(&mut self, it: &NewExpression<'a>) {
        if let Expression::Identifier(callee) = &it.callee {
            if callee.name == "Instance" {
                if let Some(Argument::StringLiteral(class_name)) = it.arguments.first() {
                    if RAW_REMOTE_CLASSES.contains(&class_name.value.as_str()) {
                        self.push(format!("new Instance(\"{}\")", class_name.value), it.span);
                    }
                }
            }
        }
        walk::walk_new_expression(self, it);
    }

    fn visit_static_member_expression(&mut self, it: &StaticMemberExpression<'a>) {
        self.check_member(it.property.name.as_str(), it.property.span);
        walk::walk_static_member_expression(self, it);
    }

    // `remote["FireServer"]` is the same access spelled differently.
    fn visit_computed_member_expression(&mut self, it: &ComputedMemberExpression<'a>) {
        if let Expression::StringLiteral(property) = &it.expression {
            self.check_member(property.value.as_str(), property.span);
        }
        walk::walk_computed_member_expression(self, it);
    }
}

// Finds raw RemoteEvent / RemoteFunction use, syntactically: constructing one
// with `new Instance(...)`, or touching one of its send/receive members. Purely
// by name, so a project type that happens to have a `FireServer` member is
// reported too. The ignore list exists for that case.
pub fn collect_raw_remote_usages(
    path: &Path,
    source_text: &str,
) -> Result<Vec<RawRemoteUsage>, String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).map_err(|error| error.to_string())?;
    let parser_return = Parser::new(&allocator, source_text, source_type).parse();

    // A file that does not parse is already reported by the discovery passes.
    if parser_return.panicked || !parser_return.errors.is_empty() {
        return Err("parse failed".to_string());
    }

    let mut collector = RawRemoteCollector::default();
    collector.visit_program(&parser_return.program);
    Ok(collector.usages)
}

pub fn create_raw_remote_usage_diagnostic(
    file: &str,
    usage: &RawRemoteUsage,
    severity: &StrictSeverity,
) -> Option<ArunaDiagnostic> {
    if matches!(severity, StrictSeverity::Off) {
        return None;
    }

    let mut diagnostic = create_diagnostic(
        "aruna::507",
        format!(
            "{file} uses a raw remote ({}) instead of an Aruna action or signal.",
            usage.usage
        ),
        Some(file.to_string()),
        Some(usage.span.clone()),
        Some(
            "Traffic over a hand-made remote skips the schema validation, rate limiting, and middleware that actions and signals apply."
                .to_string(),
        ),
        Some(
            "Define a defineAction or defineSignal for this traffic, or add \"raw-remote-usage\" to diagnostics.ignore if the remote is intentional."
                .to_string(),
        ),
    );
    diagnostic.severity = match severity {
        StrictSeverity::Error => DiagnosticSeverity::Error,
        _ => DiagnosticSeverity::Warning,
    };
    Some(diagnostic)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usages(source: &str) -> Vec<String> {
        collect_raw_remote_usages(Path::new("probe.ts"), source)
            .expect("parses")
            .into_iter()
            .map(|usage| usage.usage)
            .collect()
    }

    #[test]
    fn finds_raw_remote_construction_and_members() {
        let found = usages(
            r#"
            const remote = new Instance("RemoteEvent");
            const fn = new Instance("RemoteFunction");
            const fast = new Instance("UnreliableRemoteEvent");
            const part = new Instance("Part");
            function send() {
                remote.FireServer(1);
                remote["FireAllClients"](2);
                remote.OnServerEvent.Connect(() => {});
                fn.OnServerInvoke = () => 1;
            }
            "#,
        );
        assert_eq!(
            found,
            vec![
                "new Instance(\"RemoteEvent\")",
                "new Instance(\"RemoteFunction\")",
                "new Instance(\"UnreliableRemoteEvent\")",
                ".FireServer",
                ".FireAllClients",
                ".OnServerEvent",
                ".OnServerInvoke",
            ]
        );
    }

    #[test]
    fn ignores_other_members_and_classes() {
        assert!(usages("const a = new Instance(\"Folder\"); a.Name = \"x\"; a.Fire();").is_empty());
    }
}
