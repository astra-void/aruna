use crate::module_kind::ModuleKind;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoundaryViolation {
    pub code: &'static str,
}

pub fn boundary_code(importer: ModuleKind, imported: ModuleKind) -> Option<&'static str> {
    match (importer, imported) {
        (ModuleKind::Client, ModuleKind::Server) => Some("aruna::300"),
        (ModuleKind::Server, ModuleKind::Client) => Some("aruna::301"),
        (ModuleKind::Shared, ModuleKind::Client) => Some("aruna::302"),
        (ModuleKind::Shared, ModuleKind::Server) => Some("aruna::303"),
        _ => None,
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
            boundary_code(ModuleKind::Server, ModuleKind::Client),
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
    }
}
