# Compiler primitives

A **primitive** is a `define*` call the compiler discovers statically —
`defineAction`, `defineSignal`, `defineStore` / `definePlayerStore`, `defineRuntime` —
and records in the manifest without running project code. This document is for adding
one. The worked example is a toy, `defineEmote`, that exists only in a test:
[`crates/aruna_compiler/src/primitives/toy.rs`](../crates/aruna_compiler/src/primitives/toy.rs).

## Where things live

| Module | What it owns |
| --- | --- |
| `primitives/registry.rs` | The `Primitive` trait, `parse_source`, `ParsedFile`, the generic `discover` walker, and `register_primitives!`. |
| `primitives/mod.rs` | The registration list, and the serialization metadata actions and signals share. |
| `primitives/action.rs`, `signal.rs`, `store.rs`, `runtime.rs` | One primitive each: its manifest record, its static field extraction, its whole-project checks. |
| `schema_metadata.rs` | Reading a `schema.*` expression (inline, a module-level const, or a one-hop import) into `ArunaSchemaMetadata`. |
| `static_literals.rs` | Property lookup and literal reading on a definition object. |
| `spans.rs` | Spans, source types, and the schema diagnostics every primitive reports. |
| `payload_size.rs` | The largest binary encoding a schema allows (the signal size checks). |
| `packages/aruna/src/cli/primitives.ts` | The CLI's view: the contract snapshot, snapshot parsing, `contract diff`, and `aruna inspect <primitive>`. |

## How discovery runs

`graph.rs` parses each project file once (`parse_source`) and hands the program to
`PrimitiveRecords::discover_file`, which runs every registered primitive's discovery
over it **in registration order**. For each primitive the shared walker finds
`export const <name> = <callee>(...)` where `<callee>` is one of the primitive's
`CALLEES`, marks the file as defining it, and calls `Primitive::analyze` on the call.
Records come back sorted by `sort_key`. Spec files (`ModuleKind::Test`) are never
discovered: a `define*` inside a spec is a fixture.

After every file, `PrimitiveRecords::finalize(FinalizeStage::AfterDiscovery, …)` runs each
primitive's whole-project checks — duplicate ids, the runtime boot order — in
**reverse** registration order; primitives that declare
`FINALIZE_STAGE = AfterImports` run after the import graph instead. Both orders are what
the checks ran in before the registry existed, and the diagnostics list is output: the
compiler never re-sorts it, so changing either order changes `aruna check --json`.

A file that defines a primitive with a `DEFINING_MODULE` is reclassified to that module
kind (actions → `server-action`, stores → `server-store`); when it defines several, the
earliest-registered one wins.

## Adding a primitive

1. **The record.** In a new `primitives/<name>.rs`, a `serde` struct with
   `#[serde(rename_all = "camelCase")]`. Its field order and its
   `skip_serializing_if` choices are the manifest format: a field that is usually
   empty or false should be omitted when it is, so manifests of projects that do not
   use it stay byte-stable.

2. **The `Primitive` impl.**

   ```rust
   pub struct EmotePrimitive;

   impl Primitive for EmotePrimitive {
       type Record = ToyEmoteRecord;
       const NAME: &'static str = "emote";
       const CALLEES: &'static [&'static str] = &["defineEmote"];
       const DEFINING_MODULE: Option<DefiningModule> = None; // shared code
       const IN_CONTRACT: bool = true;

       fn analyze(site: &DefinitionSite<'_, '_>, diagnostics: &mut Vec<ArunaDiagnostic>)
           -> Option<Self::Record> { /* read site.call's object literal */ }

       fn sort_key(record: &Self::Record) -> (&str, &str, &str) {
           (&record.id, &record.file, &record.export_name)
       }

       fn finalize(records: Vec<Self::Record>, diagnostics: &mut Vec<ArunaDiagnostic>)
           -> Vec<Self::Record> { /* duplicate ids */ records }
   }
   ```

   - `analyze` reads only what is statically there. Use `static_literals` for
     properties and literals, and `site.schema_scope()` with `schema_metadata` for a
     schema field. When a field is not static, report it — every primitive's ids
     must be string literals, because the build resolves them without executing the
     project — and return `None` to keep the definition out of the manifest.
   - Diagnostic codes are never reused; take a free one from `diagnostics.rs` (and
     see the reserved ranges in `docs/init-spec.md`) and register its name there.
   - Set `DEFINING_MODULE` when a file defining it must stay away from the client
     (`server-*` kinds), and `IN_CONTRACT` when a change to it can break a client or a
     saved record.

3. **Register it**: one line in the list in `primitives/mod.rs`. Its position is its
   discovery order; append unless there is a reason not to.

4. **The manifest.** Add a field to `ArunaManifest` (`manifest.rs`) and
   `BuildGraphResult` (`graph.rs`), omitted when empty, filled from
   `primitives.<name>`. Add the record type to `@arunajs/core`'s `Manifest`.

5. **The CLI.** One entry in `PRIMITIVES` (`packages/aruna/src/cli/primitives.ts`):
   - `contract`, when `IN_CONTRACT` is true: the snapshot `key` (omitted when empty
     unless `required`), `summarize` (records in snapshot order), `parseRecord` (for a
     committed snapshot), `identity` and `duplicateMessage`, and `diff`. Add the key to
     `ActionContractSnapshot`.
   - `inspect`, for an `aruna inspect <command>` subcommand: `report` (the `--json`
     output) and `format` (the human output).

   `test/primitive-registry.test.ts` fails until the CLI list matches the compiler's
   (names, order, and contract membership), via the native `primitiveDescriptors()`.

6. **Codegen**, if the primitive generates code: `codegen.rs`, as signals do.

7. **Tests.** Discovery cases next to the primitive (see `primitives/tests.rs`), a
   fixture under `fixtures/` with expected output, and a golden for it: run
   `ARUNA_UPDATE_GOLDEN=1 pnpm --filter aruna exec vitest run test/compiler-output-guard.test.ts`
   and review the new `test/__golden__/compiler-output/<fixture>.golden`.

## The output guard

`packages/aruna/test/compiler-output-guard.test.ts` runs every fixture through every
`--json` command (`inspect actions|signals|stores|contract|modules|graph`, `check`,
`build`, and `contract diff` where a snapshot is committed) and compares stdout, exit
codes, and every generated file **byte for byte** with the committed goldens. A change
that moves a key, reorders a diagnostic, or changes a message fails it. Adding a
primitive should add goldens, never change existing ones; if an existing golden
changes, the change is a user-visible output change and belongs in the CHANGELOG.
