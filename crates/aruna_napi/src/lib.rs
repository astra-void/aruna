use aruna_compiler::{check_project as run_check_project, inspect_project as run_inspect_project};
use aruna_compiler::{CompilerInput, CompilerOutput};
use napi::bindgen_prelude::{Error, Result};
use napi_derive::napi;
use serde_json::Value;

fn parse_input(input: Value) -> Result<CompilerInput> {
    serde_json::from_value(input).map_err(|error| Error::from_reason(error.to_string()))
}

fn serialize_output(output: CompilerOutput) -> Result<Value> {
    serde_json::to_value(output).map_err(|error| Error::from_reason(error.to_string()))
}

#[napi]
pub fn check_project(input: Value) -> Result<Value> {
    let input = parse_input(input)?;
    serialize_output(run_check_project(input))
}

#[napi]
pub fn inspect_project(input: Value) -> Result<Value> {
    let input = parse_input(input)?;
    serialize_output(run_inspect_project(input))
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
