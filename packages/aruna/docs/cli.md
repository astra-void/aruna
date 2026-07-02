# CLI

The `aruna` binary drives the compiler. Run it via your package manager (e.g.
`pnpm aruna build`) or the local bin.

## Commands

| Command | What it does |
| --- | --- |
| `aruna init` | Scaffold `aruna.config.ts`, `tsconfig.json`, and `default.project.json`. |
| `aruna check` | Type-check the project and validate module boundaries. Does **not** generate. |
| `aruna build` | Generate action stubs + manifest, vendor the Roblox runtime, then compile to Luau with rbxtsc. |
| `aruna doctor [--fix]` | Inspect (and with `--fix`, write) the `aruna/*` and `$aruna/*` tsconfig path aliases. |
| `aruna inspect actions` | List discovered actions and contract metadata. |
| `aruna inspect signals` | List discovered server → client signals. |
| `aruna inspect contract` | Print a deterministic action contract snapshot. |
| `aruna inspect modules` | Print how each file is classified (client/server/shared). |
| `aruna inspect graph` | Print the import graph. |
| `aruna contract diff` | Compare action contract snapshots (`--baseline`, `--from`, `--to`). |

## The check vs build distinction

`aruna check` is fast and read-only: it reports diagnostics and boundary violations but
writes nothing. `aruna build` is what regenerates `$aruna/actions/*`, `$aruna/signals`,
the manifest, and the vendored runtime. **After changing any action or signal you must
run `aruna build`** — otherwise the generated client stubs reference the old contract.

`check` also flags **layout desync** so an upgrade can't pass silently: `aruna::110` for a
stale generated artifact still on disk from a previous codegen layout, and `aruna::111` for
a tsconfig alias pointing at a path that no longer matches the current emit layout. Fix them
with `aruna build` (prunes stale output) and `aruna doctor --fix --emit-runtime` (realigns
aliases).

`aruna build` tracks the files it emits in a `.aruna-build.json` ledger inside `generatedDir`
and **prunes stale artifacts** it no longer emits (e.g. flat `*.generated.ts` and a flat
`runtime/` left by the split-tree migration). Pruning is confined to the `generatedDir` and
the owned ledger, so hand-written files are never touched.

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
--emit-runtime      explicit-on (now the default; kept for backward compatibility)
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

## `aruna doctor`

If `aruna/server`, `aruna/schema`, `$aruna/actions/client`, etc. fail to resolve, the
tsconfig path aliases are missing or stale. `aruna doctor` reports their status;
`aruna doctor --fix` writes the correct ones. Add `--emit-runtime` to also alias the
`aruna/*` subpaths to the vendored runtime (pair with `build`'s default vendoring).

## Config (`aruna.config.ts`)

```ts
import { defineConfig } from "aruna";

export default defineConfig({
  actions: {
    transport: "remote-event",               // "remote-event" | "remote-function" | "memory"
    defaultRateLimit: { key: "player", windowMs: 1000, max: 20 },
  },
  conventions: {
    client: ["**/client/**"],
    server: ["**/server/**"],
    shared: ["**/shared/**"],
  },
  strict: {
    sharedSafety: true,                       // forbid shared → server leaks
    rawRemoteUsage: "warning",                // "off" | "warning" | "error"
    unresolvedImports: "warning",
  },
});
```

`defineConfig` is exported from the package root (`aruna` / `@arunajs/aruna`), alongside
the programmatic `buildProject` / `checkProject` / `inspectProject` APIs if you want to
run the compiler from a script instead of the CLI.
