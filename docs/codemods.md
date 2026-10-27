# Codemods

`aruna migrate` rewrites a project across a breaking change. It is the mechanical half
of the deprecation process in [stability.md](stability.md): when a release changes
something a project's code spells out — a name, an import, a literal — the release ships a
codemod for it, and the CHANGELOG entry names it.

```sh
aruna migrate --list
aruna migrate action-validation-error-name --dry-run   # a unified diff; writes nothing
aruna migrate action-validation-error-name             # writes the changes
```

Every run prints the files it changed (with `--dry-run`, as a unified diff `git apply`
accepts) and the **sites it could not handle**, as `file:line:column` with what to check.
`--json` prints the report as JSON. It scans the project's `.ts` / `.tsx` sources, skipping
declaration files, `node_modules`, build output (`out`, `include`, `dist`), and the
generated dir.

## Available codemods

| Name | For | What it rewrites |
| --- | --- | --- |
| `action-validation-error-name` | The client error for an action whose input or output fails its schema was renamed from `"SchemaValidationError"` to `"ActionValidationError"`. | The literal `"SchemaValidationError"` where it is compared against an error's `name`: `===`, `==`, `!==`, `!=` in either order, with `err.name`, `err?.name`, `err["name"]`, through parentheses, `as`, `satisfies`, and `!`; and the `case` labels of a `switch (err.name)`. Every other exact occurrence of the literal — a constant, an argument, a comparison against something that is not a `name` — is reported, not rewritten. |

## How the engine works

The engine is the `aruna_migrate` crate (`crates/aruna_migrate`), exposed to the CLI
through the native compiler (`listCodemods`, `runCodemod`).

- **Format-preserving.** A codemod never prints code. It gets the file's Oxc AST and its
  original text, and returns byte-range **edits**: replace `start..end` with this string.
  The engine applies them to the original text. Indentation, comments, quote style,
  trailing commas — everything outside the edited ranges — stays byte for byte.
- **Conservative.** A codemod rewrites only what the syntax proves is the thing that
  changed, and reports what it merely suspects. Reporting a site costs the user a look;
  a wrong rewrite costs them a bug they did not write.
- **Idempotent.** Running a codemod on its own output changes nothing, so running it
  twice, or on a half-migrated project, is safe.
- A file that does not parse is skipped and reported.

## Writing a codemod

1. **Add a module** under `crates/aruna_migrate/src/codemods/` with a type implementing
   `Codemod`:

   ```rust
   pub(crate) struct MyRename;

   impl Codemod for MyRename {
       fn name(&self) -> &'static str { "my-rename" }
       fn description(&self) -> &'static str { "One line for --list" }
       fn transform(&self, file: &SourceFile<'_>) -> FileOutcome {
           // Walk `file.program` (an `oxc_ast_visit::Visit` works well), push a
           // `TextEdit { start, end, replacement }` for each rewrite, and an
           // `Unhandled { offset, message }` for each site you recognize but
           // cannot rewrite safely.
       }
   }
   ```

   `action_validation_error_name.rs` is a complete example: it collects every
   occurrence of the old literal, rewrites the ones in a recognized position, and
   reports the rest.

2. **Register it** in `codemods/mod.rs`'s `ALL`.

3. **Add fixtures** under `crates/aruna_migrate/tests/fixtures/<name>/<case>/`:
   `input.ts` (or `.tsx`) and `expected.ts`, written by hand. Cover the rewrites, the
   sites that must be left alone, and the sites that must be reported. Then generate the
   two snapshots and review them:

   ```sh
   ARUNA_UPDATE_FIXTURES=1 cargo test -p aruna_migrate --test fixtures
   ```

   `unhandled.txt` lists the reported sites; `dry-run.diff` is what `--dry-run` prints.
   The fixture test checks, for every case, that input becomes expected exactly, that
   expected comes back unchanged (idempotency), both snapshots, and that a dry run writes
   nothing while a real run writes the expected file. A registered codemod without a
   fixture directory fails the suite.

4. **Name it** in the CHANGELOG entry of the breaking change, and add it to the table
   above.

Edits must not overlap; the engine refuses overlapping edits rather than guessing at an
order. When one rewrite would nest inside another, make the outer edit cover both.
