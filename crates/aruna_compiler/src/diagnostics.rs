use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Info,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiagnosticSpan {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArunaDiagnostic {
    pub code: String,
    pub name: String,
    pub severity: DiagnosticSeverity,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span: Option<DiagnosticSpan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docs_url: Option<String>,
}

impl ArunaDiagnostic {
    pub fn new(
        code: impl Into<String>,
        name: impl Into<String>,
        severity: DiagnosticSeverity,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            name: name.into(),
            severity,
            message: message.into(),
            file: None,
            span: None,
            details: None,
            suggestion: None,
            docs_url: None,
        }
    }
}

pub fn diagnostic_meta(code: &str) -> Option<(&'static str, DiagnosticSeverity)> {
    match code {
        "aruna::100" => Some(("invalid-config", DiagnosticSeverity::Error)),
        "aruna::102" => Some(("missing-tsconfig", DiagnosticSeverity::Warning)),
        "aruna::103" => Some(("invalid-tsconfig", DiagnosticSeverity::Error)),
        "aruna::106" => Some(("parse-failed", DiagnosticSeverity::Error)),
        "aruna::105" => Some(("unresolved-import", DiagnosticSeverity::Warning)),
        "aruna::200" => Some(("unknown-module-kind", DiagnosticSeverity::Warning)),
        "aruna::203" => Some(("ambiguous-convention-match", DiagnosticSeverity::Warning)),
        "aruna::550" => Some(("invalid-action-definition", DiagnosticSeverity::Error)),
        "aruna::551" => Some(("action-missing-run", DiagnosticSeverity::Error)),
        "aruna::552" => Some(("action-run-not-function", DiagnosticSeverity::Error)),
        "aruna::553" => Some(("action-input-schema-invalid", DiagnosticSeverity::Warning)),
        "aruna::554" => Some(("action-output-schema-invalid", DiagnosticSeverity::Warning)),
        "aruna::559" => Some(("invalid-action-fire-and-forget", DiagnosticSeverity::Error)),
        "aruna::560" => Some(("invalid-action-rate-limit", DiagnosticSeverity::Error)),
        "aruna::564" => Some(("signal-payload-schema-invalid", DiagnosticSeverity::Warning)),
        // An identifier used as a schema that resolves to nothing — locally or
        // through one import hop. An Error (unlike the shape warnings above):
        // the author clearly meant a named schema, and letting it degrade would
        // silently produce `unknown`-typed clients and an empty contract.
        "aruna::565" => Some(("unresolved-schema-reference", DiagnosticSeverity::Error)),
        "aruna::566" => Some((
            "generated-signal-payload-type-collision",
            DiagnosticSeverity::Error,
        )),
        "aruna::568" => Some(("unknown-hook-export", DiagnosticSeverity::Warning)),
        // Stores. Persistence failures are unrecoverable in a way a wrong remote
        // payload is not — a bad store definition can cost a player their save
        // file — so the structural rules are errors, not warnings.
        "aruna::570" => Some(("invalid-store-definition", DiagnosticSeverity::Error)),
        "aruna::571" => Some(("store-missing-schema", DiagnosticSeverity::Error)),
        "aruna::572" => Some(("store-schema-invalid", DiagnosticSeverity::Warning)),
        "aruna::573" => Some(("duplicate-store-id", DiagnosticSeverity::Error)),
        "aruna::574" => Some(("store-imported-from-client", DiagnosticSeverity::Error)),
        "aruna::575" => Some(("invalid-store-version", DiagnosticSeverity::Error)),
        "aruna::576" => Some(("store-missing-default", DiagnosticSeverity::Error)),
        "aruna::577" => Some(("store-version-without-migrate", DiagnosticSeverity::Warning)),
        "aruna::555" => Some(("duplicate-action-id", DiagnosticSeverity::Error)),
        "aruna::556" => Some(("action-imported-from-invalid-environment", DiagnosticSeverity::Error)),
        "aruna::557" => Some((
            "duplicate-generated-action-export",
            DiagnosticSeverity::Error,
        )),
        "aruna::558" => Some((
            "generated-action-type-name-collision",
            DiagnosticSeverity::Error,
        )),
        "aruna::300" => Some(("client-imports-server", DiagnosticSeverity::Error)),
        "aruna::301" => Some(("server-imports-client", DiagnosticSeverity::Error)),
        "aruna::302" => Some(("shared-imports-client", DiagnosticSeverity::Error)),
        "aruna::303" => Some(("shared-imports-server", DiagnosticSeverity::Error)),
        "aruna::700" => Some(("manifest-write-failed", DiagnosticSeverity::Error)),
        "aruna::701" => Some(("generated-output-write-failed", DiagnosticSeverity::Error)),
        "aruna::900" => Some(("internal-compiler-error", DiagnosticSeverity::Error)),
        _ => None,
    }
}

pub fn create_diagnostic(
    code: impl Into<String>,
    message: impl Into<String>,
    file: Option<String>,
    span: Option<DiagnosticSpan>,
    details: Option<String>,
    suggestion: Option<String>,
) -> ArunaDiagnostic {
    let code_string = code.into();
    let (name, severity) = diagnostic_meta(&code_string)
        .unwrap_or(("internal-compiler-error", DiagnosticSeverity::Error));
    ArunaDiagnostic {
        code: code_string,
        name: name.to_string(),
        severity,
        message: message.into(),
        file,
        span,
        details,
        suggestion,
        docs_url: None,
    }
}

pub fn is_error_severity(severity: &DiagnosticSeverity, warnings_as_errors: bool) -> bool {
    matches!(severity, DiagnosticSeverity::Error)
        || (warnings_as_errors && matches!(severity, DiagnosticSeverity::Warning))
}

pub fn summarize_diagnostics(
    diagnostics: &[ArunaDiagnostic],
    warnings_as_errors: bool,
) -> DiagnosticSummary {
    let mut summary = DiagnosticSummary::default();

    for diagnostic in diagnostics {
        if is_error_severity(&diagnostic.severity, warnings_as_errors) {
            summary.errors += 1;
        } else if matches!(diagnostic.severity, DiagnosticSeverity::Warning) {
            summary.warnings += 1;
        } else {
            summary.infos += 1;
        }
    }

    summary
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticSummary {
    pub errors: usize,
    pub warnings: usize,
    pub infos: usize,
}

pub fn strip_ignored_diagnostics(
    diagnostics: &[ArunaDiagnostic],
    ignore: &[String],
) -> Vec<ArunaDiagnostic> {
    if ignore.is_empty() {
        return diagnostics.to_vec();
    }

    diagnostics
        .iter()
        .filter(|diagnostic| {
            !ignore.contains(&diagnostic.code) && !ignore.contains(&diagnostic.name)
        })
        .cloned()
        .collect()
}

pub fn stable_sort_diagnostics(diagnostics: &[ArunaDiagnostic]) -> Vec<ArunaDiagnostic> {
    let mut sorted = diagnostics.to_vec();
    sorted.sort_by(|left, right| {
        left.file
            .as_deref()
            .unwrap_or("")
            .cmp(right.file.as_deref().unwrap_or(""))
            .then_with(|| {
                left.span
                    .as_ref()
                    .map(|span| span.start)
                    .unwrap_or_default()
                    .cmp(
                        &right
                            .span
                            .as_ref()
                            .map(|span| span.start)
                            .unwrap_or_default(),
                    )
            })
            .then_with(|| left.code.cmp(&right.code))
            .then_with(|| left.message.cmp(&right.message))
    });
    sorted
}
