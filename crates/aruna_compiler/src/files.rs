use crate::config::SourceConfig;
use globset::{Glob, GlobSet, GlobSetBuilder};
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;

pub fn normalize_path(input: &str) -> String {
    input.replace('\\', "/")
}

pub fn normalize_path_buf(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();

    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(std::path::MAIN_SEPARATOR.to_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(part) => normalized.push(part),
        }
    }

    normalized
}

pub fn project_relative(project_root: &Path, absolute_path: &Path) -> String {
    let absolute_path = normalize_path_buf(absolute_path);
    match absolute_path.strip_prefix(project_root) {
        Ok(relative) if relative.as_os_str().is_empty() => ".".to_string(),
        Ok(relative) => normalize_path(&relative.to_string_lossy()),
        Err(_) => normalize_path(&absolute_path.to_string_lossy()),
    }
}

pub fn project_absolute(project_root: &Path, maybe_relative: &str) -> PathBuf {
    let path = Path::new(maybe_relative);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        project_root.join(path)
    };
    normalize_path_buf(&absolute)
}

fn build_globset(patterns: &[String]) -> Result<GlobSet, String> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        builder.add(Glob::new(pattern).map_err(|error| error.to_string())?);
    }
    builder.build().map_err(|error| error.to_string())
}

pub fn discover_source_files(
    project_root: &Path,
    source: &SourceConfig,
) -> Result<Vec<PathBuf>, String> {
    let includes = if source.include.is_empty() {
        vec!["src/**/*.ts".to_string(), "src/**/*.tsx".to_string()]
    } else {
        source.include.clone()
    };
    let excludes = if source.exclude.is_empty() {
        vec![
            "node_modules/**".to_string(),
            "out/**".to_string(),
            ".aruna/**".to_string(),
        ]
    } else {
        source.exclude.clone()
    };

    let include_set = build_globset(&includes)?;
    let exclude_set = build_globset(&excludes)?;
    let mut files = Vec::new();

    for entry in WalkDir::new(project_root)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !entry.file_type().is_file() {
            continue;
        }

        let relative = match path.strip_prefix(project_root) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let relative_text = normalize_path(&relative.to_string_lossy());

        if relative_text.ends_with(".d.ts") {
            continue;
        }
        if exclude_set.is_match(relative) {
            continue;
        }
        if !include_set.is_match(relative) {
            continue;
        }

        files.push(path.to_path_buf());
    }

    files.sort_by(|left, right| {
        normalize_path(&left.to_string_lossy()).cmp(&normalize_path(&right.to_string_lossy()))
    });
    Ok(files)
}
