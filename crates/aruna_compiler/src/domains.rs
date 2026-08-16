use crate::config::ArunaConfig;
use crate::files::normalize_path;
use globset::{Glob, GlobSet, GlobSetBuilder};
use std::collections::BTreeMap;

// Subtrees a domain keeps to itself. These are the partition folders of the
// Recommended Layout: everything a domain runs on one side only is its own
// business, and the contract it offers other domains (model, schema, signals,
// stores) sits at the domain root.
pub const DOMAIN_PRIVATE_SEGMENTS: [&str; 2] = ["client", "server"];

const DOMAIN_INDEX_FILES: [&str; 2] = ["index.ts", "index.tsx"];

fn default_domain_roots(root: &str) -> Vec<String> {
    let root = if root.is_empty() { "src" } else { root };
    vec![format!("{root}/domains/*")]
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DomainRef {
    // Project-relative directory of the domain, e.g. `src/domains/shop`.
    pub dir: String,
    // Last segment of `dir`, used in diagnostics: `shop`.
    pub name: String,
}

// How much of a domain other domains may import.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PublicSurface {
    // The domain declared a barrel, so that file is the whole surface.
    Index(String),
    // No barrel: every module outside the private subtrees is importable.
    RootFiles,
}

// Which directories are domains, and which of them declare a barrel. Built once
// per compile from the discovered module paths.
#[derive(Debug)]
pub struct DomainIndex {
    roots: Option<GlobSet>,
    index_files: BTreeMap<String, String>,
}

impl DomainIndex {
    pub fn new<'a>(config: &ArunaConfig, module_paths: impl Iterator<Item = &'a str>) -> Self {
        let patterns = if config.domains.roots.is_empty() {
            default_domain_roots(&config.root)
        } else {
            config.domains.roots.clone()
        };

        let mut builder = GlobSetBuilder::new();
        let mut valid = 0usize;
        for pattern in &patterns {
            // A malformed glob disables that pattern rather than the compile:
            // domain boundaries are an advisory layer over a project's own
            // taxonomy, and a typo there must not cost the user their build.
            if let Ok(glob) = Glob::new(pattern) {
                builder.add(glob);
                valid += 1;
            }
        }
        let roots = if valid == 0 {
            None
        } else {
            builder.build().ok()
        };

        let mut index = Self {
            roots,
            index_files: BTreeMap::new(),
        };

        for path in module_paths {
            let path = normalize_path(path);
            let Some((parent, file_name)) = path.rsplit_once('/') else {
                continue;
            };
            if !DOMAIN_INDEX_FILES.contains(&file_name) {
                continue;
            }
            if index.matches_root(parent) {
                index.index_files.insert(parent.to_string(), path.clone());
            }
        }

        index
    }

    fn matches_root(&self, directory: &str) -> bool {
        self.roots
            .as_ref()
            .is_some_and(|roots| roots.is_match(directory))
    }

    // The domain a module belongs to, or None for app-shell code
    // (`src/client/**`, `src/app/**`, `src/shared/**`, the entry files) that no
    // domain owns. The shortest matching ancestor wins, so a nested directory
    // named like a domain root cannot re-open a domain from the inside.
    pub fn domain_for(&self, path: &str) -> Option<DomainRef> {
        if self.roots.is_none() {
            return None;
        }

        let path = normalize_path(path);
        let segments: Vec<&str> = path.split('/').collect();
        // The file name itself is never a domain directory.
        for end in 1..segments.len() {
            let candidate = segments[..end].join("/");
            if self.matches_root(&candidate) {
                let name = segments[end - 1].to_string();
                return Some(DomainRef {
                    dir: candidate,
                    name,
                });
            }
        }

        None
    }

    pub fn public_surface(&self, domain: &DomainRef) -> PublicSurface {
        match self.index_files.get(&domain.dir) {
            Some(index_file) => PublicSurface::Index(index_file.clone()),
            None => PublicSurface::RootFiles,
        }
    }

    // Whether `path` is part of `domain`'s public API. Paths outside the domain
    // are not its business and count as public.
    pub fn is_public(&self, domain: &DomainRef, path: &str) -> bool {
        let path = normalize_path(path);
        let prefix = format!("{}/", domain.dir);
        let Some(relative) = path.strip_prefix(&prefix) else {
            return true;
        };

        match self.public_surface(domain) {
            PublicSurface::Index(index_file) => path == index_file,
            PublicSurface::RootFiles => {
                let segments: Vec<&str> = relative.split('/').collect();
                // Directory segments only — a module named `server.ts` at the
                // domain root is a file, not a private subtree.
                !segments[..segments.len().saturating_sub(1)]
                    .iter()
                    .any(|segment| DOMAIN_PRIVATE_SEGMENTS.contains(segment))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index_for(paths: &[&str]) -> DomainIndex {
        DomainIndex::new(&ArunaConfig::default(), paths.iter().copied())
    }

    #[test]
    fn resolves_domains_under_the_recommended_root() {
        let index = index_for(&[]);

        let shop = index.domain_for("src/domains/shop/server/actions.ts");
        assert_eq!(
            shop,
            Some(DomainRef {
                dir: "src/domains/shop".to_string(),
                name: "shop".to_string(),
            })
        );
        assert_eq!(
            index.domain_for("src/domains/shop/model.ts").map(|d| d.dir),
            Some("src/domains/shop".to_string())
        );

        // App-shell code belongs to no domain.
        assert_eq!(index.domain_for("src/client/main.client.ts"), None);
        assert_eq!(index.domain_for("src/shared/i18n/index.ts"), None);
        assert_eq!(index.domain_for("src/server.ts"), None);
        // `domains/` itself is not a domain, only its children.
        assert_eq!(index.domain_for("src/domains/registry.ts"), None);
    }

    #[test]
    fn treats_client_and_server_subtrees_as_private() {
        let index = index_for(&[]);
        let shop = index.domain_for("src/domains/shop/model.ts").unwrap();

        assert_eq!(index.public_surface(&shop), PublicSurface::RootFiles);
        assert!(index.is_public(&shop, "src/domains/shop/model.ts"));
        assert!(index.is_public(&shop, "src/domains/shop/schema/buy.ts"));
        assert!(index.is_public(&shop, "src/domains/shop/store.ts"));
        assert!(!index.is_public(&shop, "src/domains/shop/server/actions.ts"));
        assert!(!index.is_public(&shop, "src/domains/shop/client/state.ts"));
        assert!(!index.is_public(&shop, "src/domains/shop/ui/client/panel.tsx"));

        // A module named after a private subtree is still a root file.
        assert!(index.is_public(&shop, "src/domains/shop/server.ts"));
        // Anything outside the domain is not this domain's call.
        assert!(index.is_public(&shop, "src/shared/result.ts"));
    }

    #[test]
    fn narrows_the_surface_to_a_barrel_when_one_exists() {
        let index = index_for(&["src/domains/shop/index.ts", "src/domains/grab/model.ts"]);
        let shop = index.domain_for("src/domains/shop/model.ts").unwrap();
        let grab = index.domain_for("src/domains/grab/model.ts").unwrap();

        assert_eq!(
            index.public_surface(&shop),
            PublicSurface::Index("src/domains/shop/index.ts".to_string())
        );
        assert!(index.is_public(&shop, "src/domains/shop/index.ts"));
        assert!(!index.is_public(&shop, "src/domains/shop/model.ts"));
        assert!(!index.is_public(&shop, "src/domains/shop/server/actions.ts"));

        // A barrel in one domain says nothing about the next.
        assert_eq!(index.public_surface(&grab), PublicSurface::RootFiles);
        assert!(index.is_public(&grab, "src/domains/grab/model.ts"));

        // An index file deeper inside a domain is not the domain's barrel.
        let nested = index_for(&["src/domains/shop/model/index.ts"]);
        let shop = nested.domain_for("src/domains/shop/model/index.ts").unwrap();
        assert_eq!(nested.public_surface(&shop), PublicSurface::RootFiles);
    }

    #[test]
    fn honors_configured_domain_roots() {
        let mut config = ArunaConfig::default();
        config.domains.roots = vec![
            "src/domains/*".to_string(),
            "src/features/*".to_string(),
        ];
        let index = DomainIndex::new(&config, std::iter::empty());

        assert_eq!(
            index
                .domain_for("src/features/shop/server/pricing.ts")
                .map(|domain| domain.name),
            Some("shop".to_string())
        );
        assert_eq!(
            index
                .domain_for("src/domains/grab/model.ts")
                .map(|domain| domain.name),
            Some("grab".to_string())
        );
    }
}
