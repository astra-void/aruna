# CLI

The `aruna` binary drives the compiler. Run it via your package manager (e.g.
`pnpm aruna build`) or the local bin.

## Commands

| Command | What it does |
| --- | --- |
| `aruna init` | Scaffold `aruna.config.ts` and `default.project.json`, and create or reconfigure `tsconfig.json` (see [tsconfig.json](#tsconfigjson)). |
| `aruna check` | Type-check the project and validate module boundaries. Does **not** generate. |
| `aruna build` | Generate action stubs + manifest, vendor the Roblox runtime, then compile to Luau with rbxtsc. Incremental between runs (`--no-cache` compiles from scratch); `--timings` prints each phase. |
| `aruna dev` | One-terminal dev loop: `build --watch` plus a `rojo serve` child. |
| `aruna test` | Compile the project *with* its specs and run them under Lune (`--filter <pattern>`). See [Testing](./testing.md). |
| `aruna add domain <name>` | Scaffold `<root>/domains/<name>/{schema,model,actions,actions.test}.ts` (`--with ui,runtime` for extras). |
| `aruna doctor [--fix]` | Report what `tsconfig.json` still needs, the `aruna/*` and `$aruna/*` aliases, and the Rojo project (with `--fix`, reconfigure `tsconfig.json`). |
| `aruna inspect actions` | List discovered actions and contract metadata. |
| `aruna inspect signals` | List discovered server → client signals. |
| `aruna inspect stores` | List discovered stores, their version, scope, and persisted shape. |
| `aruna inspect resources` | List discovered resources: scope, value shape, and whether subscriptions are authorized. |
| `aruna inspect network` | Print the declared traffic policy: rate limits, budgets, input bounds, signal remotes and schema-bound sizes, resource scopes. Static, not measured — see [observability.md](observability.md). |
| `aruna inspect contract` | Print a deterministic contract snapshot: actions, signals, stores, and resources. |
| `aruna inspect modules` | Print how each file is classified (client/server/shared). |
| `aruna inspect graph` | Print the import graph. |
| `aruna contract diff` | Compare contract snapshots — actions, signals, stores, and resources (`--baseline`, `--from`, `--to`; with none, the committed snapshot). |
| `aruna contract update` | Write the current contract to the committed snapshot (`contract.snapshot`); refuses a store change that leaves saved records unreadable. `--check` writes nothing and exits 1 when the snapshot is out of date. |
| `aruna migrate <name>` | Run a codemod for one of Aruna's breaking changes (`--list` to see them, `--dry-run` for a unified diff that writes nothing). See [Codemods](https://github.com/astra-void/aruna/blob/main/docs/codemods.md). |

## The check vs build distinction

`aruna check` is fast and read-only: it reports diagnostics and boundary violations but
writes nothing. `aruna build` is what regenerates `$aruna/actions/*`, `$aruna/signals`,
the manifest, and the vendored runtime. **After changing any action or signal you must
run `aruna build`** — otherwise the generated client stubs reference the old contract.

`check` also flags **layout desync** as `aruna::111`: a tsconfig alias that maps to a path
the current emit layout does not generate, or a tsconfig that still extends the generated
`tsconfig.aruna.json` fragment older releases wrote. `check` itself never edits
`tsconfig.json`; the next `aruna build` (or `aruna doctor --fix`) fixes both.

## tsconfig.json

You do not wire `tsconfig.json` up by hand. Like `next dev` and `next build`, Aruna keeps it
correct itself: `aruna init`, `aruna build`, `aruna dev`, and `aruna test` read it before they
compile, make the changes roblox-ts and Aruna need, and say what they changed:

```
reconfigured tsconfig.json for roblox-ts and Aruna

  mandatory changes:
    - module was set to "CommonJS" (required by roblox-ts)
    - paths was updated to add $aruna/signals, aruna/testing (Aruna's generated modules and vendored runtime resolve through them)

  suggested values (yours to change):
    - skipLibCheck was set to true
```

- **Mandatory changes** are forced, because nothing else works: the compile contract
  roblox-ts enforces (`target`, `module`, `moduleResolution`, `moduleDetection`, `noLib`,
  `strict`, `allowSyntheticDefaultImports`, `node_modules/@rbxts` in `typeRoots`), the
  Aruna aliases in `paths`, and the dot-folder generated dir in `include` (TypeScript's
  wildcards skip `src/.aruna`, where the generated entry scripts live).
- **Suggested values** (`skipLibCheck`, `rootDir`, `outDir`, `jsx`, `types`, `include`,
  `exclude`, ...) are added only when the key is unset, and are yours to change: a value
  you set is never touched again.

Only those keys are edited, in place: comments, formatting, key order, and everything else
in the file stay as you wrote them. Settings a base config supplies through `extends`
count as set. The aliases are written relative to `tsconfig.json`, with no `baseUrl`:

```jsonc
"paths": {
  "$aruna/actions/client": ["./src/.aruna/shared/actions.client.generated.ts"],
  "aruna/server": ["./src/.aruna/shared/runtime/server.ts"],
  // ...your own aliases sit next to them, untouched
  "@/*": ["./src/*"]
}
```

A project that sets its own `baseUrl` keeps it, and the aliases are written relative to it.
A `tsconfig.json` that cannot be parsed is left alone (the build reports it as
`aruna::103`).

## The store compatibility gate

When the project commits a contract snapshot — `aruna.contract.json` by default,
`contract.snapshot` in the config to move it — `aruna check` and `aruna build` compare the
project's stores against it on every run, with no flags. A change that would leave
records the previous build saved unreadable is `aruna::578 store-incompatible-change`, an
error by default, and `build` stops before vendoring or compiling. `strict.storeCompatibility`
lowers it to `"warning"` or turns it `"off"`. An unreadable snapshot file is
`aruna::579 contract-snapshot-invalid`. Without a snapshot there is no gate.

The rules are in [Stores](./stores.md#the-compatibility-gate). There are only two ways
to make a breaking store change safe: give the new field a `.default(...)`, or bump the
store's version and write a `migrate()` that converts the old records. Once you have,
record the change:

```bash
aruna contract update      # rewrites aruna.contract.json from the current code
aruna contract diff        # what changed against the committed snapshot
```

`contract update` refuses to write from a project that does not compile, and it refuses
a store change that would still leave saved records unreadable: it diffs the committed
snapshot against the current code first, lists those changes, and exits 1. Meaning the
change does not make the old records readable, so rewriting the snapshot would only
switch the gate off. `--accept-unreadable-records` writes it anyway, with a warning, for
the case where losing those records is the plan (a store nobody has shipped yet, a
deliberate wipe). An unreadable snapshot file is refused the same way — restore it from
version control — since there is nothing to compare against.

Commit the snapshot with the change, so the next build is gated against what this one
ships.

### Keeping the snapshot current in CI

`aruna contract update --check` writes nothing. It exits 1 when the committed snapshot is
missing, unreadable, or different from what `contract update` would write (whitespace
aside), and says whether `contract update` would refuse the difference. Run it next to
`aruna check` so a pull request cannot change a contract without recording it:

```yaml
# .github/workflows/ci.yml
jobs:
  aruna:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      # Fails on a store change that saved records cannot survive (aruna::578).
      - run: pnpm exec aruna check
      # Fails when the PR changed a contract without running `aruna contract update`.
      - run: pnpm exec aruna contract update --check
```

`check` and `update --check` catch different things: `check` fails on an unreadable store
change whether or not the snapshot was touched, and `update --check` fails on any
contract change — an action's input, a signal's payload, a compatible store change — that
was not recorded. For what `--json` prints, see [JSON output](#json-output).

`aruna build` tracks the files it emits in a `.aruna-build.json` ledger inside `generatedDir`
and **prunes stale artifacts** a previous build emitted and this one does not (a removed
signal's generated file, for example). Pruning is confined to the `generatedDir` and
the owned ledger, so hand-written files are never touched.

## Exit codes

Every command exits 0 when it succeeds. Beyond that:

| Command | Exits non-zero when |
| --- | --- |
| `check`, `build`, `inspect …` | the compiler reports an error (`1`), or, with `--warnings-as-errors`, a warning |
| `doctor` | config or tsconfig problems remain, or the Rojo project does not mount `out/` (`1`) |
| `contract diff` | a change is **breaking** (`1`); the comparison could not run, because the project has compiler errors or a snapshot is unreadable (`2`) |
| `contract update` | it refused to write (a store change that leaves records unreadable, or a project that does not compile), or with `--check`, the snapshot is out of date (`1`) |
| `test` | a spec failed or the suite could not run (`1`) |
| `migrate` | the codemod could not run (`1`) |

`--json` changes the output, not the exit code. Every diagnostic code, its default
severity and meaning are listed in [diagnostics.md](./diagnostics.md).

## JSON output

With `--json`, a command prints one JSON document on stdout and nothing else there.
The shapes are part of the [stable surface](../../../docs/stability.md): a key is not
renamed or removed outside a major version, and new keys may appear, so ignore keys you
do not know.

| Command | Prints |
| --- | --- |
| `inspect` | The compiler output (`CompilerOutput`, exported from `aruna`): `{ ok, projectRoot, config, diagnostics, manifest, summary }` |
| `check` | The compiler output plus `manifestPath` |
| `build` | The compiler output plus `manifestPath` and `generatedFiles`, and when they apply `tsconfig` (what the upkeep wrote), `pruned` (stale artifacts removed), `rbxtsc` (the Luau compile) and `timings` (with `--timings`) |
| `inspect actions` / `signals` / `stores` / `resources` | `{ actions \| signals \| stores \| resources, diagnostics, summary }` |
| `inspect contract` | The contract snapshot, the same document `contract update` writes |
| `inspect network` | `{ kind: "static", note, requestBudget, defaultRateLimit, actions, signals, resources }` |
| `inspect modules` / `graph` | `{ modules \| imports, diagnostics, summary }` |
| `contract diff` | `{ version: 1, summary: { breaking, warning, nonBreaking, info }, entries }` |
| `contract update` | Written: `{ ok: true, snapshot }`, plus `acceptedUnreadableRecordChanges` with `--accept-unreadable-records`. Refused: `{ ok: false, snapshot, committed, unreadableRecordChanges }` |
| `contract update --check` | `{ ok, snapshot, outOfDate, committed, unreadableRecordChanges }` |
| `doctor` | `{ projectRoot, configPath?, tsconfigPath, generatedDir, generatedDirResolved, manifestOutput, manifestOutputResolved, configDiagnostics, tsconfigDiagnostics, tsconfig, aliases, toolchain, rojoProject, fixable, fix? }` |
| `init` | `{ projectRoot, created, overwritten, skipped, tsconfig, rojoProject }` |
| `add domain` | `{ name, domainDir, created, skipped }` |
| `migrate --list` | `[{ name, description }]` |
| `migrate <name>` | `{ codemod, dryRun, filesScanned, changed: [{ file, diff }], unhandled: [{ file, line, column, message }] }` |

`committed` is `"ok"`, `"missing"` or `"invalid"`. `contract diff` and
`contract update`, when the project has compiler errors, print the compiler output
instead of their own report, so a tool can read `diagnostics`.

When a command fails before it has anything to report, it prints nothing on stdout and
writes the message to stderr. Examples are `contract diff` with no snapshot to compare
against, an invalid domain name, or a codemod that cannot run. Check the exit code before
parsing stdout.

`build --watch`, `dev` and `test` do not take `--json`. They exit 1 with a message on
stderr.

## Global flags

Available on every command:

```
--project <path>        project root (default: cwd)
--config <path>         config file path
--json                  emit machine-readable JSON (for CI/tooling)
--quiet                 reduce human-readable output
--verbose               show additional output
--no-color              disable color
--warnings-as-errors    treat warnings as failures (non-zero exit)
```

## `aruna build` flags

```
--no-emit-runtime   skip vendoring the Roblox-targeted runtime into the generated dir
--no-emit-luau      only generate stubs + vendor the runtime; skip the rbxtsc Luau compile
--watch             stay running and rebuild on source changes
```

By default `build` vendors the runtime and runs rbxtsc, partitioning the project into
client/server/shared so the emitted `out/` maps onto the Roblox DataModel (server code
stays in `ServerScriptService`, never replicated). See [architecture.md](./architecture.md).

`--watch` keeps the process alive and re-runs the full build (stubs + vendored runtime +
rbxtsc) whenever project source changes, so stubs and contracts never go stale while you
work — this replaces re-running `aruna build` by hand after every action/signal edit.
Save bursts are debounced into one rebuild, a change landing mid-build queues exactly one
follow-up, and the build's own output trees (the generated dir, `out/`, `include/`,
`node_modules/`) never re-trigger it. Not combinable with `--json`.

## `aruna dev`

The daily loop in one terminal: the watch build (identical to `aruna build --watch`)
plus a `rojo serve` child, so saving a file gives you codegen + Luau + Studio sync
without juggling processes.

```
--no-emit-runtime   skip vendoring the Roblox-targeted runtime into the generated dir
--no-emit-luau      skip the rbxtsc Luau compile step on each rebuild
--no-rojo           do not spawn rojo serve
--rojo-port <port>  port for the rojo serve child
```

`rojo serve` is spawned after the first build pass (so `out/` exists) when a
`default.project.json` is present and `dev.rojo` is not `false`. Rojo's output is
prefixed with `rojo │` so it stays distinguishable from build output. Rojo failing to
launch (not installed) or exiting never tears down the watch build — you get a warning
and the loop keeps running. Configure via `aruna.config.ts`:

```ts
export default defineConfig({
  dev: {
    rojo: true,                // true (default) | false | { port: 34873 }
  },
});
```

## `aruna add`

`aruna add domain shop` scaffolds a Recommended Layout domain under the configured
source root: `src/domains/shop/{schema,model,actions}.ts`, plus `ui.tsx` and/or
`runtime.ts` with `--with ui,runtime`. The file names are the classifier's own
conventions (`**/schema.ts`/`**/model.ts` shared, `**/actions.ts`/`**/runtime.ts`
server, `**/ui.tsx` client), so scaffolded files are correctly classified by
construction. Existing files are never overwritten. Follow up with `aruna build` (or
just save under a running `aruna dev`) to regenerate stubs for the new domain.

When a concern outgrows one file, rename it into a folder of the same name
(`actions.ts` → `actions/buy.ts`, `actions/sell.ts`) or move it under the domain's own
`server/` or `client/` folder. Both are the same classification to the compiler, and
`aruna build` finds the definitions either way.

## `aruna doctor`

`aruna doctor` reports, without writing anything, what [`tsconfig.json`](#tsconfigjson)
still needs, where each `aruna/*` and `$aruna/*` alias points, the Rojo project, and the
roblox-ts/TypeScript pairing. It exits 1 while a mandatory change is pending.
`aruna doctor --fix` makes the same `tsconfig.json` changes `aruna build` would.

## `aruna migrate`

When a release changes something your code spells out — a renamed error name, a moved
import — it ships a codemod, named in its CHANGELOG entry:

```sh
aruna migrate --list
aruna migrate action-validation-error-name --dry-run   # prints a unified diff
aruna migrate action-validation-error-name             # writes the changes
```

A codemod edits only the code it changes (no reformatting), can be run any number of
times, and lists the sites it could not rewrite safely as `file:line:column` for you to
check by hand. See [Codemods](https://github.com/astra-void/aruna/blob/main/docs/codemods.md).

## Config (`aruna.config.ts`)

```ts
import { defineConfig } from "aruna";

export default defineConfig({
  actions: {
    // strategy: "fixedWindow" (default) | "tokenBucket"
    defaultRateLimit: { key: "player", windowMs: 1000, max: 20 },
  },
  conventions: {
    client: ["**/client/**"],
    server: ["**/server/**"],
    shared: ["**/shared/**"],
  },
  domains: {
    roots: ["src/features/*"],                // added to the built-in src/domains/*
  },
  strict: {
    sharedSafety: true,                       // aruna::306-309; see shared-safety.md
    rawRemoteUsage: "warning",                // aruna::507: "off" | "warning" | "error"
    unresolvedImports: "warning",             // aruna::105
    domainBoundary: "warning",                // aruna::304: imports past a domain's public surface
    storeCompatibility: "error",              // aruna::578: a store change saved records can't survive
    unboundedInput: "warning",                // aruna::514: an action input with no size bound
  },
  diagnostics: {
    ignore: [],                               // codes or names to drop, e.g. "raw-remote-usage"
  },
  contract: {
    snapshot: "aruna.contract.json",          // the committed snapshot check/build gate stores against
  },
});
```

`defineConfig` is exported from the package root (`aruna` / `@arunajs/aruna`), alongside
the programmatic `buildProject` / `checkProject` / `inspectProject` APIs if you want to
run the compiler from a script instead of the CLI.
