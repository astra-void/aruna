pub use aruna_compiler::*;

#[cfg(feature = "napi-addon")]
mod napi_bridge {
    use aruna_compiler::{check_project, inspect_project, CompilerInput, CompilerOutput};
    use napi::bindgen_prelude::{Error, Result};
    use napi_derive::napi;
    use serde_json::Value;

    fn parse_input(input: Value) -> Result<CompilerInput> {
        serde_json::from_value(input).map_err(|error| Error::from_reason(error.to_string()))
    }

    fn serialize_output(output: CompilerOutput) -> Result<Value> {
        serde_json::to_value(output).map_err(|error| Error::from_reason(error.to_string()))
    }

    #[napi(js_name = "checkProject")]
    pub fn check_project_js(input: Value) -> Result<Value> {
        let input = parse_input(input)?;
        serialize_output(check_project(input))
    }

    #[napi(js_name = "inspectProject")]
    pub fn inspect_project_js(input: Value) -> Result<Value> {
        let input = parse_input(input)?;
        serialize_output(inspect_project(input))
    }
}
