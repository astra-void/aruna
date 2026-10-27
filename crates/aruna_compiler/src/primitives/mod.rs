// The compiler's primitives: the `define*` calls it discovers statically and
// records in the manifest. Each primitive lives in its own module.

pub mod action;
mod registry;
pub mod runtime;
pub mod signal;
pub mod store;

pub use action::*;
pub use registry::*;
pub use runtime::*;
pub use signal::*;
pub use store::*;

// The registered primitives, in discovery order. A new primitive is a module
// with a `Primitive` impl plus one line here (and its manifest field).
registry::register_primitives! {
    action: ActionPrimitive,
    signal: SignalPrimitive,
    store: StorePrimitive,
    runtime: RuntimePrimitive,
}

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ArunaSerializationPolicy {
    PlainDataV1,
}

impl Default for ArunaSerializationPolicy {
    fn default() -> Self {
        Self::PlainDataV1
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArunaActionSerializationMetadata {
    pub policy: ArunaSerializationPolicy,
}

impl Default for ArunaActionSerializationMetadata {
    fn default() -> Self {
        Self {
            policy: ArunaSerializationPolicy::default(),
        }
    }
}

// serde predicate: skip serializing boolean fields that are false so manifests
// without the field stay byte-identical to pre-feature snapshots.
pub(crate) fn is_false(value: &bool) -> bool {
    !*value
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod toy;
