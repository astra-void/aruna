# Compiler performance

## The benchmark

```sh
pnpm bench:compiler            # 200, 1000, 3000 files; session if the binary has one
pnpm exec tsx scripts/bench-compiler.ts --sizes 3000 --runs 9
pnpm exec tsx scripts/bench-compiler.ts --one-shot   # force the one-shot path
```

`bench:compiler` builds the native compiler in release mode first (the workspace's
`build:native` stages a debug build, which is several times slower and not what ships).
`scripts/bench-compiler.ts` generates a project in the recommended layout — per domain
`schema.ts`, `model.ts`, `actions.ts` (a `defineAction` whose schemas are imported from
`./schema`), `signals.ts`, `runtime.ts`, `ui.tsx`, and an `actions.test.ts`, plus
`src/server.ts`, `src/client.tsx`, `src/shared/format.ts` — at about 200, 1000, and 3000
files, and times, as the median of several runs:

| Scenario | What changes |
| --- | --- |
| cold | nothing; the first check |
| warm | nothing; a check right after another |
| body edit | a function body in one `model.ts` |
| import edit | one `actions.ts` gains an import |
| schema edit | one `schema.ts` changes an action input field's type |

It calls the native compiler directly with an input built once, so it measures the
compiler, not config loading. A session check includes the main-thread `JSON.parse` of
the output.

All numbers below: Apple M1 Pro (10 cores), Node 22.23.2, release build. The machine
was never idle — other work kept the load average between 9 and 130 while these were
taken — so treat differences under ~15% as noise and read the load noted with each
table.

## Results

### Baseline (before Part C)

One-shot `checkProject`, median of 5, ms:

| files | cold | warm | body edit | import edit | schema edit |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 199 | 51.4 | 46.5 | 46.8 | 48.0 | 57.1 |
| 997 | 234.6 | 243.9 | 241.9 | 244.0 | 229.0 |
| 2999 | 714.7 | 773.3 | 825.3 | 979.1 | 796.1 |

Every check was a cold check: nothing survived between calls.

### After

Session (`CompilerSession`), median of 9, ms (load average 29–67 during the run):

| files | cold | warm | body edit | import edit | schema edit |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 199 | 18.4 | 2.5 | 2.6 | 2.9 | 2.6 |
| 997 | 90.9 | 12.9 | 13.3 | 13.4 | 12.9 |
| 2999 | 305.9 | 39.9 | 40.6 | 40.7 | 40.8 |

Earlier runs of the same code on a less loaded machine (load average 9–26) gave
3000-file body edits of 36–39 ms; under heavier load (40–70) they rose to ~47 ms.

One-shot `checkProject` (now a single-use session), median of 5, ms:

| files | cold | warm | body edit | import edit | schema edit |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 199 | 16.9 | 16.1 | 17.5 | 17.9 | 16.4 |
| 997 | 95.4 | 82.5 | 82.7 | 84.7 | 82.8 |
| 2999 | 272.4 | 266.3 | 304.0 | 335.2 | 274.2 |

**Target: a one-file body edit on 3000 files rechecks in under 50 ms. Met: 40.6 ms**
(36–47 ms across runs at different machine loads), from 825 ms. The margin is thin
under load; see below for what would widen it.

### Where the baseline went

Phase timings of one baseline check at 3000 files:

| Phase | ms |
| --- | ---: |
| walking the project for source files | 23 |
| classifying modules | 400–1200 |
| per-file discovery (reading, hooks, primitives, raw remotes) | 145–270, of which parsing 6–9 |
| import pass (reading, parsing imports, resolving) | 230, of which resolution 130 |
| diagnostics, manifest | 7 |
| `serde_json::Value` conversion | 3 |

Classification dominated, and not for a good reason: every glob match compiled the
convention's glob set from scratch, per file, per kind. The compiled sets are now
memoized by pattern list (`module_kind.rs`), which is what took the one-shot path from
~800 to ~240 ms with no change in matching. Parsing was never the cost.

### Transferring the output to JS

The output at 3000 files is ~1.2 MB of JSON. Two ways to hand it over from the thread
pool, session checks at 2999 files, median of 5, ms (measured together, before the
`Value` step described below, at load average 9–26):

| Transfer | warm | body edit | import edit | schema edit |
| --- | ---: | ---: | ---: | ---: |
| JSON string, `JSON.parse` on the JS side | 35.1 | 36.0 | 35.7 | 35.0 |
| napi objects (`env.to_js_value`, built natively) | 40.1 | 40.3 | 46.4 | 50.7 |

The JSON string is faster (V8's `JSON.parse` beats building the same objects through
napi calls one property at a time) and is what `CompilerSession.check()` returns. The
string is serialized from a `serde_json::Value`, not straight from the structs: a
`Value`'s maps order keys alphabetically, so the CLI's `--json` output does not move
when a struct field is reordered. Serializing the structs directly emits declaration
order, which the output guard flagged on all 40 fixtures. The detour costs a few
milliseconds at 3000 files. The session is the only napi entry point for a check: the
one-shot `checkProject` / `inspectProject` in `@arunajs/compiler` are a session used
once.

### What is left in a warm check, and what would lower it

A warm 3000-file check spends ~35–40 ms that does not depend on the edit. Measured
inside one warm run:

| Step | ms |
| --- | ---: |
| assembling the graph from cached per-file facts (~3000 module records, ~4,700 import records, the primitives' records and whole-project checks) | ~22 |
| diagnostics (boundary rules over every import) and the manifest | ~8 |
| `serde_json::Value` + JSON string | ~5 |
| `JSON.parse` on the main thread | the rest |

Cached facts are shared (`Arc`), not copied, into each assembly, and the manifest is
built once unless writing it reports a failure. Ways further down, none needed for the
target: keep the assembled graph and patch it per changed file instead of refolding
every file (the assembly is the largest step); return only what changed since the last
run (the CLI mostly needs diagnostics and the generated files); or parse the output off
the main thread.

## End-to-end builds (2026-11)

The compiler is a small part of an `aruna build`. `aruna build --timings` prints each
phase; on ARCANUM (122 modules, 135 Luau files out) a one-shot build was:

| Phase | ms |
| --- | ---: |
| tsconfig upkeep | ~37 |
| compile (config load + native check + codegen + manifest) | ~270 |
| contract gate | <1 |
| vendor runtime | ~8–14 |
| ownership ledger | <1 |
| **rbxtsc** (stage + compile + copy back) | **~4,500–4,900** |

So the Luau compile was ~93% of a build, and it was always cold: every one-shot build
staged the project into a fresh temp dir and deleted it afterwards, throwing away
everything TypeScript could have reused. (The watch path, `aruna dev` / `build --watch`,
has kept a resident `rbxtsc --watch` since 0.2.)

What changed:

- **A persistent, incremental stage.** One-shot builds now stage into a per-project
  directory of the OS temp dir (keyed by the project's real path; `--no-cache` restores
  the old fresh stage) and compile with `incremental` and a `tsBuildInfoFile` inside the
  stage. Unchanged files are not restaged, rbxtsc reuses its build info and re-emits only
  what changed — its own one-shot `cleanup` removes the output of a deleted source — and a
  lock keeps two concurrent builds of one project from sharing the stage (the second
  compiles in a temp stage, as before). Not under `node_modules/.cache`: TypeScript treats
  files there as library code and resolves their symlinks, which broke the staged
  `rootDir` the first time this was tried against a symlinked `node_modules`.
- **Output mirrored, not replaced.** The staged `out/` and `include/` are mirrored into the
  project: byte-identical files are left alone (so `rojo serve` syncs only what changed)
  and stale ones are removed.
- **No rewrite of unchanged generated files.** The compiler compares a generated file (and
  the manifest) with what is on disk before writing it, and the build skips re-vendoring a
  runtime that already matches its source. A rebuild with nothing changed writes nothing
  into the generated dir (`tests/compiler.rs` checks the mtimes).

Measured: Apple M1 Pro (10 cores), Node 22.23.2, roblox-ts 3.0.0, load average 6–9; wall
time of one `aruna build --json --timings` process per row, after a warm-up. "Fresh" is
the same build with `--no-cache`, i.e. what every build cost before. The edits are the
scenarios in `scripts/verify-incremental-build.ts`.

ARCANUM (122 modules):

| Scenario | fresh (before) ms | cached (after) ms | rbxtsc after ms |
| --- | ---: | ---: | ---: |
| cold (empty cache) | 5,135 | — | 4,538 |
| no-op rebuild | ~5,000 | 2,596 | 2,012 |
| action body edit | 5,213 | 2,823 | 2,240 |
| action id edit | 5,069 | 3,167 | 2,585 |
| signal added | 5,067 | 3,049 | 2,485 |
| shared type edit (`PlayerStats`) | 4,942 | 3,593 | 3,034 |
| UI-only edit | 4,958 | 2,704 | 2,141 |
| new file | 5,013 | 2,479 | 1,916 |
| deleted file | 4,998 | 2,473 | 1,909 |

apps/rbxts-harness (26 modules): cold 2,140 ms; no-op 1,122 ms; edits 1,127–1,186 ms
cached against 1,930–1,951 ms fresh.

Peak RSS of a whole `aruna build` on ARCANUM: ~550 MB (rbxtsc's TypeScript program; the
Aruna process itself is a small part), unchanged by the cache.

What a warm build still spends: ~2 s of rbxtsc that no edit avoids — creating the
TypeScript program (parsing `@rbxts/types` and the project) and checking the changed
files' dependents. A shared type edit costs the most because more files depend on it.
`aruna dev` keeps the program resident and avoids even that.

**Correctness.** `pnpm verify:incremental-build` copies a project, applies edits (an action
body, a shared module, a new module, a deleted module, a client module), builds each with
the cache and again with `--no-cache`, and fails unless the two `out/` trees are
byte-identical; it passed on the rbxts harness and on ARCANUM (every scenario above, 135
files). What invalidates the stage: TypeScript keys the build info on the compiler options
and the content of every input (generated files and the vendored runtime included);
roblox-ts hashes its own version, the project type, and the Rojo project into the same
keys; a package removed from `node_modules` is unlinked from the stage. The compiler's own
cache is covered by the session differential test below, which now also edits resource
definitions.

## The design

### Query pipeline

`build_project_graph` reads every per-file fact through a `GraphCache`
(`crates/aruna_compiler/src/cache.rs`):

| Fact | Keyed by | Invalidated by |
| --- | --- | --- |
| source text | path | `update` naming the path (or a directory above it) |
| classification | path | never within a session (depends on the path and config only) |
| hook-module exports | content hash | the file's content |
| primitive discovery (records, defining flags, diagnostics) | content hash + the content hashes of every file its schema imports read | the file's content, or the content or existence of a schema module it resolved a binding from |
| raw-remote usages | content hash | the file's content |
| static imports | content hash | the file's content |
| import resolutions | content hash + a hash of the project's file set | the file's content, or any file added or removed |

The graph is then assembled from those facts by the same code a one-shot check runs, so
a session cannot produce output a clean check would not: a one-shot check is exactly a
session with an empty cache (`check_project` is `CompilerSession::new(input).check()`).
Parsing stays per file. A body edit re-reads, re-hashes, and re-parses that one file;
every other file costs a hash comparison.

Dependencies are recorded where they are actually used. Primitive discovery resolves a
schema imported from another module by reading that module (one hop); the scope records
the paths consulted for each imported binding, and only the bindings a schema
expression actually looks up become dependencies. A `helper` imported from `./model`
into an actions file is not one, so editing `model.ts` does not rediscover the actions
file. `tests/session.rs` asserts both: a body edit rediscovers exactly one file, and a
schema edit rediscovers the schema module and the three files that resolve schemas
from it.

### Why hand-rolled, not `salsa`

`salsa` was the obvious candidate: it is the incremental engine behind rust-analyzer,
with automatic dependency tracking and early cutoff. It loses here on fit:

- **The AST cannot be a query result.** Oxc's AST borrows from an arena allocator
  (`Program<'a>`). salsa memoizes owned values, so a `parse(file)` query could not
  return the AST; every downstream query would re-parse anyway, or the AST would have to
  be converted into an owned copy. The facts that *are* worth memoizing — discovered
  records, import lists, resolutions — are small owned values, exactly what a plain map
  stores.
- **The dependency graph is shallow and known.** Every fact depends on one file's
  contents; discovery adds the files its schema imports read; resolution adds the file
  set. Two levels, no recursion, no cycles. salsa's general machinery (revisions,
  durability, cycle handling) would be paying for generality this pipeline does not
  have.
- **Cost of the dependency.** salsa's API has changed substantially between releases
  (the 2022 rewrite and its successors), it brings proc macros and a database layer into
  a crate that is compiled for eight targets with cross toolchains, and its tracked
  structs would leak into every module that touches a query.

What salsa would have given for free is dependency tracking that cannot be forgotten.
The hand-rolled cache gets that guarantee from the differential test instead (below):
an invalidation rule that misses a dependency produces a session output that differs
from a clean check, and the test fails.

### Threads and the JS API

`new CompilerSession(input)` (napi class) keeps a `crates/aruna_compiler` session behind
a mutex. `check()` and `inspect()` are `AsyncTask`s: they run on the libuv thread pool
and resolve to the JSON output, so `aruna dev` and `build --watch` keep their event loop
— the fs watcher, the rojo child, the resident rbxtsc — while the compiler works.
`update(paths)` only queues paths (applied when the next run starts), so it never waits
on a run in progress. `dispose()` drops the caches.

`@arunajs/compiler` wraps it as `createCompilerSession(input, "check" | "build" |
"inspect")`, and `checkProject` / `buildProject` / `inspectProject` are single-use
sessions. The watch loop shared by `aruna dev` and `aruna build --watch` holds one
session for its lifetime, feeds it the changed paths each pass, and starts a new one when
`aruna.config.*` or a `tsconfig*.json` changes (both are read once, into the session's
input).

## Correctness guard

`crates/aruna_compiler/tests/session.rs` applies random edit sequences to a generated
project: files added, removed, and renamed; whole domain directories removed; imports
added, removed, and pointed at a module that does not exist yet (then created); action,
signal, and store definitions rewritten, duplicated, and broken; schema modules edited
under the definitions that import them; files given a parse error. After every step the
session's output must equal a clean `inspect_project` of the same tree, compared as JSON
strings. `cargo test` runs eight fixed seeds × 40 steps and one random seed (printed;
`ARUNA_SESSION_SEED=<seed>` reproduces it). It runs in CI's `rust` job.
