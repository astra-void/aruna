// Differential test for the incremental session: random edit sequences —
// files added, removed, and renamed; imports added, removed, and pointed at
// files that do not exist yet; action, signal, and store definitions changed,
// duplicated, and broken; schema modules edited under the actions that import
// them — and after every step the session's output must equal a clean one-shot
// check of the same tree, byte for byte as JSON.
//
// CI runs a fixed set of seeds plus one random seed per run (printed, so a
// failure reproduces with ARUNA_SESSION_SEED=<seed>).

use aruna_compiler::{inspect_project, CompilerInput, CompilerSession, TsconfigResolverOptions};
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

fn input(root: &Path) -> CompilerInput {
    CompilerInput {
        project_root: root.to_string_lossy().to_string(),
        config: Default::default(),
        config_diagnostics: Vec::new(),
        tsconfig_options: TsconfigResolverOptions::default(),
        write_manifest: false,
        write_generated: false,
        warnings_as_errors: false,
    }
}

fn write(root: &Path, relative: &str, contents: &str) -> PathBuf {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, contents).unwrap();
    path
}

const DOMAINS: [&str; 4] = ["shop", "combat", "quests", "pets"];

fn schema_source(rng: &mut Rng, domain: &str) -> String {
    let quantity = rng.pick(&["number", "string", "u8", "boolean"]);
    let bound = rng.pick(&["", ".maxLength(16)", ".maxLength(64)"]);
    format!(
        "import {{ schema }} from \"aruna/schema\";\n\n\
         export const {domain}Input = schema.object({{ itemId: schema.string(){bound}, quantity: schema.{quantity}() }});\n\
         export const {domain}Payload = schema.object({{ total: schema.u16() }});\n\
         export const {domain}Record = schema.object({{ coins: schema.number() }});\n"
    )
}

fn actions_source(rng: &mut Rng, domain: &str) -> String {
    let id = rng.pick(&["buy", "buy", "sell", "dup"]);
    let id = if *id == "dup" { "shop.buy".to_string() } else { format!("{domain}.{id}") };
    let inputs = [
        format!("{domain}Input"),
        "schema.object({ n: schema.number() })".to_string(),
        "42".to_string(),
    ];
    let input = rng.pick(&inputs);
    let rate = rng.pick(&["", "rateLimit: { key: \"player\", windowMs: 1000, max: 5 },", "rateLimit: { max: -1 },"]);
    let extra = rng.pick(&["", "import { helper } from \"./model\";\n", "import { missing } from \"./not-yet\";\n"]);
    format!(
        "import {{ defineAction }} from \"aruna/server\";\n\
         import {{ schema }} from \"aruna/schema\";\n\
         import {{ {domain}Input }} from \"./schema\";\n{extra}\n\
         export const act = defineAction({{ id: \"{id}\", input: {input}, {rate} run() {{ return undefined; }} }});\n"
    )
}

fn signals_source(rng: &mut Rng, domain: &str) -> String {
    let wire = rng.pick(&["", "wire: \"binary\",", "unreliable: true,"]);
    let ids = [format!("{domain}.changed"), "shop.changed".to_string()];
    let id = rng.pick(&ids);
    format!(
        "import {{ defineSignal }} from \"aruna/server\";\n\
         import {{ {domain}Payload }} from \"./schema\";\n\n\
         export const changed = defineSignal({{ id: \"{id}\", payload: {domain}Payload, {wire} }});\n"
    )
}

fn store_source(rng: &mut Rng, domain: &str) -> String {
    let version = rng.pick(&["1", "2", "\"x\""]);
    let definer = rng.pick(&["defineStore", "definePlayerStore"]);
    format!(
        "import {{ {definer} }} from \"aruna/server\";\n\
         import {{ {domain}Record }} from \"../schema\";\n\n\
         export const data = {definer}({{ id: \"{domain}.data\", version: {version}, schema: {domain}Record, defaultValue: {{ coins: 0 }} }});\n"
    )
}

// Resource definitions in every shape the primitive reads: player and global
// scope, a schema imported from ./schema (a discovery dependency), an invalid
// scope, a missing load, and an id shared across domains (a duplicate).
fn resources_source(rng: &mut Rng, domain: &str) -> String {
    let scope = rng.pick(&["", "scope: \"global\",", "scope: \"team\","]);
    let ids = [format!("{domain}.state"), "shop.state".to_string()];
    let id = rng.pick(&ids);
    let load = rng.pick(&["load: () => ({ coins: 0 }),", ""]);
    let authorize = rng.pick(&["", "authorize: () => true,"]);
    format!(
        "import {{ defineResource }} from \"aruna/server\";\n\
         import {{ {domain}Record }} from \"./schema\";\n\n\
         export const state = defineResource({{ id: \"{id}\", {scope} schema: {domain}Record, {load} {authorize} }});\n"
    )
}

fn model_source(rng: &mut Rng, domain: &str) -> String {
    let body = rng.below(1000);
    let import = rng.pick(&["", "import { formatAmount } from \"../../shared/format\";\n", "import { act } from \"./actions\";\n"]);
    format!("{import}export function helper(): number {{\n  return {body};\n}}\nexport const name = \"{domain}\";\n")
}

fn ui_source(rng: &mut Rng, _domain: &str) -> String {
    let import = rng.pick(&["import { helper } from \"./model\";\n", "import { act } from \"./actions\";\n", ""]);
    format!("{import}export const label = \"ui\";\n")
}

// The project's files, by relative path, and how to regenerate each.
fn domain_files(domain: &str) -> Vec<(String, fn(&mut Rng, &str) -> String)> {
    vec![
        (format!("src/domains/{domain}/schema.ts"), schema_source),
        (format!("src/domains/{domain}/actions.ts"), actions_source),
        (format!("src/domains/{domain}/signals.ts"), signals_source),
        (format!("src/domains/{domain}/server/store.ts"), store_source),
        (format!("src/domains/{domain}/resources.ts"), resources_source),
        (format!("src/domains/{domain}/model.ts"), model_source),
        (format!("src/domains/{domain}/ui.tsx"), ui_source),
    ]
}

fn seed_project(root: &Path, rng: &mut Rng) {
    write(root, "tsconfig.json", "{}\n");
    write(root, "src/shared/format.ts", "export function formatAmount(n: number): string { return `${n}`; }\n");
    write(root, "src/server.ts", "export const ready = true;\n");
    write(root, "src/client.tsx", "export const ready = true;\n");
    for domain in &DOMAINS[..2] {
        for (path, generate) in domain_files(domain) {
            let contents = generate(rng, domain);
            write(root, &path, &contents);
        }
    }
}

fn existing_sources(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    for entry in walk(&root.join("src")) {
        found.push(entry.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"));
    }
    found.sort();
    found
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return files;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            files.extend(walk(&path));
        } else {
            files.push(path);
        }
    }
    files
}

// One random edit; returns the paths it touched (what a watcher would report).
fn random_edit(root: &Path, rng: &mut Rng) -> (String, Vec<PathBuf>) {
    let domain = *rng.pick(&DOMAINS);
    let files = domain_files(domain);
    let existing = existing_sources(root);
    match rng.below(10) {
        // Rewrite a definition or module of a domain (creating it if absent).
        0..=4 => {
            let (path, generate) = rng.pick(&files);
            let contents = generate(rng, domain);
            (format!("write {path}"), vec![write(root, path, &contents)])
        }
        // Body-only edit of an existing file.
        5 => {
            let path = rng.pick(&existing).clone();
            let mut contents = fs::read_to_string(root.join(&path)).unwrap();
            contents.push_str(&format!("// edit {}\n", rng.next()));
            (format!("append {path}"), vec![write(root, &path, &contents)])
        }
        // Remove a file.
        6 => {
            let path = rng.pick(&existing).clone();
            fs::remove_file(root.join(&path)).unwrap();
            (format!("remove {path}"), vec![root.join(&path)])
        }
        // Rename a file within its directory.
        7 => {
            let path = rng.pick(&existing).clone();
            let target = path.replace(".ts", "-moved.ts").replace("-moved-moved", "-moved");
            if target == path {
                return (format!("noop {path}"), Vec::new());
            }
            let from = root.join(&path);
            let to = root.join(&target);
            fs::rename(&from, &to).unwrap();
            (format!("rename {path} -> {target}"), vec![from, to])
        }
        // Create the module an unresolved import points at, or a file with a
        // parse error.
        8 => {
            let path = format!("src/domains/{domain}/not-yet.ts");
            let contents = if rng.below(2) == 0 { "export const missing = 1;\n" } else { "export const = ;\n" };
            (format!("write {path}"), vec![write(root, &path, contents)])
        }
        // Remove a whole domain directory.
        _ => {
            let dir = root.join(format!("src/domains/{domain}"));
            if dir.exists() {
                fs::remove_dir_all(&dir).unwrap();
            }
            (format!("remove dir {domain}"), vec![dir])
        }
    }
}

fn run_seed(seed: u64, steps: usize) {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let mut rng = Rng(seed.max(1));
    seed_project(root, &mut rng);

    let mut session = CompilerSession::new(input(root));
    let mut history = Vec::new();
    for step in 0..=steps {
        if step > 0 {
            let (description, touched) = random_edit(root, &mut rng);
            history.push(description);
            session.update(&touched);
        }
        let incremental = serde_json::to_string(&session.inspect()).unwrap();
        let clean = serde_json::to_string(&inspect_project(input(root))).unwrap();
        if incremental != clean {
            panic!(
                "seed {seed}: session output diverged from a clean check after step {step}\nedits:\n  {}\n",
                history.join("\n  ")
            );
        }
    }
}

const FIXED_SEEDS: [u64; 8] = [1, 2, 3, 42, 1337, 0xdead_beef, 20_261_027, 987_654_321];

#[test]
fn session_matches_a_clean_check_for_fixed_seeds() {
    for seed in FIXED_SEEDS {
        run_seed(seed, 40);
    }
}

#[test]
fn session_matches_a_clean_check_for_a_random_seed() {
    let seed = std::env::var("ARUNA_SESSION_SEED")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos() as u64
        });
    eprintln!("session differential seed: {seed} (rerun with ARUNA_SESSION_SEED={seed})");
    run_seed(seed, 40);
}

#[test]
fn a_body_edit_rediscovers_only_the_edited_file() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let mut rng = Rng(7);
    seed_project(root, &mut rng);
    let mut session = CompilerSession::new(input(root));
    session.inspect();
    let before = session.stats();

    let model = root.join("src/domains/shop/model.ts");
    let mut contents = fs::read_to_string(&model).unwrap();
    contents.push_str("export const touched = 1;\n");
    fs::write(&model, contents).unwrap();
    session.update(&[&model]);
    session.inspect();
    let after = session.stats();

    assert_eq!(after.discoveries - before.discoveries, 1, "only the edited file is rediscovered");
    assert_eq!(after.static_imports - before.static_imports, 1);
    assert_eq!(after.resolutions - before.resolutions, 1);
}

#[test]
fn a_schema_edit_rediscovers_the_files_that_import_it() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let mut rng = Rng(11);
    seed_project(root, &mut rng);
    let mut session = CompilerSession::new(input(root));
    session.inspect();
    let before = session.stats();

    // shop's actions, signals, store, and resources read shop/schema.ts through
    // the import hop; the schema module itself is rediscovered too.
    let schema = root.join("src/domains/shop/schema.ts");
    fs::write(&schema, schema_source(&mut Rng(99), "shop")).unwrap();
    session.update(&[&schema]);
    let incremental = serde_json::to_string(&session.inspect()).unwrap();
    let clean = serde_json::to_string(&inspect_project(input(root))).unwrap();
    assert_eq!(incremental, clean);
    assert_eq!(session.stats().discoveries - before.discoveries, 5);
}
