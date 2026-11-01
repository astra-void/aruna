// `strict.sharedSafety`: what a shared module may reach at runtime.
//
// A shared module is replicated and runs on both sides, so everything it loads
// has to load on both sides too. The import boundary rules (aruna::302/303)
// check a shared module's own imports, one edge at a time. This module adds the
// checks those rules cannot make:
//
//   * Transitive reach (aruna::306/307). A shared module that imports another
//     shared module that imports server code loads that server code when it
//     loads. The direct edge is reported where it is (aruna::303); every shared
//     module that reaches it through other shared modules is reported too, with
//     the chain, because each of them fails to load on the client.
//   * Server-only services (aruna::308/309). `game.GetService("DataStoreService")`
//     and the like, read from shared code. At module scope it runs on the client
//     the moment the module loads (an error); inside a function it runs when the
//     function is called, which an `IsServer()` guard may rule out — so an
//     unguarded one is a warning.
//
// All of it is static and syntactic. It follows resolved, non-type-only imports
// between project files; it does not see dynamic `import()`, `require`, an
// import it could not resolve, a package, or a service reached through a value
// it cannot read (`game.GetService(name)`). Passing it is evidence a shared
// module is safe to load on both sides, not proof: packages/aruna/docs/
// shared-safety.md lists what it cannot see.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, CallExpression, ConditionalExpression, Expression, FunctionBody, IfStatement,
    LogicalExpression, LogicalOperator, PropertyDefinition, Statement, StaticMemberExpression,
    UnaryOperator,
};
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::{SourceType, Span};

use crate::diagnostics::{create_diagnostic, ArunaDiagnostic, DiagnosticSpan};
use crate::graph::GraphImportRecord;
use crate::manifest::ArunaModuleRecord;
use crate::module_kind::ModuleKind;

// Services that exist to hold or reach server authority. Every one of them is
// either empty on the client (ServerStorage, ServerScriptService) or refuses
// its methods there (the rest), so shared code that reads one is either dead on
// the client or about to fail on it. Kept short on purpose: a service with real
// client uses (HttpService for JSON, TeleportService, MarketplaceService) is
// not listed, because a report on it would be wrong more often than right.
pub const SERVER_ONLY_SERVICES: [&str; 5] = [
    "DataStoreService",
    "MemoryStoreService",
    "MessagingService",
    "ServerScriptService",
    "ServerStorage",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerServiceAccess {
    pub service: String,
    pub span: DiagnosticSpan,
    // True when the access runs as the module loads (module scope, a static
    // class member at module scope), false inside a function body.
    pub at_load: bool,
}

// Which side an expression proves the code is running on: `RunService.IsServer()`
// (any receiver) is the server, `.IsClient()` the client, and `!` flips either.
fn asserted_side(expression: &Expression<'_>) -> Option<bool> {
    match expression {
        Expression::ParenthesizedExpression(inner) => asserted_side(&inner.expression),
        Expression::UnaryExpression(unary) if unary.operator == UnaryOperator::LogicalNot => {
            asserted_side(&unary.argument).map(|server| !server)
        }
        Expression::CallExpression(call) if call.arguments.is_empty() => {
            let Expression::StaticMemberExpression(member) = &call.callee else {
                return None;
            };
            match member.property.name.as_str() {
                "IsServer" => Some(true),
                "IsClient" => Some(false),
                _ => None,
            }
        }
        _ => None,
    }
}

fn exits(statement: &Statement<'_>) -> bool {
    match statement {
        Statement::ReturnStatement(_) | Statement::ThrowStatement(_) => true,
        Statement::BlockStatement(block) => block.body.last().is_some_and(exits),
        _ => false,
    }
}

#[derive(Default)]
struct ServiceAccessCollector {
    accesses: Vec<ServerServiceAccess>,
    function_depth: usize,
    // Inside code that only runs on the server: the server branch of an
    // `IsServer()`/`IsClient()` test, or what follows a client early exit.
    guard_depth: usize,
}

impl ServiceAccessCollector {
    fn push(&mut self, service: &str, span: Span) {
        if self.guard_depth > 0 || !SERVER_ONLY_SERVICES.contains(&service) {
            return;
        }
        self.accesses.push(ServerServiceAccess {
            service: service.to_string(),
            span: DiagnosticSpan {
                start: span.start as usize,
                end: span.end as usize,
            },
            at_load: self.function_depth == 0,
        });
    }

    fn guarded<F: FnOnce(&mut Self)>(&mut self, guard: bool, body: F) {
        if guard {
            self.guard_depth += 1;
        }
        body(self);
        if guard {
            self.guard_depth -= 1;
        }
    }

    fn in_function<F: FnOnce(&mut Self)>(&mut self, body: F) {
        self.function_depth += 1;
        body(self);
        self.function_depth -= 1;
    }
}

impl<'a> Visit<'a> for ServiceAccessCollector {
    // `x.GetService("DataStoreService")` / `x.FindService(...)`, whatever `x` is.
    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        if let Expression::StaticMemberExpression(member) = &it.callee {
            let method = member.property.name.as_str();
            if method == "GetService" || method == "FindService" {
                if let Some(Argument::StringLiteral(name)) = it.arguments.first() {
                    self.push(name.value.as_str(), it.span);
                }
            }
        }
        walk::walk_call_expression(self, it);
    }

    // `game.ServerStorage`: a service read off the DataModel by name.
    fn visit_static_member_expression(&mut self, it: &StaticMemberExpression<'a>) {
        if let Expression::Identifier(object) = &it.object {
            if object.name == "game" {
                self.push(it.property.name.as_str(), it.span);
            }
        }
        walk::walk_static_member_expression(self, it);
    }

    // Function and arrow bodies alike, methods and accessors included.
    fn visit_function_body(&mut self, it: &FunctionBody<'a>) {
        self.in_function(|this| walk::walk_function_body(this, it));
    }

    // An instance field initializer runs in the constructor; a static one when
    // the class is defined.
    fn visit_property_definition(&mut self, it: &PropertyDefinition<'a>) {
        if it.r#static {
            walk::walk_property_definition(self, it);
        } else {
            self.in_function(|this| walk::walk_property_definition(this, it));
        }
    }

    fn visit_if_statement(&mut self, it: &IfStatement<'a>) {
        self.visit_expression(&it.test);
        let side = asserted_side(&it.test);
        self.guarded(side == Some(true), |this| this.visit_statement(&it.consequent));
        if let Some(alternate) = &it.alternate {
            self.guarded(side == Some(false), |this| this.visit_statement(alternate));
        }
    }

    fn visit_conditional_expression(&mut self, it: &ConditionalExpression<'a>) {
        self.visit_expression(&it.test);
        let side = asserted_side(&it.test);
        self.guarded(side == Some(true), |this| this.visit_expression(&it.consequent));
        self.guarded(side == Some(false), |this| this.visit_expression(&it.alternate));
    }

    // `RunService.IsServer() && reach()` / `RunService.IsClient() || reach()`.
    fn visit_logical_expression(&mut self, it: &LogicalExpression<'a>) {
        self.visit_expression(&it.left);
        let guard = match (it.operator, asserted_side(&it.left)) {
            (LogicalOperator::And, Some(true)) | (LogicalOperator::Or, Some(false)) => true,
            _ => false,
        };
        self.guarded(guard, |this| this.visit_expression(&it.right));
    }

    // `if (RunService.IsClient()) return;` guards everything after it in the block.
    fn visit_statements(&mut self, it: &oxc_allocator::Vec<'a, Statement<'a>>) {
        let mut guards = 0;
        for statement in it {
            self.visit_statement(statement);
            if let Statement::IfStatement(test) = statement {
                if test.alternate.is_none()
                    && asserted_side(&test.test) == Some(false)
                    && exits(&test.consequent)
                {
                    self.guard_depth += 1;
                    guards += 1;
                }
            }
        }
        self.guard_depth -= guards;
    }
}

pub fn collect_server_service_accesses(
    path: &Path,
    source_text: &str,
) -> Result<Vec<ServerServiceAccess>, String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).map_err(|error| error.to_string())?;
    let parser_return = Parser::new(&allocator, source_text, source_type).parse();
    // A file that does not parse is already reported by the discovery passes.
    if parser_return.panicked || !parser_return.errors.is_empty() {
        return Err("parse failed".to_string());
    }
    let mut collector = ServiceAccessCollector::default();
    collector.visit_program(&parser_return.program);
    Ok(collector.accesses)
}

pub fn create_server_service_diagnostic(file: &str, access: &ServerServiceAccess) -> ArunaDiagnostic {
    if access.at_load {
        create_diagnostic(
            "aruna::308",
            format!(
                "{file} reads the server-only service {} when it loads, and shared modules load on the client too.",
                access.service
            ),
            Some(file.to_string()),
            Some(access.span.clone()),
            Some(format!(
                "service: {}\nruns: at module load, on the server and on every client",
                access.service
            )),
            Some(format!(
                "Move the {} access into a server module (server/, actions.ts, runtime.ts) and pass shared code the data it needs, or read it inside a function behind RunService.IsServer().",
                access.service
            )),
        )
    } else {
        create_diagnostic(
            "aruna::309",
            format!(
                "{file} reads the server-only service {} from shared code with no RunService.IsServer() guard.",
                access.service
            ),
            Some(file.to_string()),
            Some(access.span.clone()),
            Some(format!(
                "service: {}\nruns: whenever the enclosing function is called, on whichever side calls it",
                access.service
            )),
            Some(format!(
                "Move the function into a server module, or guard the {} access with `if (RunService.IsServer())` (an early `if (RunService.IsClient()) return;` counts too).",
                access.service
            )),
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Side {
    Server,
    Client,
}

fn side_of(kind: ModuleKind) -> Option<Side> {
    match kind {
        ModuleKind::Server
        | ModuleKind::ServerEntry
        | ModuleKind::ServerAction
        | ModuleKind::ServerStore => Some(Side::Server),
        ModuleKind::Client | ModuleKind::ClientEntry => Some(Side::Client),
        _ => None,
    }
}

// Shared code, and unclassified code (evaluated as shared by the boundary
// rules): what a chain may pass through, and where it may start.
fn is_shared_like(kind: ModuleKind) -> bool {
    matches!(kind, ModuleKind::Shared | ModuleKind::Unknown)
}

fn kind_label(kind: ModuleKind) -> &'static str {
    match kind {
        ModuleKind::Client => "client",
        ModuleKind::Server => "server",
        ModuleKind::Shared => "shared",
        ModuleKind::ClientEntry => "client entry",
        ModuleKind::ServerEntry => "server entry",
        ModuleKind::ServerAction => "server action",
        ModuleKind::ServerStore => "server store",
        ModuleKind::Test => "test",
        ModuleKind::Unknown => "unclassified",
    }
}

// Every shared module that loads server (or client) code through at least one
// other shared module, with the shortest such chain. One multi-source BFS per
// side, backwards from the side's modules through shared ones, so the whole
// check is linear in the import graph.
pub fn create_transitive_diagnostics(
    modules: &[ArunaModuleRecord],
    imports: &[GraphImportRecord],
) -> Vec<ArunaDiagnostic> {
    let kinds: BTreeMap<&str, ModuleKind> = modules
        .iter()
        .map(|module| (module.path.as_str(), module.kind))
        .collect();

    // Runtime edges between project modules, deduplicated, in sorted order.
    let mut forward: BTreeMap<&str, Vec<(&str, &GraphImportRecord)>> = BTreeMap::new();
    let mut reverse: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for edge in imports {
        if !edge.edge.resolved || edge.edge.type_only {
            continue;
        }
        let Some(to) = edge.edge.to.as_deref() else {
            continue;
        };
        if !kinds.contains_key(to) || to == edge.importer_path {
            continue;
        }
        let targets = forward.entry(edge.importer_path.as_str()).or_default();
        if !targets.iter().any(|(target, _)| *target == to) {
            targets.push((to, edge));
        }
        reverse.entry(to).or_default().insert(edge.importer_path.as_str());
    }

    let mut diagnostics = Vec::new();
    for side in [Side::Server, Side::Client] {
        // next[m] = the module one step closer to `side` from shared module m.
        let mut next: BTreeMap<&str, &str> = BTreeMap::new();
        let mut distance: BTreeMap<&str, usize> = BTreeMap::new();
        let mut queue = VecDeque::new();
        for (path, kind) in &kinds {
            if side_of(*kind) == Some(side) {
                distance.insert(path, 0);
                queue.push_back(*path);
            }
        }
        while let Some(current) = queue.pop_front() {
            let current_distance = distance[current];
            let Some(importers) = reverse.get(current) else {
                continue;
            };
            for importer in importers {
                if distance.contains_key(importer) || !is_shared_like(kinds[importer]) {
                    continue;
                }
                distance.insert(importer, current_distance + 1);
                next.insert(importer, current);
                queue.push_back(importer);
            }
        }

        for (path, kind) in &kinds {
            if !is_shared_like(*kind) {
                continue;
            }
            // Distance 1 is a direct import, which aruna::302/303 already report.
            let Some(&steps) = distance.get(path) else {
                continue;
            };
            if steps < 2 {
                continue;
            }
            let mut chain = vec![*path];
            let mut cursor = *path;
            while let Some(step) = next.get(cursor) {
                chain.push(step);
                cursor = step;
            }
            let first_edge = forward
                .get(path)
                .and_then(|targets| targets.iter().find(|(target, _)| *target == chain[1]))
                .map(|(_, edge)| *edge);
            diagnostics.push(transitive_diagnostic(side, &chain, &kinds, first_edge));
        }
    }
    diagnostics
}

fn transitive_diagnostic(
    side: Side,
    chain: &[&str],
    kinds: &BTreeMap<&str, ModuleKind>,
    first_edge: Option<&GraphImportRecord>,
) -> ArunaDiagnostic {
    let root = chain[0];
    let reached = chain[chain.len() - 1];
    let through = chain[1];
    let mut details = String::from("dependency chain:");
    for (index, module) in chain.iter().enumerate() {
        let arrow = if index == 0 { "  " } else { "  → " };
        details.push_str(&format!("\n{arrow}{module} ({})", kind_label(kinds[module])));
    }
    let (code, side_label, other, fix) = match side {
        Side::Server => (
            "aruna::306",
            "server",
            "the client",
            "Move the runtime dependency into a server module, import only the type it needs (`import type`), or pass the value in from a server entry.",
        ),
        Side::Client => (
            "aruna::307",
            "client",
            "the server",
            "Move the runtime dependency into a client module, import only the type it needs (`import type`), or pass the value in from a client entry.",
        ),
    };
    let importing = chain[chain.len() - 2];
    create_diagnostic(
        code,
        format!(
            "{root} is shared, but loading it loads the {side_label} module {reached} through {through}, so it cannot load on {other}."
        ),
        Some(root.to_string()),
        first_edge.and_then(|edge| edge.span.clone()),
        Some(details),
        Some(format!(
            "The import to fix is in {importing}. {fix}"
        )),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn accesses(source: &str) -> Vec<(String, bool)> {
        collect_server_service_accesses(Path::new("probe.ts"), source)
            .expect("parses")
            .into_iter()
            .map(|access| (access.service, access.at_load))
            .collect()
    }

    #[test]
    fn reports_server_only_services_at_load_and_in_functions() {
        let found = accesses(
            r#"
            const DataStoreService = game.GetService("DataStoreService");
            const storage = game.ServerStorage;
            const players = game.GetService("Players");
            export function save() {
                return game.GetService("MemoryStoreService");
            }
            export const later = () => game.FindService("MessagingService");
            "#,
        );
        assert_eq!(
            found,
            vec![
                ("DataStoreService".to_string(), true),
                ("ServerStorage".to_string(), true),
                ("MemoryStoreService".to_string(), false),
                ("MessagingService".to_string(), false),
            ]
        );
    }

    #[test]
    fn skips_access_behind_a_server_guard() {
        let found = accesses(
            r#"
            const RunService = game.GetService("RunService");
            export function a() {
                if (RunService.IsServer()) {
                    game.GetService("DataStoreService");
                }
            }
            export function b() {
                if (RunService.IsClient()) {
                    return;
                }
                game.GetService("DataStoreService");
            }
            export function c() {
                if (!RunService.IsClient()) game.GetService("ServerStorage");
                return RunService.IsServer() ? game.GetService("ServerStorage") : undefined;
            }
            export function d() {
                RunService.IsServer() && game.GetService("ServerStorage");
                if (RunService.IsClient()) {
                    print("client");
                } else {
                    game.GetService("ServerStorage");
                }
            }
            "#,
        );
        assert!(found.is_empty(), "{found:?}");
    }

    #[test]
    fn a_client_guard_does_not_cover_a_server_access() {
        let found = accesses(
            r#"
            const RunService = game.GetService("RunService");
            export function a() {
                if (RunService.IsClient()) {
                    game.GetService("DataStoreService");
                }
                if (RunService.IsServer()) {
                    print("server");
                } else {
                    game.GetService("ServerStorage");
                }
            }
            "#,
        );
        assert_eq!(
            found,
            vec![
                ("DataStoreService".to_string(), false),
                ("ServerStorage".to_string(), false),
            ]
        );
    }

    #[test]
    fn static_class_fields_run_at_load_and_instance_fields_do_not() {
        let found = accesses(
            r#"
            export class Holder {
                static store = game.GetService("DataStoreService");
                instance = game.GetService("ServerStorage");
            }
            "#,
        );
        assert_eq!(
            found,
            vec![
                ("DataStoreService".to_string(), true),
                ("ServerStorage".to_string(), false),
            ]
        );
    }

    #[test]
    fn ignores_a_service_name_it_cannot_read() {
        assert!(accesses("const name = \"DataStoreService\"; game.GetService(name);").is_empty());
    }
}
