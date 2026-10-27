// Fixture tests for every codemod: tests/fixtures/<codemod>/<case>/ holds
// `input.ts(x)` and `expected.ts(x)`, plus two snapshots: `unhandled.txt` (the
// sites reported, as `line:column message`) and `dry-run.diff` (what
// `--dry-run` prints). Each case checks that the codemod turns the input into
// the expected text exactly, that it is idempotent (the expected text comes
// back unchanged), the snapshots, and that a dry run writes nothing while a
// real run writes the expected file.
//
// ARUNA_UPDATE_FIXTURES=1 rewrites the two snapshots; input and expected are
// always written by hand.

use aruna_migrate::{run_codemod, transform_source};
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn case_file(dir: &Path, stem: &str) -> PathBuf {
    for extension in ["ts", "tsx"] {
        let path = dir.join(format!("{stem}.{extension}"));
        if path.exists() {
            return path;
        }
    }
    panic!("{} has no {stem}.ts or {stem}.tsx", dir.display());
}

fn check_snapshot(path: &Path, actual: &str) {
    if std::env::var("ARUNA_UPDATE_FIXTURES").as_deref() == Ok("1") {
        fs::write(path, actual).unwrap();
        return;
    }
    let expected = fs::read_to_string(path)
        .unwrap_or_else(|_| panic!("missing snapshot {}; run with ARUNA_UPDATE_FIXTURES=1", path.display()));
    assert_eq!(actual, expected, "snapshot {} differs", path.display());
}

fn run_case(codemod: &str, dir: &Path) {
    let input_path = case_file(dir, "input");
    let expected_path = case_file(dir, "expected");
    let extension = input_path.extension().unwrap().to_string_lossy().to_string();
    let case = dir.file_name().unwrap().to_string_lossy().to_string();
    let virtual_path = format!("src/{case}.{extension}");
    let input = fs::read_to_string(&input_path).unwrap();
    let expected = fs::read_to_string(&expected_path).unwrap();

    let (after, unhandled) = transform_source(codemod, &virtual_path, &input).unwrap();
    assert_eq!(after, expected, "{codemod}/{case}: output differs from expected");

    // Idempotent: the expected output is a fixed point.
    let (again, _) = transform_source(codemod, &virtual_path, &expected).unwrap();
    assert_eq!(again, expected, "{codemod}/{case}: a second run changed the output");

    let rendered: String = unhandled
        .iter()
        .map(|site| format!("{}:{} {}\n", site.line, site.column, site.message))
        .collect();
    check_snapshot(&dir.join("unhandled.txt"), &rendered);

    // Through the project runner: a dry run reports the diff and writes nothing.
    let project = TempDir::new().unwrap();
    let file = project.path().join(&virtual_path);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, &input).unwrap();
    let dry = run_codemod(codemod, project.path(), &[], true).unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), input, "{codemod}/{case}: dry run wrote");
    let diff: String = dry.changed.iter().map(|change| change.diff.as_str()).collect();
    check_snapshot(&dir.join("dry-run.diff"), &diff);
    assert_eq!(dry.unhandled.len(), unhandled.len());

    // A real run writes the expected text; a second one finds nothing to do.
    let real = run_codemod(codemod, project.path(), &[], false).unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), expected);
    assert_eq!(real.changed.len(), usize::from(input != expected));
    let second = run_codemod(codemod, project.path(), &[], false).unwrap();
    assert!(second.changed.is_empty(), "{codemod}/{case}: not idempotent on disk");
}

#[test]
fn every_codemod_fixture() {
    let mut ran = 0;
    for codemod in fs::read_dir(fixture_root()).unwrap() {
        let codemod = codemod.unwrap().path();
        let name = codemod.file_name().unwrap().to_string_lossy().to_string();
        let mut cases: Vec<PathBuf> = fs::read_dir(&codemod)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.is_dir())
            .collect();
        cases.sort();
        for case in cases {
            run_case(&name, &case);
            ran += 1;
        }
    }
    assert!(ran > 0, "no codemod fixtures found");
}

#[test]
fn every_registered_codemod_has_fixtures() {
    for codemod in aruna_migrate::list_codemods() {
        assert!(
            fixture_root().join(codemod.name).is_dir(),
            "codemod {} has no fixtures under tests/fixtures/",
            codemod.name
        );
    }
}

#[test]
fn an_unknown_codemod_is_an_error() {
    let project = TempDir::new().unwrap();
    let error = run_codemod("no-such-codemod", project.path(), &[], true).unwrap_err();
    assert!(error.contains("unknown codemod"));
}

#[test]
fn skips_build_output_and_excluded_dirs() {
    let project = TempDir::new().unwrap();
    let root = project.path();
    for path in [
        "src/a.ts",
        "src/types.d.ts",
        "node_modules/pkg/index.ts",
        "out/a.ts",
        "src/.aruna/runtime/x.ts",
        "generated/x.ts",
    ] {
        let file = root.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, "export {};\n").unwrap();
    }
    let sources = aruna_migrate::project_sources(root, &["generated".to_string()]);
    let names: Vec<String> = sources
        .iter()
        .map(|path| path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"))
        .collect();
    assert_eq!(names, ["src/a.ts"]);
}
