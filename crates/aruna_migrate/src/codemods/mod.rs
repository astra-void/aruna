// The registered codemods, in `aruna migrate --list` order. A new one is a
// module here plus an entry in `ALL` (docs/codemods.md).

mod action_validation_error_name;

use crate::Codemod;

pub(crate) static ALL: &[&dyn Codemod] = &[&action_validation_error_name::ActionValidationErrorName];
