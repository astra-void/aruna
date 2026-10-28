use aruna_compiler::{CompilerInput, CompilerOutput, CompilerSession};
use napi::bindgen_prelude::{AsyncTask, Error, Result};
use napi::{Env, JsString, Task};
use napi_derive::napi;
use serde_json::Value;
use std::sync::{Arc, Mutex};

fn parse_input(input: Value) -> Result<CompilerInput> {
    serde_json::from_value(input).map_err(|error| Error::from_reason(error.to_string()))
}

fn serialize_output(output: CompilerOutput) -> Result<Value> {
    serde_json::to_value(output).map_err(|error| Error::from_reason(error.to_string()))
}

// The compiler's registered primitives as a table, for tooling that must agree
// with the registry (the CLI's own primitive list is checked against it).
#[napi]
pub fn primitive_descriptors() -> Value {
    Value::Array(
        aruna_compiler::primitives::DESCRIPTORS
            .iter()
            .map(|descriptor| {
                serde_json::json!({
                    "name": descriptor.name,
                    "callees": descriptor.callees,
                    "definingModuleKind": descriptor.defining_module.map(|module| module.kind),
                    "inContract": descriptor.in_contract,
                })
            })
            .collect(),
    )
}

// `aruna migrate`: the registered codemods (crates/aruna_migrate).
#[napi]
pub fn list_codemods() -> Result<Value> {
    serde_json::to_value(aruna_migrate::list_codemods())
        .map_err(|error| Error::from_reason(error.to_string()))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunCodemodInput {
    name: String,
    project_root: String,
    #[serde(default)]
    exclude_dirs: Vec<String>,
    #[serde(default)]
    dry_run: bool,
}

/// Runs a codemod over a project; writes the changes unless `dryRun`. Resolves
/// to the report (changed files with their diffs, unhandled sites).
#[napi]
pub fn run_codemod(input: Value) -> Result<Value> {
    let input: RunCodemodInput =
        serde_json::from_value(input).map_err(|error| Error::from_reason(error.to_string()))?;
    let report = aruna_migrate::run_codemod(
        &input.name,
        std::path::Path::new(&input.project_root),
        &input.exclude_dirs,
        input.dry_run,
    )
    .map_err(Error::from_reason)?;
    serde_json::to_value(report).map_err(|error| Error::from_reason(error.to_string()))
}

struct SessionState {
    // `None` once disposed.
    session: Mutex<Option<CompilerSession>>,
    // Paths `update` reported since the last check started. Kept apart from the
    // session so `update` never waits on a check running on the thread pool.
    pending: Mutex<Vec<String>>,
}

#[derive(Clone, Copy)]
enum SessionRun {
    Check,
    Inspect,
}

fn run_session(state: &SessionState, run: SessionRun) -> Result<CompilerOutput> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| Error::from_reason("compiler session lock poisoned"))?;
    let session = guard
        .as_mut()
        .ok_or_else(|| Error::from_reason("compiler session is disposed"))?;
    let pending = std::mem::take(
        &mut *state
            .pending
            .lock()
            .map_err(|_| Error::from_reason("compiler session lock poisoned"))?,
    );
    session.update(&pending);
    Ok(match run {
        SessionRun::Check => session.check(),
        SessionRun::Inspect => session.inspect(),
    })
}

/// A check or inspect run on the libuv thread pool, resolving to the compiler
/// output serialized as JSON for the caller to `JSON.parse`. Measured faster
/// than building the JS objects natively (docs/compiler-performance.md).
pub struct SessionTask {
    state: Arc<SessionState>,
    run: SessionRun,
}

impl Task for SessionTask {
    type Output = String;
    type JsValue = JsString;

    fn compute(&mut self) -> Result<Self::Output> {
        let output = run_session(&self.state, self.run)?;
        // Through a `Value` first: its maps order keys alphabetically, so the
        // CLI's --json output does not depend on struct field declaration order
        // (a reordered field would otherwise show up as an output change).
        let value = serialize_output(output)?;
        serde_json::to_string(&value).map_err(|error| Error::from_reason(error.to_string()))
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        env.create_string_from_std(output)
    }
}

/// A long-lived compiler session (see crates/aruna_compiler/src/session.rs).
#[napi(js_name = "CompilerSession")]
pub struct JsCompilerSession {
    state: Arc<SessionState>,
}

#[napi]
impl JsCompilerSession {
    #[napi(constructor)]
    pub fn new(input: Value) -> Result<Self> {
        let input = parse_input(input)?;
        Ok(JsCompilerSession {
            state: Arc::new(SessionState {
                session: Mutex::new(Some(CompilerSession::new(input))),
                pending: Mutex::new(Vec::new()),
            }),
        })
    }

    /// Reports changed paths (edited, created, deleted, or a moved directory),
    /// absolute or relative to the project root. Applied at the next check.
    #[napi]
    pub fn update(&self, changed_paths: Vec<String>) -> Result<()> {
        self.state
            .pending
            .lock()
            .map_err(|_| Error::from_reason("compiler session lock poisoned"))?
            .extend(changed_paths);
        Ok(())
    }

    /// A check (writes the manifest, and the generated files when the input asks)
    /// through the session's cache, off the main thread. Resolves to the output
    /// as a JSON string.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn check(&self) -> AsyncTask<SessionTask> {
        AsyncTask::new(SessionTask {
            state: self.state.clone(),
            run: SessionRun::Check,
        })
    }

    /// A check that writes nothing, otherwise like `check`.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn inspect(&self) -> AsyncTask<SessionTask> {
        AsyncTask::new(SessionTask {
            state: self.state.clone(),
            run: SessionRun::Inspect,
        })
    }

    /// Releases the session's caches. Later calls fail.
    #[napi]
    pub fn dispose(&self) -> Result<()> {
        *self
            .state
            .session
            .lock()
            .map_err(|_| Error::from_reason("compiler session lock poisoned"))? = None;
        Ok(())
    }
}
