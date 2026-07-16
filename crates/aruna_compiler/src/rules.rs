use crate::module_kind::ModuleKind;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoundaryViolation {
    pub code: &'static str,
}

fn normalize_boundary_kind(kind: ModuleKind) -> ModuleKind {
    match kind {
        ModuleKind::Client | ModuleKind::ClientEntry => ModuleKind::Client,
        ModuleKind::Server | ModuleKind::ServerEntry | ModuleKind::ServerAction => ModuleKind::Server,
        ModuleKind::Shared => ModuleKind::Shared,
        // Unclassified modules are evaluated as shared, the most restrictive
        // kind: an unknown file importing server or client code is a violation.
        // Before this, Unknown bypassed every boundary rule — a file placed one
        // directory outside the conventions silently escaped enforcement.
        ModuleKind::Unknown => ModuleKind::Shared,
    }
}

pub fn boundary_code(importer: ModuleKind, imported: ModuleKind) -> Option<&'static str> {
    match (importer, imported) {
        (ModuleKind::Client | ModuleKind::ClientEntry, ModuleKind::ServerAction) => {
            Some("aruna::556")
        }
        _ => match (normalize_boundary_kind(importer), normalize_boundary_kind(imported)) {
            (ModuleKind::Client, ModuleKind::Server) => Some("aruna::300"),
            (ModuleKind::Server, ModuleKind::Client) => Some("aruna::301"),
            (ModuleKind::Shared, ModuleKind::Client) => Some("aruna::302"),
            (ModuleKind::Shared, ModuleKind::Server) => Some("aruna::303"),
            _ => None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_boundary_rules() {
        assert_eq!(
            boundary_code(ModuleKind::Client, ModuleKind::Server),
            Some("aruna::300")
        );
        assert_eq!(
            boundary_code(ModuleKind::ClientEntry, ModuleKind::Server),
            Some("aruna::300")
        );
        assert_eq!(
            boundary_code(ModuleKind::Server, ModuleKind::Client),
            Some("aruna::301")
        );
        assert_eq!(
            boundary_code(ModuleKind::ServerAction, ModuleKind::Client),
            Some("aruna::301")
        );
        assert_eq!(
            boundary_code(ModuleKind::Shared, ModuleKind::Client),
            Some("aruna::302")
        );
        assert_eq!(
            boundary_code(ModuleKind::Shared, ModuleKind::Server),
            Some("aruna::303")
        );
        assert_eq!(boundary_code(ModuleKind::Client, ModuleKind::Shared), None);
        assert_eq!(
            boundary_code(ModuleKind::Client, ModuleKind::ServerAction),
            Some("aruna::556")
        );
    }

    #[test]
    fn unknown_modules_are_evaluated_as_shared() {
        // An unclassified file must not escape boundary enforcement.
        assert_eq!(
            boundary_code(ModuleKind::Unknown, ModuleKind::Server),
            Some("aruna::303")
        );
        assert_eq!(
            boundary_code(ModuleKind::Unknown, ModuleKind::ServerAction),
            Some("aruna::303")
        );
        assert_eq!(
            boundary_code(ModuleKind::Unknown, ModuleKind::Client),
            Some("aruna::302")
        );
        // Unknown as an importee stays importable, like shared.
        assert_eq!(boundary_code(ModuleKind::Server, ModuleKind::Unknown), None);
        assert_eq!(boundary_code(ModuleKind::Client, ModuleKind::Unknown), None);
        assert_eq!(boundary_code(ModuleKind::Unknown, ModuleKind::Unknown), None);
    }
}
