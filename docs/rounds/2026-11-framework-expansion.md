# 2026-11 round: stabilization and expansion

Branch `feat/framework-expansion` (from `prerelease/v1-formats` at c9d92c9). One commit per
phase. User-facing changes are in `packages/aruna/CHANGELOG.md` and
[migration-2026-11.md](../migration-2026-11.md); this file records the inventory the work
started from, what each phase did and verified, and what is left.

## Baseline (before any change)

| Suite | Result |
| --- | --- |
| `cargo test --locked --all-targets` | 144 passed (compiler lib 93, compiler integration 39, session 4, migrate 8) |
| vitest | aruna 321, compiler 162, create-aruna-app 14 |
| Lune (`apps/roblox-runtime-test`) | 207 Luau specs + 355 TypeScript specs |
| rbxts-harness specs | 5 |
| ARCANUM `aruna check` | 122 modules, 413 imports, no errors |
| One-shot `aruna build`, ARCANUM | ~5.0 s cold or warm (rbxtsc ~4.6 s of it), peak RSS ~550 MB |

## Feature inventory

| Requested | Found | Classification |
| --- | --- | --- |
| `strict.sharedSafety` | Parsed; reported `aruna::109` "not enforced" when false | Not implemented |
| Type-only imports across boundaries | Treated as runtime imports (`import type` from server in shared = `aruna::303`) | Implemented with defects (false positives) |
| Inputless action stubs | `(input: unknown)` required | Implemented, incomplete |
| `Signals` type | Documented, not generated | Implemented with defects (docs/output mismatch) |
| `SignalPublisher` export | Internal only | Not implemented (publicly) |
| `conventions.test` | Implemented in config, compiler, CLI; README omitted it | Sufficient (doc gap) |
| Resources | Item kind 4 reserved; nothing else | Not implemented |
| Multiplayer test network | `createTestServerApp` (one server, per-player clients, batching, step) | Incomplete (no faults, no virtual clock for timeouts) |
| Multiple player stores | One `playerStore` per app | Not implemented |
| Store readiness states | `get`/`waitFor` only | Incomplete; `waitFor` re-locked released players, `releaseAll` skipped in-flight loads, a synchronous load stayed "in flight", snapshots described the post-claim record |
| Migration test utilities | Memory backend only | Incomplete |
| Network metrics, rejection hook | `onAbuse`, `onError` | Incomplete (no metrics, no unified rejection view) |
| Incremental compile | Compiler session with differential test | Sufficient for the compiler; one-shot builds always cold in rbxtsc and rewrote every generated file |
| create-app starter | `create-aruna-app` since 0.2.0 | Implemented with defects: no Lune pin, no `test` script, the scaffolded spec failed |

## Phases

### A — shared safety (f9507e4)

Type-only import analysis in the parser (syntactic `type`, plus bindings never read as a
value); runtime boundary rules skip such edges; `aruna::306`/`307` transitive chains via one
reverse BFS per side; `aruna::308`/`309` server-only services at load / unguarded in a
function, with `IsServer`/`IsClient` guard recognition; `aruna::109` retired. Tests: parser
units, 9 integration tests, a `shared-safety` fixture + golden, config pass-through. No new
reports on ARCANUM, draw-a-tower, troll-tower, or either harness. Limits documented in
`packages/aruna/docs/shared-safety.md`.

### B — API consistency (0fc4eb3)

`input?` for inputless/optional-input stubs (and `ActionStub`, `invokeAction`,
`ClientApp.invoke`); `export type Signals = typeof signals`; `SignalPublisher` /
`SignalSubscriber` public on `aruna/server`, `aruna/client`, `aruna/roblox`. Tests: codegen
units, roblox type tests (including `@ts-expect-error` for required inputs), a Lune spec
for both call forms and the empty payload, goldens.

### C — resources (a85a4a8)

RFC first (`docs/rfcs/resources.md`), then the runtime (`resource.ts`), wire kinds 4/5,
`WireOutbox.replace`, admission through the request budget, the `resource` compiler
primitive (`aruna::586`–`590`), codegen for `$aruna/resources/{client,server}`, manifest,
contract snapshot/hash/diff, `inspect resources`, tsconfig aliases. 18 Lune specs (one
caught a departed player still receiving a late load before release), Rust units and
integration tests, a build fixture + golden.

### D — test network (ac3c327)

`createTestNetwork`: real server and clients over simulated links, virtual clock, per
direction faults that keep Roblox's guarantees apart, disconnect/reconnect, request
timeouts on the virtual clock (the invoker takes a `delay`). 16 Lune specs covering the
twelve required scenarios except the persistence one, which is in E.

### E — persistence (3d818f2)

`playerStores`, `ctx.stores`, `requireStores`, `onStoresReady`, `PlayerStore.status`,
`app.stores`, `describeStoreError`, `createTestStoreBackend`; four store defects fixed
(above). 13 Lune specs, including the network scenario "a failed load never overwrites
saved data".

### F — observability (84c79ac)

`createNetworkMetrics` (bounded, payload-free), `DispatchObserver`, `onReject`, a wire
frame observer, `aruna inspect network`. 8 Lune specs including an overhead benchmark:
3000 in-process dispatches, 117 ms off vs 152 ms on (~12 µs per dispatch).

### G — build performance (df1bd0b)

`--timings`; the compiler and the build no longer rewrite unchanged files; one-shot builds
keep an incremental rbxtsc stage in the OS temp dir. ARCANUM warm builds 5.0 s → 2.5–3.6 s,
every scenario byte-identical to `--no-cache` (`pnpm verify:incremental-build`). A first
attempt staged under `node_modules/.cache`: TypeScript treated the stage as library code
and failed on `rootDir` under a symlinked `node_modules`, and it wrote into a shared
`node_modules` — moved to the temp dir. Session differential test extended to resources.

### H — developer experience (5ef74ee)

Starter fixed and verified end to end (`pnpm verify:starter`); `add domain` scaffolds a
signal and `--with resource`; build summary counts every primitive; the rbxts harness
gains a resource/signal/inputless-action example with a multiplayer spec; migration
guide, starter contract, architecture, CLI, testing, stores docs.

### Consumer validation (bb203a0)

The packed-tarball smoke exercises resources, `Signals`, `SignalPublisher`, and an
inputless stub and compiles to Luau. ARCANUM (a copy; the checkout is not a git repo and
was not modified): builds to Luau and passes its 160 specs and `tsc` on the new packages,
before and after migrating its quest-progress handshake to a resource
(`arcanum-quests-resource.patch`, applies cleanly; not applied).

### Review fixes

An independent review of the new runtime code (resources, stores, outbox) reported twelve
defects; each was checked against the code and fixed, with a regression spec where it is
behaviour (8 Lune specs, each failing without its fix): `onResourceError`/`refine` throws
wedging a key, a lost global invalidation, a cached global value dropped as stale by a
client that had seen it or a Forbidden revision, a refused resync staying subscribed,
client `dispose` not unsubscribing, a throwing `onLoadFailed` leaving a load in flight
and `onStoresReady` unfired, failures recorded for released players, store names in the
`requireStores` refusal. Also: `invalidate` iterates a copy, the outbox `replace` is
indexed, and the RFC states the `replace` ordering, the no-timeout load, and resync cost.
Lune: 421 TypeScript specs.

## Left for later

- A resource `load` that never settles holds its key (documented; no load timeout).
- Synchronous resource resyncs are not coalesced; they are bounded by the request budget.

- Resource patches (deltas) instead of whole snapshots; global-resource fan-out per frame
  for very large audiences.
- Network metrics are per Luau VM; there is no built-in dev command or Studio panel that
  prints them.
- `aruna inspect network` shows the runtime defaults for the request budget; an app's
  `requestBudget` override is not visible to the compiler.
- Shared safety does not follow packages, dynamic loads, or service names held in
  variables (documented).
- The incremental build cache is not size-managed; it lives in the OS temp dir.
