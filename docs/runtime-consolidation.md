# Runtime consolidation (Stage 0, Part A)

Status: **done — the Node runtime is retired.** Sections 1–5 and the decision gate are
the A1 audit, written 2026-10-27 against `fix/stabilization` at `9c61fdd`, before any
code changed; they describe the package as it was. [Decision](#decision) and
[What A2 did](#what-a2-did) record the outcome, and the [appendix](#appendix-every-deleted-vitest-case-and-what-replaces-it)
maps every deleted vitest case to the spec that replaces it.

Aruna implements its runtime twice:

- the **Node runtime** — `packages/aruna/src/{runtime,app,actions,signals,stores,runtimes,schema,testing}`
  plus the five barrels `src/{server,client,roblox,schema,testing}.ts`, compiled by
  `tsconfig.json` into `dist/` and validated by vitest;
- the **native runtime** — `packages/aruna/roblox/*.ts`, roblox-ts source shipped in the
  package's `files`, vendored into a consumer's `<generatedDir>/shared/runtime/` by
  `aruna build`, and executed under Lune by `apps/roblox-runtime-test` and
  `aruna test`.

The CLI (`src/cli/**`, `src/cli.ts`, `src/format.ts`, `src/theme.ts`) lives in the same
package and the same `dist/`, but is a third, separate body of code.

## 1. Who imports the Node runtime

"Node runtime" below means any module under `src/` other than the CLI files listed above.

### Build-time and tooling code

| Importer | Imports the Node runtime? | Notes |
| --- | --- | --- |
| CLI (`src/cli/**`, `src/cli.ts`) | **No.** | Every import is `node:*`, `@arunajs/core`, `@arunajs/compiler`, a sibling CLI file, or a third-party package. The `aruna/*` strings in `add.ts`, `init.ts`, `doctor.ts` and `test-run.ts` are template text written into consumer files, not imports. Schema rendering (`format-action-schema.ts`, `action-contracts.ts`, `contract-diff.ts`) works on the compiler's JSON metadata, not on runtime `Schema` objects. |
| Config loading (`packages/compiler/src/config.ts`) | **No.** | `aruna.config.ts` is transpiled and run in a `vm` sandbox; `isArunaConfigSpecifier` intercepts `aruna`, `aruna/config`, `@arunajs/aruna` and `@arunajs/aruna/config` and hands back an identity `defineConfig`. The package's `dist/index.js` is never loaded. `defineConfig` itself lives in `@arunajs/core`. |
| `@arunajs/compiler`, `@arunajs/core` | No. | Neither depends on `@arunajs/aruna`. Mentions in `packages/compiler/test/*` are config specifiers in fixture text. |
| `create-aruna-app` | No. | Depends on `commander` + `picocolors` only; `scaffold.ts` writes `import … from "aruna"` as template text. |
| `scripts/release.ts` | Packages it. | Stages `dist/` (CLI **and** Node runtime) per `package.json#files`. |
| `scripts/verify-package-consumption.ts` | No (packs it). | Generates consumer sources that import `aruna/{server,client,roblox,schema}`, then runs `aruna doctor --fix` (vendored aliases), `tsc`, and `rbxtsc`. Every check runs against the vendored native runtime. |

### Published entry points

| Entry | `types` | `import` (JS) | Node runtime involved |
| --- | --- | --- | --- |
| `aruna` (root) | `dist/index.d.ts` | `dist/index.js` | **Yes — partly.** `defineConfig` and the config/manifest types come from `@arunajs/core`, `buildProject`/`checkProject`/`inspectProject` from `@arunajs/compiler`, but `encodeBinary`, `decodeBinary` and `schemaFingerprint` are re-exported from `src/runtime/binary.ts`. |
| `aruna/server` | `server.d.ts` → `dist/server.d.ts` | `server.js` → `dist/server.js` | Yes, entirely. |
| `aruna/client` | `client.d.ts` → `dist/client.d.ts` | `client.js` → `dist/client.js` | Yes, entirely. |
| `aruna/roblox` | `roblox.d.ts` → `dist/roblox.d.ts` | `roblox.js` → `dist/roblox.js` | Yes, entirely. |
| `aruna/schema` | `schema.d.ts` → `dist/schema.d.ts` | `schema.js` → `dist/schema.js` | Yes, entirely. |
| `aruna/testing` | `testing.d.ts` → `dist/testing.d.ts` | `testing.js` → `dist/testing.js` | Yes, entirely. |

The root shims (`packages/aruna/{server,client,roblox,schema,testing}.{ts,js,d.ts}`) are
one-line `export * from "./dist/<name>.js"` files compiled by `tsconfig.shims.json`.

### Tests

See section 3. Twenty vitest files import the Node runtime directly
(`../src/runtime/*`, `../src/{server,client,roblox,schema,testing}.js`, `../src/app/*`);
`public-exports.test.ts` imports the compiled root shims; `public-subpaths.test.ts` and
`roblox-import.test.ts` load `dist/` and the shims at run time; `export-parity.test.ts`
reads both runtimes' barrels with the TypeScript checker; `test/type-tests.ts` is
type-checked against the Node runtime (`tsconfig.type-tests.json`).

### Apps and real consumers

| Consumer | How `aruna/*` resolves |
| --- | --- |
| `apps/package-consumption-harness` | Vendored aliases (`aruna build`); `tsc` and `rbxtsc` both see native source. |
| `apps/rbxts-harness` | Vendored aliases; `"build": "aruna build"`, `"test": "aruna test"` (Lune). |
| `apps/roblox-runtime-test` | Compiles `packages/aruna/roblox/*` directly with `rbxtsc`, runs `lune/specs/*.luau`. Never touches `src/`. |
| `create-aruna-app` template | Vendored aliases installed by the first `aruna build`/`doctor --fix`. |
| `~/…/rojo/draw-a-tower`, `~/…/rojo/troll-tower` (dogfooding) | Vendored aliases in `tsconfig.json#paths`; `aruna.config.ts` is excluded from the rbxts program. Neither imports `encodeBinary`/`decodeBinary` or runs anything Aruna under Node. |

## 2. What a consumer resolves, per context

| Context | `aruna/server`, `client`, `roblox`, `schema`, `testing` | `aruna` (root) | Where types come from |
| --- | --- | --- | --- |
| **rbxtsc with doctor aliases** (the supported game build) | `tsconfig` `paths` → `<generatedDir>/shared/runtime/<name>.ts` (vendored native source). `ARUNA_RUNTIME_MODULES` in `src/cli/tsconfig-paths.ts` lists all five. | Not aliased. Only `aruna.config.ts` imports it, and consumers exclude that file from the rbxts program. | Native source. |
| **tsc / editor with doctor aliases** | Same as above. | `node_modules/@arunajs/aruna/dist/index.d.ts`. | Native source (root: Node runtime's `Schema` in the codec signatures). |
| **tsc / editor without aliases** (before the first `aruna build`/`doctor --fix`, or a tsconfig that drops the generated fragment) | `package.json#exports` → shim `.d.ts` → `dist/<name>.d.ts`. | Same. | **Node runtime declarations.** These differ from the native ones (below). Generated files (`actions.client.generated.ts` imports `aruna/client`) inherit the same split. |
| **rbxtsc without aliases** | Fails: roblox-ts rejects imports of non-`@rbxts` `node_modules` packages (docs/package-consumption.md). | Same. | — |
| **Node tooling** (node/tsx/vitest importing the package) | `import` condition → `dist/<name>.js`: **the Node runtime executes.** | `dist/index.js`, including the Node codec. | Node runtime declarations. |
| **The Aruna CLI itself** | Never imports them. | Never imports it (config loader intercepts the specifier). | — |

How far the two declaration sets drift today (exported names per barrel, computed with
the same checker setup `export-parity.test.ts` uses):

| Subpath | Node | Native | Shared | Node-only | Native-only |
| --- | --- | --- | --- | --- | --- |
| `aruna/server` | 114 | 97 | 85 | 29 | 12 |
| `aruna/client` | 24 | 24 | 24 | 0 | 0 |
| `aruna/roblox` | 48 | 23 | 15 | 33 | 8 |
| `aruna/schema` | 46 | 12 | 10 | 36 | 2 |
| `aruna/testing` | 25 | 26 | 25 | 0 | 1 |

Notable mismatches a consumer can hit by switching contexts: the run context is
`ActionRunContext` on Node and `ActionContext` natively; Node exports error **classes**
(`ActionValidationError`, `ActionNotFoundError`, `ActionRateLimitError`,
`ActionSerializationError`, `ActionInternalError`, `SchemaValidationError`,
`TimeoutError`) where the native runtime throws `name`-tagged values; `aruna/schema`
exports the per-kind schema interfaces (`StringSchema`, `ObjectSchema`, …),
`validateSchema` and `assertSchema` on Node only; `defineStore`/`definePlayerStore` and
`robloxDataStore` are on `aruna/roblox` natively but not on Node.
`export-parity.test.ts` pins only a hand-written subset of names, so none of this fails a
test. Code that type-checks in an editor without aliases can therefore fail `rbxtsc`, and
the reverse.

## 3. vitest suites: runtime behavior vs tooling

### Runtime behavior — would move to Lune under (a)

`it(` counts exclude `.each` expansions.

| Suite | Cases | Subject | Existing Lune spec |
| --- | --- | --- | --- |
| `remote-event-runtime.test.ts` | 52 | action transport, timeouts, handshake, wire safety | `transport.luau` (20) |
| `binary.test.ts` | 31 | binary codec | `binary.luau` (21) |
| `schema.test.ts` | 30 | schema DSL, constraints, refine, unions | `schema.luau` (24) |
| `store.test.ts` | 29 | DataStore core, versions, errors | `store.luau` (16) |
| `player-store.test.ts` | 19 | session-locked player document | `store.luau` (partial) |
| `runtime.test.ts` | 18 | dispatch, in-memory invoker | `dispatch.luau` (19) |
| `app.test.ts` | 17 | `createServerApp` / `createClientApp` | `server-app.luau` (11) |
| `remote-signal-runtime.test.ts` | 16 | signal publisher/subscriber | `signal.luau` (11) |
| `rate-limit.test.ts` | 16 | fixed-window limiter, keys | `rate-limit.luau` (6) |
| `testing-harness.test.ts` | 12 | `createTestServerApp` | `testing.luau` (19, shared with framework) |
| `testing-framework.test.ts` | 12 | `describe`/`it`/`expect` | `testing.luau` |
| `signal-app.test.ts` | 9 | app-owned publisher, `ctx.publisher` | `signal.luau` (partial) |
| `serialization.test.ts` | 7 | `plain-data-v1` policy | `serialization.luau` (10) |
| `request-guard.test.ts` | 7 | request budget | none |
| `middleware-app.test.ts` | 7 | action middleware | none |
| `idempotency.test.ts` | 7 | idempotent retries | none |
| `player-store-app.test.ts` | 5 | player store wired through the app | none |
| `default-rate-limit-app.test.ts` | 4 | `actions.defaultRateLimit` fallback | none |
| `binary-signals.test.ts` | 4 | `wire: "binary"` signals | none |
| `conformance.test.ts` | 1 (table-driven, 32 rows in `dispatch.json`) | dispatch conformance table | `conformance.luau` already runs the same table |
| **Total** | **303** (+ table) | | **157** Lune cases (+ table) |

Per-case overlap has not been established; a case-by-case mapping is the first step of
the migration and is required before any vitest case is deleted.

### Packaging and parity scaffolding — rewritten or deleted under (a)

| Suite | Why it exists | Fate under (a) |
| --- | --- | --- |
| `export-parity.test.ts` | Pins a contract subset present in both runtimes. | Deleted: one runtime. Replaced by the API report (Part D) over the native declarations. |
| `public-exports.test.ts` | Root shims export the runtime values. | Rewritten to assert the shims are types-only and resolve to native declarations. |
| `public-subpaths.test.ts` | `dist/` runtime entries have no CLI/Node-builtin imports. | Rewritten for the types-only subpaths, or deleted. |
| `roblox-import.test.ts` | `aruna/roblox` can be imported in Node. | Deleted — that guarantee is what (a) removes. |
| `test/type-tests.ts` (+ `tsconfig.type-tests.json`) | Type-level tests against the Node runtime. | Merged into `test/roblox-type-tests.ts` (native, already exists). |

### Tooling — stay in vitest under every option

`add`, `cli`, `contract-diff`, `dev`, `doctor`, `init`, `inspect-contract`,
`owned-artifacts`, `rbxtsc`, `rojo-layout`, `rojo-node-modules`, `rojo-project`,
`signal-discovery`, `spawn`, `store-discovery`, `test-run`, `tsconfig-paths`,
`verify-package-consumption`, `watch`. (`signal-discovery` and `store-discovery` mention
`aruna/server`/`aruna/schema` only inside fixture source handed to the compiler.)

## 4. What only the Node runtime can do

1. **The binary codec in Node.** `encodeBinary`, `decodeBinary` and `schemaFingerprint`
   are exported from the root `aruna` entry and documented there in the README ("Binary
   serialization"). The native runtime has the codec (`roblox/binary.ts`) but no public
   subpath exports it, and a roblox-ts project cannot import the root entry. Encoding or
   decoding an Aruna frame outside Roblox (a Node service, a replay tool, a test fixture
   generator) is only possible through the Node runtime.
2. **Running Aruna on a non-Roblox transport.** `RemoteEventServerLike` /
   `RemoteEventClientLike` / `RemoteSignal*Like` are structural; any event emitter can
   carry actions and signals. `createRemoteEventActionInvoker`,
   `createRemoteSignalPublisher`/`Subscriber` and the in-memory invoker
   (`src/runtime/memory.ts`, internal) build on that.
3. **Being imported in Node at all.** `roblox-import.test.ts` pins that `aruna/roblox`
   loads without Roblox globals. Every subpath currently has a working `import`
   condition.
4. **Standard JS error semantics.** `instanceof ActionValidationError` etc., `cause` on
   `ActionInternalError`. Natively these are `name`-tagged values.
5. **Low-level public helpers** with no native export: `dispatchAction`,
   `createActionRateLimiter`, `defaultActionRateLimitKeyResolver`,
   `validateSerializableActionValue`/`assertSerializableActionValue`, `validateSchema`,
   `assertSchema`, `NUMBER_FORMAT_RANGES`.
6. **Types usable with the standard lib.** The Node declarations need no `@rbxts/types`;
   the native ones reference `Player`, `Instance`, `RBXScriptConnection`, `buffer`, etc.

Nothing in this list is needed by the CLI, the compiler, `defineConfig`, the generated
code, or `aruna test`.

## 5. Recommendation

**(a) Retire the Node runtime** — conditional on the decision gate below.

(b) is worse than it looks: if the subpaths' types come from the native runtime (Part A's
requirement) while their `import` condition still points at a frozen Node runtime, Node
users get JavaScript that does not match its declarations. (b) only pays off if a Node
codec or Node transport must stay supported, and then the honest shape is a separate,
explicitly Node-only entry (for example `aruna/node`), not a frozen copy behind the
Roblox subpaths. (c) keeps paying for every primitive twice, which is what Stage 0 exists
to stop.

### Migration steps for (a)

1. **Map coverage first.** For each of the 303 runtime vitest cases, find the Lune case
   that covers it or write one (`apps/roblox-runtime-test/lune/specs/`). Record the mapping
   as an appendix to this document. No vitest case is deleted before its row exists.
2. **Make Lune mandatory where it counts.** `scripts/run-runtime-tests.ts` skips execution
   when Lune is missing; with (a) that would make `pnpm test` pass with zero behavioral
   coverage. Fail instead when `CI` is set (CI already installs Lune), and keep the local
   skip loud.
3. **Conformance table goes Lune-only.** Delete `conformance.test.ts`; keep
   `packages/aruna/test/conformance/` (or move it next to the Lune specs) and update its
   README.
4. **Close the native export gaps that are part of the documented contract** — decide per
   name in the section 2 diff whether it is added natively (e.g. the per-kind schema
   types) or dropped (e.g. the structural transport types). Expose the codec natively
   (`aruna/schema` or `aruna/roblox`) if it stays public.
5. **Ship native declarations.** Emit `.d.ts` from `roblox/*.ts` with
   `tsconfig.roblox.json` (`declaration`, `emitDeclarationOnly`) into e.g.
   `dist/roblox-types/`, point each subpath's `types` at it, and drop the subpaths'
   `import` condition (a roblox-ts project never loads it). The declarations reference
   `@rbxts/types` globals, which every supported consumer already has; declare the
   expected versions as optional `peerDependencies`. Verify with
   `pnpm verify:package-consumption`, adding a check that a consumer *without* aliases
   type-checks against the same declarations as one with them.
6. **Root entry keeps config and compiler only**: `defineConfig`, the core types,
   `buildProject`/`checkProject`/`inspectProject`. The codec leaves the root.
7. **Delete** `src/{runtime,app,actions,signals,stores,runtimes,schema,testing}/`,
   `src/{server,client,roblox,schema,testing}.ts`, `src/roblox-types.d.ts` if nothing in
   the CLI still needs it, `export-parity.test.ts`, `roblox-import.test.ts`,
   `type-tests.ts` + `tsconfig.type-tests.json`; rewrite the shims as types-only.
8. **Docs**: README (codec section, the Node-runtime mentions), `packages/aruna/docs/architecture.md`
   ("The dual runtime"), `docs/spec-alignment.md`, `docs/package-consumption.md`,
   `packages/aruna/llms.txt`, and the conformance README.
9. **CHANGELOG** `[Unreleased]` with the breaking changes below and migration notes.

### Breaking changes under (a)

- `aruna/server`, `aruna/client`, `aruna/roblox`, `aruna/schema`, `aruna/testing` can no
  longer be imported from Node JavaScript; they are type-only outside a roblox-ts build.
- `encodeBinary`, `decodeBinary`, `schemaFingerprint` leave the root `aruna` entry.
- Node-only exports disappear: 29 names from `aruna/server`, 33 from `aruna/roblox`,
  36 from `aruna/schema` (section 2), unless step 4 adds them natively. The ones a game
  is most likely to touch: `ActionRunContext` (→ `ActionContext`), the error classes
  (→ compare `err.name`), `validateSchema`/`assertSchema`, `TimeoutError`.
- `instanceof` checks against Aruna error classes stop compiling. (They never worked
  in-game.)
- Editors without the doctor aliases switch from Node declarations to native ones; a
  project that type-checked only because of the Node declarations will now report the
  errors `rbxtsc` already reported.

## Decision gate

The gate stops Part A after this audit if published consumers depend on Node runtime
**behavior at run time**, or if retiring it would break `defineConfig` or the CLI.

- `defineConfig` and the CLI: **not affected.** The CLI imports nothing from the Node
  runtime, `defineConfig` lives in `@arunajs/core`, and the config loader never loads the
  package's `dist/index.js`.
- Known consumers (both in-repo harnesses, the `create-aruna-app` template, draw-a-tower,
  troll-tower): **none execute the Node runtime.** All resolve `aruna/*` to the vendored
  native runtime.
- **But the published package documents and guarantees Node run-time behavior**:
  the README tells users to `import { encodeBinary, decodeBinary } from "aruna"`, which can
  only run under Node (section 4.1), every subpath ships a working `import` condition, and
  `roblox-import.test.ts` pins Node-importability of `aruna/roblox`. Whether anyone outside
  the known consumers relies on that cannot be determined from this repository.

That last point meets the gate's condition as written, so Part A stops here pending a
decision: retire with those removals listed as breaking changes ((a)), or keep a Node
codec behind an explicitly Node-only entry and retire the rest ((a) plus a small
`aruna/node`).

## Decision

The user chose (a): retire the Node runtime, and drop `encodeBinary`, `decodeBinary`, and
`schemaFingerprint` from the root entry as a documented breaking change. No `aruna/node`
entry.

## What A2 did

**Behavioral coverage moved to Lune.** `apps/roblox-runtime-test` now runs two kinds of
spec against the compiled native runtime:

- the hand-written Luau specs in `lune/specs/` (unchanged, plus two cases the port
  showed were missing: a real `DateTime` validating in `schema.luau`, and a real
  `Instance` hitting the store's "is a Roblox Instance" branch in `store.luau`), and
- TypeScript specs in `src/test/*.spec.ts`, ported from the Node runtime's vitest
  suites. They import the runtime the way a game does (`aruna/server`, `aruna/testing`,
  …, plus `aruna/internal/<module>` for internals), use the `describe`/`it`/`expect`
  `aruna/testing` ships, and run through `packages/aruna/lune/run.luau` — the runner
  `aruna test` ships — so the port also exercises the consumer test path.

Each run builds a throwaway rbxts project in a temp directory (the runtime staged at
`src/shared/aruna/runtime`, the specs at `src/test`), so concurrent runs cannot
collide. A missing Lune now fails the run under `CI`; locally it still skips, loudly.

The port was case by case, keeping every `describe`/`it` name, and every case is in the
appendix. Where the two runtimes disagreed, the spec asserts the native behavior — what
games already ran — so no game changes behavior; each such assertion carries a comment
saying what the Node runtime did. The disagreements:

| Area | Node runtime | Native runtime (kept) | Source (`packages/aruna/roblox/`) |
| --- | --- | --- | --- |
| testing: test names | `suite › test` | `suite > test` | testing-framework.ts:119 |
| testing: `toBeFalsy` | JS truthiness (`""`, `0` falsy) | Luau truthiness (only nil/false falsy) | testing-framework.ts:377 |
| testing: `deepEquals` | non-plain prototypes never equal | tables compared structurally, metatables ignored | testing-framework.ts:301 |
| rate limit rejection | `actionId`, `max`, `windowMs`, `retryAfterMs`, `resetAtMs` | `retryAfterMs`, `resetAtMs` only (+ `errorId` via app) | server-runtime.ts:263, server-app.ts:344 |
| serialization rejection | `actionId`, `role` | name + message only | server-runtime.ts:223 |
| limiter success result | `{ ok, remaining }` | `{ ok }` | rate-limit.ts:73 |
| types: `app.actions` | the literal action map | erased `ActionMap<TPlayer>` | server-app.ts:39 |
| types: Node-only exports | `getActionRemote`/`ensureActionRemote`/`waitForActionRemote`, structural `RemoteEvent*Like`, error classes, `validateSchema` … | absent | — |
| store value violation | `NaN` | `nan` | store.ts:137 |
| schema issue wording | quoted literals/enum (`"sword"`), `expected record object`, `expected tuple of length 2, got 1`, `expected tuple array` | `expected literal sword`, `expected one of a \| b`, `expected record`, `expected a tuple of length 2` | schema.ts:739,780,805,829 |
| unknown discriminant | issue at `type` path | `expected type to match a known variant` at root | schema.ts:851 |
| `schema.enum([undefined, …])` | accepts undefined | rejects (Luau array cannot hold nil) | schema.ts:473 |
| wire-safety | per-violation path/reason, rejects class instances | boolean `isWireSafe`; class instances pass; boundary message `non-serializable action input` | serialization.ts:167, server-runtime.ts:226 |
| signal payload error | `… not serializable` | `non-serializable signal payload: <id>` | signal-runtime.ts:126 |
| timeout rejection | `actionId`, `timeoutMs` | name + message only | roblox.ts:282 |
| version-mismatch rejection | `expected`, `actual` | name + message only | roblox.ts:204 |
| fire-and-forget, FireServer throws | rejected promise | throws synchronously | roblox.ts:213 |
| exports | `ensureSignalRemote`/`waitForSignalRemote` | absent (internal) | roblox.ts |
| `invokeAction` with no invoker | rejected promise, `Aruna action invoker is not installed; cannot invoke "<id>"` | synchronous throw, `Aruna action runtime is not installed: <id>` | client-runtime.ts:346 |
| framework errors through dispatch | `actionId`, `role`, path-bearing messages, `cause` on masked errors | `{ name, message }` (+ `errorId`); original only reaches `onError` | server-runtime.ts:138,221,319,357; server-app.ts:344 |
| `ServerTransport` return | binding, cleanup function, or disposable | `{ disconnect }` or nothing | server-app.ts:356 |

Four native bugs surfaced along the way. They are left as they are (this stage
must not change behavior) and are follow-ups, not pinned by a spec:

- `createActionInvoker` never disconnects its `OnClientEvent` connection, and
  `createClientApp().dispose()` does not release it (`roblox/roblox.ts`, the
  `OnClientEvent.Connect` in `createActionInvoker`).
- When `FireServer` throws, the invoker leaves the request in its pending map.
- `ServerApp.dispose()` calls the transport binding's `disconnect` on every call.
- `runTests` in `aruna/testing` chains every case onto one promise; with the roblox-ts
  Promise a `.then` on a settled promise runs synchronously, so each consecutive
  synchronous case nests one level deeper, and a large enough suite in one process ends
  in a Luau "C stack overflow". The ported suite (301 cases) hit it, so the harness runs
  each spec file in its own Lune process; a game project's `aruna test` run can still hit
  it.

**The conformance table is Lune-only.** It moved to `apps/roblox-runtime-test/conformance/`
(with `binary-signals.json`); `conformance.test.ts` is deleted.

**Types come from the native runtime.** `tsconfig.native-types.json` emits declarations
from `roblox/*.ts` into `dist/native/`; the root shims (`server.d.ts`, …) are now tracked,
hand-written `export * from "./dist/native/<name>.js"` files, and each subpath's export
is `{ "types": … }` only. `pnpm verify:package-consumption` gained a step that type-checks
the packed consumer with the doctor's `aruna/*` aliases removed (so each subpath
resolves through the installed package), under both `Bundler` and `Node` resolution; it
passes. `test/public-subpaths.test.ts` checks that every subpath exposes exactly the
exports of the vendored source.

**Native gains** (moves, not new features): `encodeBinary`/`decodeBinary`/
`schemaFingerprint` on `aruna/schema` (the replacement for the root export),
`createRemoteSignalPublisher`/`createRemoteSignalSubscriber` on `aruna/roblox` (already
documented in docs/signals.md, never exported natively), and the `SignalMap` type on
`aruna/server` (named in docs/actions.md).

**Deleted**: `src/{runtime,app,actions,signals,stores,runtimes,schema,testing}/`,
`src/{server,client,roblox,schema,testing}.ts`, `src/roblox-types.d.ts` (it pulled the
rbxts globals into the CLI program), the compiled shim sources and
`tsconfig.shims.json`, the runtime vitest suites listed in section 3,
`export-parity.test.ts`, `roblox-import.test.ts`, `type-tests.ts` and
`tsconfig.type-tests.json`. `type-tests.ts`'s assertions moved to
`test/roblox-type-tests.ts`, against the native declarations, except two: the Node-only
transport types, and `app.actions` keeping the literal action map (native types it as
`ActionMap`; that test now pins the native type).

**Rewritten**: `public-exports.test.ts` (the root entry exports only config and compiler),
`public-subpaths.test.ts` (types-only subpaths, shims pointing at `dist/native`, export
parity with the vendored source).

**Differences from the recommendation in section 5**: the declarations land in
`dist/native/`, not `dist/roblox-types/`; no `peerDependencies` on `@rbxts/types` were
added (it would have changed the lockfile for every consumer, and every roblox-ts project
already has them); and the ported specs are TypeScript through the shipped runner rather
than Luau, so they read like the vitest cases they replace and exercise `aruna test`'s
runner as a side effect.

## Appendix: every deleted vitest case and what replaces it

One row per runtime-behavior vitest case deleted with the Node runtime. `src/test/…` paths are in `apps/roblox-runtime-test/`; `lune/specs/…` are its hand-written Luau specs.

Status counts: covered 20, divergence (native kept) 36, kept 1, ported 123, ported-adapted 122, retired 7 — 309 rows.

Statuses: **ported** — same assertion against the native runtime; **ported-adapted** — same behavior through the native API; **covered** — an existing Luau case asserts it (most were ported anyway); **divergence (native kept)** — the runtimes disagreed, and the spec asserts what games already ran; **retired** — Node-only API with no native counterpart; **kept** — still a vitest case.

| vitest case | Lune spec case | status | note |
|---|---|---|---|
| remote-event-runtime.test.ts › createRemoteEventActionInvoker › sends request envelopes with the action id and input | src/test/remote-event-runtime.spec.ts › createRemoteEventActionInvoker › sends request envelopes with the action id and input | ported-adapted | The server listener auto-answers inside FireServer. The envelope is asserted as the exact positional list (no 4th arg). |
| remote-event-runtime.test.ts › createRemoteEventActionInvoker › resolves matching ok responses | src/test/remote-event-runtime.spec.ts › createRemoteEventActionInvoker › resolves matching ok responses | ported-adapted | Positional envelope and response. |
| remote-event-runtime.test.ts › createRemoteEventActionInvoker › rejects matching error responses | src/test/remote-event-runtime.spec.ts › createRemoteEventActionInvoker › rejects matching error responses | ported-adapted | The wire error is `{ok:false,error,errorName}`. The rejection `{message:"boom",name:"CustomError"}` is asserted. |
| remote-event-runtime.test.ts › createRemoteEventActionInvoker › ignores responses for unknown request ids | src/test/remote-event-runtime.spec.ts › createRemoteEventActionInvoker › ignores responses for unknown request ids | ported | |
| remote-event-runtime.test.ts › createRemoteEventActionInvoker › removes the pending request when FireServer throws | src/test/remote-event-runtime.spec.ts › createRemoteEventActionInvoker › removes the pending request when FireServer throws | ported-adapted | A throwing OnServerEvent listener makes the fake FireServer raise "boom". The invoke rejects with "boom", and a late response raises nothing. Pending-entry leak: native roblox.ts:241 runs `pending.set` before FireServer and never deletes the entry when FireServer throws. You cannot observe the leak (the late resolve hits an already-rejected promise), but it is real. |
| remote-event-runtime.test.ts › createRemoteEventActionInvoker › dispose disconnects from the client response signal | — | retired | native createActionInvoker returns a bare function with no dispose; its OnClientEvent connection is never disconnected (listener leak, roblox.ts:185) — tracked as a follow-up bug, not ported because it would pin the leak |
| remote-event-runtime.test.ts › createRemoteEventActionInvoker › fire-and-forget resolves immediately without registering a pending request | src/test/remote-event-runtime.spec.ts › createRemoteEventActionInvoker › fire-and-forget resolves immediately without registering a pending request | ported-adapted | "No timer armed" is checked by waiting past a 20 ms timeout: nothing rejects. A late ack does not throw. |
| remote-event-runtime.test.ts › createRemoteEventActionInvoker › fire-and-forget rejects when FireServer throws | src/test/remote-event-runtime.spec.ts › createRemoteEventActionInvoker › fire-and-forget rejects when FireServer throws | divergence (native kept) | The spec asserts the native behavior: the invoke throws synchronously with "network down", because roblox.ts:213-216 calls FireServer outside any promise. The retired Node runtime returned a rejected promise. |
| remote-event-runtime.test.ts › createRemoteEventActionInvoker request timeout › arms the default 10s timer when requestTimeoutMs is omitted | src/test/remote-event-runtime.spec.ts › createRemoteEventActionInvoker request timeout › arms the default 10s timer when requestTimeoutMs is omitted | ported-adapted | A timer count cannot be observed. The spec asserts `DEFAULT_ACTION_REQUEST_TIMEOUT_MS == 10000`, that an answered call resolves, and that an unanswered call rejects with ActionTimeoutError "…10000ms" (real ~10 s wait). |
| remote-event-runtime.test.ts › createRemoteEventActionInvoker request timeout › does not arm a timer when requestTimeoutMs is 0 (explicit opt-out) | src/test/remote-event-runtime.spec.ts › createRemoteEventActionInvoker request timeout › does not arm a timer when requestTimeoutMs is 0 (explicit opt-out) | ported-adapted | The call is still pending after 10.2 s (past the default timeout), then resolves on response. This is a real ~10 s wait. |
| remote-event-runtime.test.ts › createRemoteEventActionInvoker request timeout › clears the timer and resolves when a response arrives | src/test/remote-event-runtime.spec.ts › createRemoteEventActionInvoker request timeout › clears the timer and resolves when a response arrives | ported-adapted | cancelCount cannot be observed. The spec asserts one resolve and zero rejects after waiting past the 30 ms timeout. |
| remote-event-runtime.test.ts › createRemoteEventActionInvoker request timeout › rejects with TimeoutError and clears the pending entry on timeout | src/test/remote-event-runtime.spec.ts › createRemoteEventActionInvoker request timeout › rejects with TimeoutError and clears the pending entry on timeout | divergence (native kept) | The spec asserts the exact native rejection `{message:"Aruna action shop.purchaseItem timed out after 30ms.", name:"ActionTimeoutError"}` (roblox.ts:282-285). The retired Node runtime also carried `actionId` and `timeoutMs` fields. A late response raises nothing. |
| remote-event-runtime.test.ts › createRemoteEventActionInvoker request timeout › clears pending timers when disposed | — | retired | native createActionInvoker returns a bare function with no dispose; its OnClientEvent connection is never disconnected (listener leak, roblox.ts:185) — tracked as a follow-up bug, not ported because it would pin the leak |
| remote-event-runtime.test.ts › createRemoteEventActionInvoker cancellation › cancelling before invoke rejects immediately without touching the wire | src/test/remote-event-runtime.spec.ts › createRemoteEventActionInvoker cancellation › cancelling before invoke rejects immediately without touching the wire | ported-adapted | `.name == "ActionCancelledError"`, and zero envelopes reach the server. "No timer armed" cannot be observed. |
| remote-event-runtime.test.ts › createRemoteEventActionInvoker cancellation › cancelling a pending invoke rejects, clears the timer, and drops late responses | src/test/remote-event-runtime.spec.ts › createRemoteEventActionInvoker cancellation › cancelling a pending invoke rejects, clears the timer, and drops late responses | ported-adapted | `isActionCancelledError`. Past the 30 ms timeout there is still exactly one rejection, and a late response does not resolve. |
| remote-event-runtime.test.ts › createRemoteEventActionInvoker cancellation › a normal response unsubscribes the cancel listener (later cancel is inert) | src/test/remote-event-runtime.spec.ts › createRemoteEventActionInvoker cancellation › a normal response unsubscribes the cancel listener (later cancel is inert) | ported | Also asserts that no rejection follows. |
| remote-event-runtime.test.ts › createRemoteEventActionInvoker cancellation › fire-and-forget ignores a cancelled signal (nothing to wait on) | src/test/remote-event-runtime.spec.ts › createRemoteEventActionInvoker cancellation › fire-and-forget ignores a cancelled signal (nothing to wait on) | ported | |
| remote-event-runtime.test.ts › client middleware › wraps the invoker outermost-first and can observe the result | src/test/remote-event-runtime.spec.ts › client middleware › wraps the invoker outermost-first and can observe the result | ported | Also covered by lune/specs/transport.luau › client middleware › wraps the invoker outermost-first and observes the result (same assertion, still ported). |
| remote-event-runtime.test.ts › client middleware › a layer that rejects without calling next short-circuits the invoker | src/test/remote-event-runtime.spec.ts › client middleware › a layer that rejects without calling next short-circuits the invoker | ported | Similar to lune/specs/transport.luau › client middleware › a layer that rejects short-circuits the invoker. |
| remote-event-runtime.test.ts › client middleware › a synchronous throw in a layer becomes a rejection | src/test/remote-event-runtime.spec.ts › client middleware › a synchronous throw in a layer becomes a rejection | ported | |
| remote-event-runtime.test.ts › client middleware › returns the invoker unchanged when there is no middleware | src/test/remote-event-runtime.spec.ts › client middleware › returns the invoker unchanged when there is no middleware | ported | |
| remote-event-runtime.test.ts › client middleware › createClientApp applies middleware to both invokeAction and app.invoke | src/test/remote-event-runtime.spec.ts › client middleware › createClientApp applies middleware to both invokeAction and app.invoke | ported | |
| remote-event-runtime.test.ts › client contract handshake › does nothing when the client and server hashes match | src/test/remote-event-runtime.spec.ts › client contract handshake › does nothing when the client and server hashes match | ported-adapted | `fetchServerContractHash` becomes the ArunaContractHash attribute set on the remote. Similar to lune/specs/transport.luau › client contract handshake › does nothing when the client and server hashes match. |
| remote-event-runtime.test.ts › client contract handshake › fires onVersionMismatch once but still invokes when warn-only | src/test/remote-event-runtime.spec.ts › client contract handshake › fires onVersionMismatch once but still invokes when warn-only | ported-adapted | Uses the attribute. Covered by lune/specs/transport.luau › client contract handshake › fires onVersionMismatch but still invokes when warn-only (same assertion, still ported). |
| remote-event-runtime.test.ts › client contract handshake › rejects every invoke with ActionVersionMismatchError when rejectOnMismatch | src/test/remote-event-runtime.spec.ts › client contract handshake › rejects every invoke with ActionVersionMismatchError when rejectOnMismatch | divergence (native kept) | The spec asserts the exact native rejection `{message:"Aruna contract mismatch: client client-hash vs server server-hash.", name:"ActionVersionMismatchError"}` (roblox.ts:204-207), and nothing reaches the wire. The retired Node runtime also carried `expected` and `actual` fields. |
| remote-event-runtime.test.ts › client contract handshake › treats a server advertising no hash as unknown, not a mismatch | src/test/remote-event-runtime.spec.ts › client contract handshake › treats a server advertising no hash as unknown, not a mismatch | ported-adapted | The attribute is cleared (nil). |
| remote-event-runtime.test.ts › client contract handshake › isActionVersionMismatchError detects the rejection from either runtime | src/test/remote-event-runtime.spec.ts › client contract handshake › isActionVersionMismatchError detects the rejection from either runtime | ported-adapted | There is no ActionVersionMismatchError class. The spec uses a real native rejection from a rejectOnMismatch invoker, plus a `{name}` table, plus negatives (a `{name:"Error"}` table and a string). |
| remote-event-runtime.test.ts › client retry › returns the invoker unchanged when retries are disabled | src/test/remote-event-runtime.spec.ts › client retry › returns the invoker unchanged when retries are disabled | ported | |
| remote-event-runtime.test.ts › client retry › retries a rate-limit rejection and honors retryAfterMs for backoff | src/test/remote-event-runtime.spec.ts › client retry › retries a rate-limit rejection and honors retryAfterMs for backoff | ported | Rejections are tagged tables instead of Errors. |
| remote-event-runtime.test.ts › client retry › uses exponential backoff for an idempotent call's timeouts and propagates after maxRetries | src/test/remote-event-runtime.spec.ts › client retry › uses exponential backoff for an idempotent call's timeouts and propagates after maxRetries | ported | |
| remote-event-runtime.test.ts › client retry › does not retry a timeout for a call that is not idempotent | src/test/remote-event-runtime.spec.ts › client retry › does not retry a timeout for a call that is not idempotent | ported | |
| remote-event-runtime.test.ts › client retry › sends one idempotency key with every attempt of a call | src/test/remote-event-runtime.spec.ts › client retry › sends one idempotency key with every attempt of a call | ported | A missing key is recorded as "<none>" to keep the array dense, so that case still fails the string check. |
| remote-event-runtime.test.ts › client retry › keeps a caller-supplied idempotency key | src/test/remote-event-runtime.spec.ts › client retry › keeps a caller-supplied idempotency key | ported | |
| remote-event-runtime.test.ts › client retry › lets a custom retryOn retry a timeout without idempotent | src/test/remote-event-runtime.spec.ts › client retry › lets a custom retryOn retry a timeout without idempotent | ported | |
| remote-event-runtime.test.ts › client retry › does not retry a non-retryable rejection | src/test/remote-event-runtime.spec.ts › client retry › does not retry a non-retryable rejection | ported | |
| remote-event-runtime.test.ts › client retry › never retries a cancellation | src/test/remote-event-runtime.spec.ts › client retry › never retries a cancellation | ported | |
| remote-event-runtime.test.ts › client retry › never retries a fire-and-forget invoke | src/test/remote-event-runtime.spec.ts › client retry › never retries a fire-and-forget invoke | ported | |
| remote-event-runtime.test.ts › client retry › honors a custom retryOn predicate | src/test/remote-event-runtime.spec.ts › client retry › honors a custom retryOn predicate | ported | |
| remote-event-runtime.test.ts › bindRemoteEventActions › dispatches an action and sends an ok response | src/test/remote-event-runtime.spec.ts › bindRemoteEventActions › dispatches an action and sends an ok response | ported-adapted | `bindActions` plus raw envelopes via `wireRemote`. The response is `(requestId, {ok,output})`. The targeted player cannot be observed (the Lune FireClient ignores it). |
| remote-event-runtime.test.ts › bindRemoteEventActions › runs a fire-and-forget action but sends no response | src/test/remote-event-runtime.spec.ts › bindRemoteEventActions › runs a fire-and-forget action but sends no response | ported-adapted | Same as above. |
| remote-event-runtime.test.ts › bindRemoteEventActions › sends no error response when a fire-and-forget action throws | src/test/remote-event-runtime.spec.ts › bindRemoteEventActions › sends no error response when a fire-and-forget action throws | ported-adapted | Also asserts that the action ran. |
| remote-event-runtime.test.ts › bindRemoteEventActions › sends an error response for an unknown action id | src/test/remote-event-runtime.spec.ts › bindRemoteEventActions › sends an error response for an unknown action id | ported-adapted | `{ok:false,error,errorName}` instead of `{error:{message,name}}`. The message and name are identical. |
| remote-event-runtime.test.ts › bindRemoteEventActions › turns input validation failures into error responses | src/test/remote-event-runtime.spec.ts › bindRemoteEventActions › turns input validation failures into error responses | ported-adapted | The message is the same, word for word. |
| remote-event-runtime.test.ts › bindRemoteEventActions › turns unsafe input into error responses | src/test/remote-event-runtime.spec.ts › bindRemoteEventActions › turns unsafe input into error responses | divergence (native kept) | The spec uses the same Instance-like input (a real Instance cannot be built under Lune) and asserts the native response `{ok:false, error:"non-serializable action input", errorName:"ActionSerializationError"}` (server-runtime.ts:226). The retired Node runtime's message named the path and reason ("Action shop.purchaseItem input is not serializable … $.player: Roblox Instance-like values cannot cross action boundaries"). |
| remote-event-runtime.test.ts › bindRemoteEventActions › turns output validation failures into error responses | src/test/remote-event-runtime.spec.ts › bindRemoteEventActions › turns output validation failures into error responses | ported-adapted | ActionInternalError "internal error". The errorId is checked as 8 lowercase hex characters. |
| remote-event-runtime.test.ts › bindRemoteEventActions › turns unsafe output into error responses | src/test/remote-event-runtime.spec.ts › bindRemoteEventActions › turns unsafe output into error responses | ported-adapted | Same as above. |
| remote-event-runtime.test.ts › bindRemoteEventActions › passes the player into a custom context factory | src/test/remote-event-runtime.spec.ts › bindRemoteEventActions › passes the player into a custom context factory | ported-adapted | There is no per-request `createContext` on the native side. The per-player factory is `createServerApp({ createSession })` (driven by a `players` source whose GetPlayers returns LocalPlayer). The spec asserts it was called with the player, and that the action sees `ctx.player` plus the factory result as `ctx.session`. |
| remote-event-runtime.test.ts › bindRemoteEventActions › drops a malformed request envelope without a response | src/test/remote-event-runtime.spec.ts › bindRemoteEventActions › drops a malformed request envelope without a response | ported | It covers the same 3 envelopes (non-string actionId, requestId of 65 characters, actionId of 129 characters). Overlaps lune/specs/transport.luau › RemoteEvent transport request budget › drops envelopes past the burst, and malformed ones, without a response. |
| remote-event-runtime.test.ts › bindRemoteEventActions › drops a request that has no usable requestId | src/test/remote-event-runtime.spec.ts › bindRemoteEventActions › drops a request that has no usable requestId | ported-adapted | A nil requestId, and an empty FireServer() in place of the `null` envelope. |
| remote-event-runtime.test.ts › bindRemoteEventActions › dispose disconnects from the server request signal | src/test/remote-event-runtime.spec.ts › bindRemoteEventActions › dispose disconnects from the server request signal | ported-adapted | The native name is `binding.disconnect()`, called twice. The listener count cannot be observed: the spec checks that an envelope gets a reply before disconnect and none after. |
| remote-event-runtime.test.ts › RemoteEvent round trip › connects generated-style client stubs, client and server apps, and validation | src/test/remote-event-runtime.spec.ts › RemoteEvent round trip › connects generated-style client stubs, client and server apps, and validation | ported-adapted | `createServerApp({transport: robloxRemoteEvent()})` plus `createClientApp({transport: createActionInvoker()})` plus `invokeAction`. playerName is LocalPlayer.Name. Overlaps lune/specs/transport.luau › RemoteEvent transport › completes a client -> server -> client round trip. |
| remote-event-runtime.test.ts › RemoteEvent round trip › resolves concurrent requests by request id | src/test/remote-event-runtime.spec.ts › RemoteEvent round trip › resolves concurrent requests by request id | ported | |
| binary.test.ts › binary codec round trips › round trips primitives | src/test/binary.spec.ts › binary codec round trips › round trips primitives | ported | Also asserted (with 3.5) by lune/specs/binary.luau › binary codec › round trips primitives. |
| binary.test.ts › binary codec round trips › round trips unicode strings | src/test/binary.spec.ts › binary codec round trips › round trips unicode strings | ported | Similar: lune/specs/binary.luau › binary codec › round trips utf-8 strings. |
| binary.test.ts › binary codec round trips › round trips literals without spending bytes | src/test/binary.spec.ts › binary codec round trips › round trips literals without spending bytes | ported | `.length` → `buffer.len`. Also lune/specs/binary.luau › binary codec › spends no payload bytes on literals. |
| binary.test.ts › binary codec round trips › round trips arrays | src/test/binary.spec.ts › binary codec round trips › round trips arrays | ported | Deep toEqual. |
| binary.test.ts › binary codec round trips › round trips objects with deterministic field order | src/test/binary.spec.ts › binary codec round trips › round trips objects with deterministic field order | ported | Byte equality compared via `buffer.tostring` (buffers are reference-compared). |
| binary.test.ts › binary codec round trips › round trips records with deterministic key order | src/test/binary.spec.ts › binary codec round trips › round trips records with deterministic key order | ported | Byte equality via `buffer.tostring`. Also lune/specs/binary.luau › binary codec › round trips records with deterministic key order. |
| binary.test.ts › binary codec round trips › round trips tuples as a fixed sequence without a length prefix | src/test/binary.spec.ts › binary codec round trips › round trips tuples as a fixed sequence without a length prefix | ported | 12-byte frame asserted. |
| binary.test.ts › binary codec round trips › round trips present and absent optionals | src/test/binary.spec.ts › binary codec round trips › round trips present and absent optionals | ported-adapted | `hasOwnProperty` → a `pairs` scan for the key (a Luau table cannot hold an own-but-nil key). |
| binary.test.ts › binary codec round trips › round trips enums by index | src/test/binary.spec.ts › binary codec round trips › round trips enums by index | ported | |
| binary.test.ts › binary codec round trips › round trips unions by member tag | src/test/binary.spec.ts › binary codec round trips › round trips unions by member tag | ported | |
| binary.test.ts › binary codec round trips › round trips a nested structure | src/test/binary.spec.ts › binary codec round trips › round trips a nested structure | ported | Deep toEqual incl. absent optional `title`. |
| binary.test.ts › binary codec round trips › drops repeated field names for struct arrays | src/test/binary.spec.ts › binary codec round trips › drops repeated field names for struct arrays | ported-adapted | 458 bytes asserted exactly; JSON size via `HttpService:JSONEncode(value):size()` (serde under Lune) instead of TextEncoder; `Array.from` → loop; `toBeLessThan` → `expect(a < b).toBe(true)` (no toBeLessThan matcher). |
| binary.test.ts › binary codec round trips › throws on an enum value outside the schema | src/test/binary.spec.ts › binary codec round trips › throws on an enum value outside the schema | ported | toThrow("not a member of the enum"). |
| binary.test.ts › binary codec round trips › throws when decoding past the end of the buffer | src/test/binary.spec.ts › binary codec round trips › throws when decoding past the end of the buffer | ported-adapted | `new Uint8Array([1,2])` → 2-byte `buffer`; `.subarray(0, 6)` → `buffer.copy` of the first 6 bytes. Also lune/specs/binary.luau › binary codec › errors on a truncated buffer instead of raw buffer access. |
| binary.test.ts › schema fingerprint framing › rejects a payload encoded with a different schema | src/test/binary.spec.ts › schema fingerprint framing › rejects a payload encoded with a different schema | ported | Also lune/specs/binary.luau › binary codec › rejects a payload encoded with a different schema. |
| binary.test.ts › schema fingerprint framing › is stable for equal layouts and sensitive to layout changes | src/test/binary.spec.ts › schema fingerprint framing › is stable for equal layouts and sensitive to layout changes | ported | |
| binary.test.ts › schema fingerprint framing › matches the pinned cross-runtime fingerprint | src/test/binary.spec.ts › schema fingerprint framing › matches the pinned cross-runtime fingerprint | ported | 2935581200. Same assertion as lune/specs/binary.luau › binary codec › computes the same fingerprint as the Node reference runtime. |
| binary.test.ts › numeric width hints › round trips each integer and float width | src/test/binary.spec.ts › numeric width hints › round trips each integer and float width | ported | Also lune/specs/binary.luau › binary codec › round trips each numeric width (minus the f64 row). |
| binary.test.ts › numeric width hints › packs each width to its declared byte count | src/test/binary.spec.ts › numeric width hints › packs each width to its declared byte count | ported | Same assertions as lune/specs/binary.luau › binary codec › packs each width to its declared byte count. |
| binary.test.ts › numeric width hints › shrinks a struct array when widths are tightened | src/test/binary.spec.ts › numeric width hints › shrinks a struct array when widths are tightened | ported | 808 / 158 bytes; `Array.from` → loop. |
| binary.test.ts › numeric width hints › validates integer width ranges and integrality | src/test/binary.spec.ts › numeric width hints › validates integer width ranges and integrality | ported-adapted | `validateSchema(s, v).ok` → `s.validate(v)` (native has no validateSchema). All 10 rows kept. |
| binary.test.ts › Roblox userdata kinds › round trips vector3/color3/cframe as f32 components | src/test/binary.spec.ts › Roblox userdata kinds › round trips vector3/color3/cframe as f32 components | ported-adapted | Native takes/returns Vector3/Color3/CFrame userdata, not `{x,y,z}`/`{r,g,b}`/`{components}`; asserts typeof + every component (CFrame via GetComponents vs the same 12-number list). |
| binary.test.ts › Roblox userdata kinds › packs each userdata kind to its declared byte count | src/test/binary.spec.ts › Roblox userdata kinds › packs each userdata kind to its declared byte count | ported-adapted | Userdata inputs; 4+12 / 4+12 / 4+48. |
| binary.test.ts › Roblox userdata kinds › validates userdata shapes | src/test/binary.spec.ts › Roblox userdata kinds › validates userdata shapes | ported-adapted | `.validate`; Node's "missing component"/"wrong component count" plain shapes → natively any non-Vector3 / non-CFrame value (the same plain shapes plus a wrong userdata kind) is rejected; a CFrame always has 12 components. |
| binary.test.ts › Roblox userdata kinds › round trips vector2/udim/udim2 | src/test/binary.spec.ts › Roblox userdata kinds › round trips vector2/udim/udim2 | ported-adapted | Vector2/UDim/UDim2 userdata in and out; every scale/offset asserted. |
| binary.test.ts › Roblox userdata kinds › packs each 2D userdata kind to its declared byte count | src/test/binary.spec.ts › Roblox userdata kinds › packs each 2D userdata kind to its declared byte count | ported-adapted | Userdata inputs; 4+8 / 4+8 / 4+16. |
| binary.test.ts › Roblox userdata kinds › validates 2D userdata shapes | src/test/binary.spec.ts › Roblox userdata kinds › validates 2D userdata shapes | ported-adapted | `.validate` with userdata; the Node partial shapes are rejected natively, plus a wrong userdata kind. |
| binary.test.ts › Roblox userdata kinds › round trips DateTime and BrickColor | src/test/binary.spec.ts › Roblox userdata kinds › round trips DateTime and BrickColor | ported-adapted | DateTime input/output is the spec runner's `DateTime.fromUnixTimestampMillis` fake (plain table; Lune cannot construct a DateTime), so this checks the f64 codec path, not the userdata type. BrickColor is real. |
| binary.test.ts › Roblox userdata kinds › packs DateTime (f64) and BrickColor (u16) to their byte counts | src/test/binary.spec.ts › Roblox userdata kinds › packs DateTime (f64) and BrickColor (u16) to their byte counts | ported-adapted | Same DateTime fake; 4+8 / 4+2. |
| binary.test.ts › Roblox userdata kinds › validates DateTime/BrickColor/Instance shapes | src/test/binary.spec.ts › Roblox userdata kinds › validates DateTime/BrickColor/Instance shapes | ported-adapted | PARTIAL. Ported: dateTime rejects `{}`, brickColor accepts a BrickColor, instance rejects `{}`; added: the Node "Instance-like shape" is rejected natively (validate is `typeof == "Instance"`). NOT portable in a compiled spec: the positive DateTime and Instance rows — no value with typeof "DateTime"/"Instance" is reachable from a TS spec under Lune (runner globals are plain-table fakes; `newproxy` `__type` is ignored by Luau `typeof`). Instance-positive is covered by lune/specs/schema.luau › … › validates BrickColor and Instance userdata; DateTime-positive is covered nowhere natively. |
| binary.test.ts › Roblox userdata kinds › refuses to binary-encode an Instance schema | src/test/binary.spec.ts › Roblox userdata kinds › refuses to binary-encode an Instance schema | ported-adapted | Input is the runner's `Instance.new("RemoteEvent")` instead of an Instance-like table; same message substring. Also lune/specs/binary.luau › binary codec › round trips BrickColor and refuses to encode an Instance. |
| binary-signals.test.ts › binary signal wire (Node) › an object packs its fields in sorted key order, with declared number widths | src/test/binary-signals.spec.ts › binary signal wire (Node) › an object packs its fields in sorted key order, with declared number widths | ported-adapted | One of the 3 rows of the vitest `for (table.cases)` loop. Case inlined (a compiled spec cannot read conformance/binary-signals.json); exact hex bytes, single send, decoded value asserted. Same table row runs in lune/specs/signal.luau › binary signal wire (native). |
| binary-signals.test.ts › binary signal wire (Node) › strings, booleans, optionals, and enums | src/test/binary-signals.spec.ts › binary signal wire (Node) › strings, booleans, optionals, and enums | ported-adapted | As above (table loop row 2). |
| binary-signals.test.ts › binary signal wire (Node) › arrays and unions | src/test/binary-signals.spec.ts › binary signal wire (Node) › arrays and unions | ported-adapted | As above (table loop row 3). |
| binary-signals.test.ts › binary signal wire (Node) › drops a frame encoded with another schema version, like a schema mismatch | src/test/binary-signals.spec.ts › binary signal wire (Node) › drops a frame encoded with another schema version, like a schema mismatch | ported | Native createRemoteSignalPublisher/Subscriber over the same structural loopback. Also part of lune/specs/signal.luau › binary signal wire (native) › drops a frame encoded with another schema version, and a non-buffer payload. |
| binary-signals.test.ts › binary signal wire (Node) › drops a payload that is not a frame at all | src/test/binary-signals.spec.ts › binary signal wire (Node) › drops a payload that is not a frame at all | ported-adapted | `new Uint8Array([1,2])` → 2-byte `buffer`; added `sent` length 2 so the drop is proven to happen on delivery. |
| binary-signals.test.ts › binary signal wire (Node) › still validates before encoding | src/test/binary-signals.spec.ts › binary signal wire (Node) › still validates before encoding | ported | `{ hp: 300 }` on u8 throws; nothing sent. |
| schema.test.ts › schema runtime › validates strings | src/test/schema.spec.ts › schema runtime › validates strings | ported-adapted | `validateSchema` → `{ ok: s.validate(v), issue: firstSchemaIssue(s, v) }`; issue rendered as `"<path>: <message>"`. Also lune/specs/schema.luau › schema › validates primitives (validate only, no message). |
| schema.test.ts › schema runtime › validates finite numbers | src/test/schema.spec.ts › schema runtime › validates finite numbers | ported-adapted | NaN → `0/0`, +Infinity → `math.huge`. Overlaps lune/specs/schema.luau › schema › rejects NaN and infinities for every number format. |
| schema.test.ts › schema runtime › validates booleans | src/test/schema.spec.ts › schema runtime › validates booleans | ported-adapted | same helper |
| schema.test.ts › schema runtime › matches literal values exactly | src/test/schema.spec.ts › schema runtime › matches literal values exactly | divergence (native kept) | (a) `schema.enum([undefined, "ready"])` rejects undefined natively (issue `expected one of ready`); a Luau array cannot hold nil (Node: ok). (b) `literal("sword")` vs "shield" issue is `expected literal sword`, Node `expected literal "sword"`. `literal(undefined)` passes. |
| schema.test.ts › schema runtime › accepts any matching union member | src/test/schema.spec.ts › schema runtime › accepts any matching union member | ported-adapted | same message |
| schema.test.ts › schema runtime › validates arrays item-by-item | src/test/schema.spec.ts › schema runtime › validates arrays item-by-item | ported-adapted | path `["[1]"]` → `"[1]: expected string"` |
| schema.test.ts › schema runtime › validates object properties recursively | src/test/schema.spec.ts › schema runtime › validates object properties recursively | ported-adapted | path `["payload","itemId"]` → `"payload.itemId: …"` |
| schema.test.ts › schema runtime › validates record values against the value schema | src/test/schema.spec.ts › schema runtime › validates record values against the value schema | divergence (native kept) | non-table: native `expected record`, Node `expected record object`. Other assertions pass. |
| schema.test.ts › schema runtime › validates tuples positionally with exact length | src/test/schema.spec.ts › schema runtime › validates tuples positionally with exact length | divergence (native kept) | short tuple: native `expected a tuple of length 2`, Node `expected tuple of length 2, got 1`. Keyed table `{0:…,1:…}`: native `expected a tuple of length 2` (validate false), Node `expected tuple array`. |
| schema.test.ts › schema runtime › allows undefined for optional schemas | src/test/schema.spec.ts › schema runtime › allows undefined for optional schemas | ported-adapted | same helper |
| schema.test.ts › schema runtime › validates enum values | src/test/schema.spec.ts › schema runtime › validates enum values | divergence (native kept) | native `expected one of small \| medium \| large`, Node `expected one of "small", "medium", "large"` |
| schema.test.ts › schema runtime › throws a stable validation error | src/test/schema.spec.ts › schema runtime › throws a stable validation error | ported-adapted | No native `assertSchema`/`SchemaValidationError`. Ported to the action boundary via `createTestServerApp().invoke`: name `ActionValidationError`, message `Aruna action shop.purchaseItem input validation failed: expected string` (actionId, role, issue in the message rather than as fields). |
| schema.test.ts › schema constraints and refinements › enforces number min/max/int | src/test/schema.spec.ts › schema constraints and refinements › enforces number min/max/int | ported-adapted | Overlaps lune/specs/schema.luau › schema › enforces number constraints via chaining (validate only) |
| schema.test.ts › schema constraints and refinements › enforces string length constraints | src/test/schema.spec.ts › schema constraints and refinements › enforces string length constraints | ported-adapted | Overlaps lune/specs/schema.luau › schema › enforces string length constraints |
| schema.test.ts › schema constraints and refinements › counts maxLength / minLength / length in UTF-8 bytes, as the native runtime does | src/test/schema.spec.ts › schema constraints and refinements › counts maxLength / minLength / length in UTF-8 bytes, as the native runtime does | ported-adapted | Overlaps lune/specs/schema.luau › schema › counts maxLength / minLength / length in UTF-8 bytes (that one skips the `length(3)` false case) |
| schema.test.ts › schema constraints and refinements › counts maxChars / minChars in code points | src/test/schema.spec.ts › schema constraints and refinements › counts maxChars / minChars in code points | covered | Same assertions as lune/specs/schema.luau › schema › counts maxChars / minChars in code points; still ported |
| schema.test.ts › schema constraints and refinements › fails maxChars / minChars on a string with no UTF-8 form | src/test/schema.spec.ts › schema constraints and refinements › fails maxChars / minChars on a string with no UTF-8 form | ported-adapted | Lone UTF-16 surrogates → invalid UTF-8 bytes (`string.char(0xff)`, `string.char(0xc3)`); the surrogate pair stays (it compiles to a valid 4-byte 😀). Overlaps lune/specs/schema.luau › schema › fails maxChars / minChars on invalid UTF-8 |
| schema.test.ts › schema constraints and refinements › enforces array length constraints | src/test/schema.spec.ts › schema constraints and refinements › enforces array length constraints | ported-adapted | Overlaps lune/specs/schema.luau › schema › enforces array length constraints |
| schema.test.ts › schema constraints and refinements › runs a custom .refine predicate after the structural check | src/test/schema.spec.ts › schema constraints and refinements › runs a custom .refine predicate after the structural check | ported-adapted | Overlaps lune/specs/schema.luau › schema › runs a custom refine predicate after the structural check (validate only) |
| schema.test.ts › schema constraints and refinements › reports constraint failures at the nested path | src/test/schema.spec.ts › schema constraints and refinements › reports constraint failures at the nested path | ported-adapted | `"name: expected length >= 2 bytes"` |
| schema.test.ts › schema constraints and refinements › keeps chained refinements immutable across branches | src/test/schema.spec.ts › schema constraints and refinements › keeps chained refinements immutable across branches | ported-adapted | Overlaps lune/specs/schema.luau › schema › keeps chained refinements immutable across branches (validate only) |
| schema.test.ts › discriminated union › accepts a value matching the selected member | src/test/schema.spec.ts › discriminated union › accepts a value matching the selected member | ported-adapted | Overlaps lune/specs/schema.luau › schema › dispatches a discriminated union on its discriminant |
| schema.test.ts › discriminated union › dispatches on the discriminant and reports the member's own field error | src/test/schema.spec.ts › discriminated union › dispatches on the discriminant and reports the member's own field error | covered | lune/specs/schema.luau › schema › reports the discriminated member's field via firstSchemaIssue asserts the same issue (single-member union there); still ported |
| schema.test.ts › discriminated union › reports an unknown discriminant at the discriminant path | src/test/schema.spec.ts › discriminated union › reports an unknown discriminant at the discriminant path | divergence (native kept) | native issue `expected type to match a known variant` at the root; Node `type: expected one of "move", "chat"` (path `["type"]`) |
| schema.test.ts › discriminated union › infers the union of its members | src/test/schema.spec.ts › discriminated union › infers the union of its members | ported | compile-time `Infer` check (rbxtsc) + runtime validate |
| schema.test.ts › default values › fills an absent defaulted field, keeping present ones | src/test/schema.spec.ts › default values › fills an absent defaulted field, keeping present ones | ported | Overlaps lune/specs/schema.luau › schema › fills defaults via applyDefaults and validates absent defaulted fields (field-by-field) |
| schema.test.ts › default values › returns the input unchanged when nothing is filled (no clone) | src/test/schema.spec.ts › default values › returns the input unchanged when nothing is filled (no clone) | ported | identity via `toBe` |
| schema.test.ts › default values › treats an absent defaulted field as valid (the default supplies it) | src/test/schema.spec.ts › default values › treats an absent defaulted field as valid (the default supplies it) | ported-adapted | same helper; overlaps the luau defaults case |
| schema.test.ts › default values › fills nested defaults inside arrays of objects | src/test/schema.spec.ts › default values › fills nested defaults inside arrays of objects | ported | |
| schema.test.ts › default values › infers a defaulted field as present for the handler | src/test/schema.spec.ts › default values › infers a defaulted field as present for the handler | ported | compile-time `Infer` check |
| serialization.test.ts › serialization policy › accepts wire-safe primitive and plain data values | src/test/serialization.spec.ts › serialization policy › accepts wire-safe primitive and plain data values | ported-adapted | `validateSerializableActionValue(v)` `{ok:true}` → `isWireSafe(v) === true`. Overlaps lune/specs/serialization.luau › serialization (plain-data-v1) › accepts wire-safe primitives / accepts nested plain tables and arrays |
| serialization.test.ts › serialization policy › rejects null, functions, non-finite numbers, and unsupported objects | src/test/serialization.spec.ts › serialization policy › rejects null, functions, non-finite numbers, and unsupported objects | divergence (native kept) | Native accepts a class instance; the spec asserts `isWireSafe(new Demo())` is true (Node rejected it as non-plain, because the walk ignores the metatable). Not ported: `null` (no Luau form; nil is undefined and allowed) and `new Date()` (no JS Date; DateTime is an accepted wire type). Per-violation path/reason/valueKind not available (boolean API; see "reports stable nested paths"). Functions, NaN, ±inf, Instance-like table all rejected. |
| serialization.test.ts › serialization policy › reports stable nested paths | src/test/serialization.spec.ts › serialization policy › reports stable nested paths | divergence (native kept) | `null` → a function at the same path. `isWireSafe` false; no path is reported anywhere. The spec asserts the boundary message `non-serializable action input` (Node's violation carried `$.items[0].id.value`). |
| serialization.test.ts › serialization policy › rejects cyclic objects | src/test/serialization.spec.ts › serialization policy › rejects cyclic objects | ported-adapted | `isWireSafe` false + dispatch rejects with ActionSerializationError. Node's `$.self` / `cyclic reference` detail has no native form (same gap as "reports stable nested paths"). Overlaps lune/specs/serialization.luau › serialization (plain-data-v1) › rejects cyclic tables |
| serialization.test.ts › serialization policy › rejects values that exceed the configured depth | src/test/serialization.spec.ts › serialization policy › rejects values that exceed the configured depth | ported-adapted | Native depth is fixed at 32 (no `maxDepth` option): 32 levels pass, 33 fail. Overlaps lune/specs/serialization.luau › serialization (plain-data-v1) › rejects tables nested past the depth limit (40 levels, false only) |
| serialization.test.ts › serialization policy › stops collecting violations after the configured limit | src/test/serialization.spec.ts › serialization policy › stops collecting violations after the configured limit | retired | Node-only: a violation list capped by `maxViolations`. The native walk collects no violations and stops at the first unsafe value. The spec keeps only the verdict (three bad fields → false). |
| serialization.test.ts › serialization policy › throws a readable ActionSerializationError | src/test/serialization.spec.ts › serialization policy › throws a readable ActionSerializationError | divergence (native kept) | No native `assertSerializableActionValue`; ported to the action boundary. The name `ActionSerializationError` matches; the spec asserts the native message `non-serializable action input`. Node: `Action shop.purchaseItem input is not serializable across the Aruna action boundary. $.player: Roblox Instance-like values cannot cross action boundaries` (and `actionId` / `role` fields). |
| store.test.ts › store keys and values › rejects keys the DataStore would reject | src/test/store.spec.ts › store keys and values › rejects keys the DataStore would reject | ported | `"a".repeat(51)` → `"a".rep(51)` |
| store.test.ts › store keys and values › rejects values a DataStore cannot encode | src/test/store.spec.ts › store keys and values › rejects values a DataStore cannot encode | divergence (native kept) | Native message is canonical: the spec asserts `"coins is nan, which DataStores cannot encode"` (contains `"nan"`, Luau `tostring`, roblox/store.ts:137); the retired Node runtime printed `"NaN"`. Structural Instance `{ IsA, ClassName }`: not an Instance natively (`typeIs(value, "Instance")`, store.ts:139), so the port asserts the table is still refused (violation defined, names `part`); the real-Instance "Roblox Instance" branch is covered by `lune/specs/store.luau › … › names a real Instance` (added by the lead), since a real Instance cannot be built from a roblox-ts spec under Lune. |
| store.test.ts › store keys and values › accepts a value shared by two paths but rejects a cycle | src/test/store.spec.ts › store keys and values › accepts a value shared by two paths but rejects a cycle | ported | |
| store.test.ts › store keys and values › refuses to encode a value that does not match the schema | src/test/store.spec.ts › store keys and values › refuses to encode a value that does not match the schema | ported | |
| store.test.ts › decoding › returns the default for a key that was never written | src/test/store.spec.ts › decoding › returns the default for a key that was never written | ported | decode-level (`existed` flag); store-level overlap in lune/specs/store.luau › store persistence › returns the default for a key that was never written |
| store.test.ts › decoding › calls a default factory per read so mutable defaults are not shared | src/test/store.spec.ts › decoding › calls a default factory per read so mutable defaults are not shared | ported | added a precondition that both decodes succeeded |
| store.test.ts › decoding › fails rather than resetting when the stored value is corrupt | src/test/store.spec.ts › decoding › fails rather than resetting when the stored value is corrupt | ported | store-level overlap in lune/specs/store.luau › store persistence › fails instead of resetting when the stored record is corrupt |
| store.test.ts › decoding › fails when a record is older than the store and no migrate is declared | src/test/store.spec.ts › decoding › fails when a record is older than the store and no migrate is declared | ported | |
| store.test.ts › decoding › refuses a record from a newer version without calling migrate | src/test/store.spec.ts › decoding › refuses a record from a newer version without calling migrate | ported-adapted | `toMatchObject({ name, retryable })` → separate `toBe` on `error.name` and `error.retryable` (no toMatchObject in aruna/testing) |
| store.test.ts › decoding › never writes back over a record from a newer version | src/test/store.spec.ts › decoding › never writes back over a record from a newer version | covered | also lune/specs/store.luau › store persistence › refuses a record from a newer version without migrating or writing it (via the DataStore adapter); ported anyway against the memory backend |
| store.test.ts › decoding › migrates an older record forward | src/test/store.spec.ts › decoding › migrates an older record forward | ported | |
| store.test.ts › decoding › treats a raw pre-Aruna value as version 0 and migrates it | src/test/store.spec.ts › decoding › treats a raw pre-Aruna value as version 0 and migrates it | ported | |
| store.test.ts › decoding › fails when migrate cannot handle the record | src/test/store.spec.ts › decoding › fails when migrate cannot handle the record | ported | |
| store.test.ts › decoding › fails when migrate throws instead of letting the throw escape | src/test/store.spec.ts › decoding › fails when migrate throws instead of letting the throw escape | ported-adapted | `throw new Error("bad migration")` → `throw "bad migration"` (no Error class); same message assertion |
| store.test.ts › request policy › retries a transient failure and then succeeds | src/test/store.spec.ts › request policy › retries a transient failure and then succeeds | ported | in-spec `failingBackend` + immediate scheduler, same as vitest; overlap lune/specs/store.luau › store persistence › retries a transient DataStore failure |
| store.test.ts › request policy › does not retry a permanent failure | src/test/store.spec.ts › request policy › does not retry a permanent failure | covered | also lune/specs/store.luau › store persistence › does not retry a place without API access; ported anyway (this one also asserts `retryable: false`) |
| store.test.ts › request policy › gives up after the attempt budget and reports the failure | src/test/store.spec.ts › request policy › gives up after the attempt budget and reports the failure | ported | |
| store.test.ts › request policy › waits out an exhausted request budget instead of spending the request | src/test/store.spec.ts › request policy › waits out an exhausted request budget instead of spending the request | ported | |
| store.test.ts › request policy › reports a failure once through onError | src/test/store.spec.ts › request policy › reports a failure once through onError | ported | |
| store.test.ts › request policy › grows the backoff and keeps it under the cap | src/test/store.spec.ts › request policy › grows the backoff and keeps it under the cap | ported | |
| store.test.ts › request policy › keeps jittered delays inside the band around the capped delay | src/test/store.spec.ts › request policy › keeps jittered delays inside the band around the capped delay | ported-adapted | `toBeCloseTo(150, 3)` → `math.abs(x - 150) < 0.0005` (vitest's precision-3 tolerance) |
| store.test.ts › request policy › surfaces a non-retryable classification without spending attempts | src/test/store.spec.ts › request policy › surfaces a non-retryable classification without spending attempts | ported | |
| store.test.ts › writes › round-trips a value through a versioned envelope | src/test/store.spec.ts › writes › round-trips a value through a versioned envelope | covered | also lune/specs/store.luau › store persistence › round-trips a value through a versioned envelope; ported anyway |
| store.test.ts › writes › refuses a write that does not match the schema and leaves the record alone | src/test/store.spec.ts › writes › refuses a write that does not match the schema and leaves the record alone | ported | overlap lune/specs/store.luau › store persistence › refuses a value that does not match the schema (does not check the record is left alone) |
| store.test.ts › writes › refuses a write larger than the DataStore value limit | src/test/store.spec.ts › writes › refuses a write larger than the DataStore value limit | ported | `"x".repeat` → `"x".rep` |
| store.test.ts › writes › updates read-modify-write against the stored value | src/test/store.spec.ts › writes › updates read-modify-write against the stored value | ported | |
| store.test.ts › writes › refuses to write over a record it could not decode | src/test/store.spec.ts › writes › refuses to write over a record it could not decode | ported | |
| store.test.ts › writes › carries an existing session lock through a save | src/test/store.spec.ts › writes › carries an existing session lock through a save | ported | |
| store.test.ts › writes › removes a key | src/test/store.spec.ts › writes › removes a key | ported | |
| player-store.test.ts › session locking › acquires the lock as part of the load | src/test/player-store.spec.ts › session locking › acquires the lock as part of the load | covered | also lune/specs/store.luau › session locking › writes the lock as part of the load; ported anyway |
| player-store.test.ts › session locking › refuses a second server while the lock is live | src/test/player-store.spec.ts › session locking › refuses a second server while the lock is live | covered | also lune/specs/store.luau › session locking › refuses a second server while the lock is live; ported anyway |
| player-store.test.ts › session locking › takes over a lock whose heartbeat went stale | src/test/player-store.spec.ts › session locking › takes over a lock whose heartbeat went stale | covered | also lune/specs/store.luau › session locking › takes over a lock whose heartbeat went stale; ported anyway |
| player-store.test.ts › session locking › clears the lock on release so the next server loads immediately | src/test/player-store.spec.ts › session locking › clears the lock on release so the next server loads immediately | ported | overlap lune/specs/store.luau › session locking › flushes and clears the lock on release (does not load from a second server) |
| player-store.test.ts › session locking › reports a failed load instead of handing out a default document | src/test/player-store.spec.ts › session locking › reports a failed load instead of handing out a default document | ported | |
| player-store.test.ts › session locking › treats a record from a newer version as a failed load: no default, no lock, no write | src/test/player-store.spec.ts › session locking › treats a record from a newer version as a failed load: no default, no lock, no write | covered | also lune/specs/store.luau › session locking › treats a record from a newer version as a failed load and writes no lock; ported anyway |
| player-store.test.ts › session locking › returns the same document for a repeated load | src/test/player-store.spec.ts › session locking › returns the same document for a repeated load | ported | added precondition that both loads succeeded |
| player-store.test.ts › session locking › derives the key from the player and honours a custom key | src/test/player-store.spec.ts › session locking › derives the key from the player and honours a custom key | ported | `Object.keys(snapshot)` → iterate the snapshot Map |
| player-store.test.ts › documents › stages changes and flushes them on save | src/test/player-store.spec.ts › documents › stages changes and flushes them on save | ported | |
| player-store.test.ts › documents › rejects an invalid change without mutating the document | src/test/player-store.spec.ts › documents › rejects an invalid change without mutating the document | ported | |
| player-store.test.ts › documents › closes the document on release so a late write cannot resurrect it | src/test/player-store.spec.ts › documents › closes the document on release so a late write cannot resurrect it | covered | also lune/specs/store.luau › session locking › rejects a write through a released document; ported anyway |
| player-store.test.ts › documents › refuses to write once another server has taken the lock | src/test/player-store.spec.ts › documents › refuses to write once another server has taken the lock | covered | also lune/specs/store.luau › session locking › refuses to write once another server has taken the lock; ported anyway |
| player-store.test.ts › documents › skips the write when nothing changed | src/test/player-store.spec.ts › documents › skips the write when nothing changed | ported | |
| player-store.test.ts › heartbeat › refreshes the lock and flushes pending changes on every tick | src/test/player-store.spec.ts › heartbeat › refreshes the lock and flushes pending changes on every tick | covered | also lune/specs/store.luau › session locking › refreshes the lock and flushes on a heartbeat tick; ported anyway (this one also asserts the next interval is re-armed) |
| player-store.test.ts › heartbeat › refreshes the lock even when the document is unchanged | src/test/player-store.spec.ts › heartbeat › refreshes the lock even when the document is unchanged | ported | |
| player-store.test.ts › heartbeat › stops the heartbeat once the document is released | src/test/player-store.spec.ts › heartbeat › stops the heartbeat once the document is released | ported | |
| player-store.test.ts › shutdown › flushes every held document on saveAll | src/test/player-store.spec.ts › shutdown › flushes every held document on saveAll | ported | added `results.size() === 2` so `every` cannot pass vacuously |
| player-store.test.ts › shutdown › releases every lock on releaseAll | src/test/player-store.spec.ts › shutdown › releases every lock on releaseAll | ported | added a precondition that both locks are held before releaseAll |
| player-store.test.ts › shutdown › releases a player who left while the load was still in flight | src/test/player-store.spec.ts › shutdown › releases a player who left while the load was still in flight | ported-adapted | the native memory backend settles UpdateAsync synchronously, so the load would never be in flight; an in-spec `gatedBackend` holds the locked read until after `release` is called (asserted: `store.get(player)` undefined at that point), then opens. Same assertions plus "the record was written". |
| player-store-app.test.ts › createServerApp with a player store › loads the document on join and exposes it as ctx.store | src/test/player-store-app.spec.ts › createServerApp with a player store › loads the document on join and exposes it as ctx.store | ported | native `createServerApp({ players })` takes the same injected PlayersSource; `defineAction` from aruna/server typed with FakePlayer; app disposed at the end |
| player-store-app.test.ts › createServerApp with a player store › leaves ctx.store undefined for an action that beats the load | src/test/player-store-app.spec.ts › createServerApp with a player store › leaves ctx.store undefined for an action that beats the load | ported-adapted | the in-memory load can settle inside the join handler natively, so an in-spec `gatedBackend` holds the locked read until after the dispatch; `undefined` in `seen` recorded as a `MISSING` marker (nil cannot sit in a Luau array) |
| player-store-app.test.ts › createServerApp with a player store › flushes and releases the lock when the player leaves | src/test/player-store-app.spec.ts › createServerApp with a player store › flushes and releases the lock when the player leaves | ported | `setTimeout(0)` → `waitUntil(lock cleared)` |
| player-store-app.test.ts › createServerApp with a player store › refuses a record from a newer version and lets the game kick from onLoadFailed | src/test/player-store-app.spec.ts › createServerApp with a player store › refuses a record from a newer version and lets the game kick from onLoadFailed | ported | `undefined` in `seen` → `MISSING` marker |
| player-store-app.test.ts › createServerApp with a player store › exposes the store on the app for shutdown flushing | src/test/player-store-app.spec.ts › createServerApp with a player store › exposes the store on the app for shutdown flushing | ported | added `results.size() === 1` so `every` cannot pass vacuously |
| runtime.test.ts › client runtime › fails clearly when no invoker is installed | src/test/runtime.spec.ts › client runtime › fails clearly when no invoker is installed | divergence (native kept) | A: asserts a synchronous throw of `Aruna action runtime is not installed: shop.purchaseItem` |
| runtime.test.ts › client runtime › calls the installed invoker | src/test/runtime.spec.ts › client runtime › calls the installed invoker | ported | |
| runtime.test.ts › client runtime › clears the installed invoker | src/test/runtime.spec.ts › client runtime › clears the installed invoker | divergence (native kept) | A: asserts a synchronous throw of `Aruna action runtime is not installed: shop.purchaseItem` |
| runtime.test.ts › server runtime › dispatches a sync action and returns its result | src/test/runtime.spec.ts › server runtime › dispatches a sync action and returns its result | ported-adapted | `dispatchAction(registry, …)` has no native export. Uses `createServerApp({ actions }).dispatch` through a local `dispatchAction` helper (one app per call, inert players source) |
| runtime.test.ts › server runtime › dispatches an async action and returns its result | src/test/runtime.spec.ts › server runtime › dispatches an async action and returns its result | ported-adapted | Same helper. Overlaps lune/specs/dispatch.luau › server dispatch › awaits a Promise returned by run |
| runtime.test.ts › server runtime › fails clearly for an unknown action id | src/test/runtime.spec.ts › server runtime › fails clearly for an unknown action id | ported-adapted | Same helper. Overlaps dispatch.luau › server dispatch › resolves with an error payload for unknown actions |
| runtime.test.ts › server runtime › validates input before running the action | src/test/runtime.spec.ts › server runtime › validates input before running the action | ported-adapted | Same helper. `vi.fn` replaced by a run counter |
| runtime.test.ts › server runtime › rejects unsafe input before running the action | src/test/runtime.spec.ts › server runtime › rejects unsafe input before running the action | divergence (native kept) | B: asserts the rejection equals `{ name: "ActionSerializationError", message: "non-serializable action input" }` and that run was not called. The Instance-like table is refused because it holds a function; a real Instance cannot be built in a TS spec under Lune |
| runtime.test.ts › server runtime › validates output after the action resolves | src/test/runtime.spec.ts › server runtime › validates output after the action resolves | divergence (native kept) | C: asserts an `ActionInternalError` rejection, onError getting `ActionValidationError` with the exact message, and `rejection.cause` nil |
| runtime.test.ts › server runtime › rethrows an output failure as is when internal errors are exposed | src/test/runtime.spec.ts › server runtime › rethrows an output failure as is when internal errors are exposed | ported-adapted | `exposeInternalErrors` is a `createServerApp` option, not a dispatch option |
| runtime.test.ts › server runtime › rejects unsafe output after the action resolves | src/test/runtime.spec.ts › server runtime › rejects unsafe output after the action resolves | divergence (native kept) | B + C: asserts the masked rejection (`internal error`), run called once, and onError getting `{ name: "ActionSerializationError", message: "non-serializable action output" }` with no `actionId`/`role`. `rejection.cause` is nil |
| runtime.test.ts › server runtime › passes output that matches the output schema | src/test/runtime.spec.ts › server runtime › passes output that matches the output schema | covered | lune/specs/dispatch.luau › server dispatch › passes output that matches the output schema (same assertion at the registry level). Also ported through app.dispatch |
| runtime.test.ts › server runtime › routes an output schema failure through middleware and onError | src/test/runtime.spec.ts › server runtime › routes an output schema failure through middleware and onError | divergence (native kept) | B + C: asserts the masked rejection, onError `(error, { actionId, player, errorId })` with the rejection's errorId, and middleware seeing the same error object. Also asserts the error has no `actionId`/`role` and the rejection has no `cause`. `instanceof SchemaValidationError` has no native class hierarchy, so the name is checked instead. Overlaps dispatch.luau › server dispatch › routes an output schema failure through middleware and onError |
| runtime.test.ts › server runtime › includes the action id and role on validation errors | src/test/runtime.spec.ts › server runtime › includes the action id and role on validation errors | divergence (native kept) | B: asserts the rejection equals `{ name: "ActionValidationError", message: "Aruna action shop.purchaseItem input validation failed: itemId: expected string" }` |
| runtime.test.ts › in-memory transport › connects client invocation to the server registry | src/test/runtime.spec.ts › in-memory transport › connects client invocation to the server registry | ported-adapted | `createInMemoryActionInvoker` replaced by `createTestServerApp(...).client(player)`, which installs the global invoker |
| runtime.test.ts › in-memory transport › surfaces validation errors | src/test/runtime.spec.ts › in-memory transport › surfaces validation errors | ported-adapted | harness `client(player)` |
| runtime.test.ts › in-memory transport › surfaces serialization policy errors | src/test/runtime.spec.ts › in-memory transport › surfaces serialization policy errors | divergence (native kept) | B: asserts the rejection equals `{ name: "ActionSerializationError", message: "non-serializable action input" }` (harness `client(player)` path) |
| runtime.test.ts › generated-style stubs › can call through the in-memory invoker | src/test/runtime.spec.ts › generated-style stubs › can call through the in-memory invoker | ported-adapted | harness `client(player)` |
| app.test.ts › createClientApp › installs an invoker used by invokeAction | src/test/app.spec.ts › createClientApp › installs an invoker used by invokeAction | ported | |
| app.test.ts › createClientApp › clears the invoker when disposed | src/test/app.spec.ts › createClientApp › clears the invoker when disposed | divergence (native kept) | A: asserts a synchronous throw of `Aruna action runtime is not installed: shop.purchaseItem` |
| app.test.ts › createClientApp › can be disposed twice safely | src/test/app.spec.ts › createClientApp › can be disposed twice safely | divergence (native kept) | A: asserts a synchronous throw of `Aruna action runtime is not installed: shop.purchaseItem`. The double dispose is safe (client.ts:135 guard) |
| app.test.ts › createServerApp › exposes the action registry | src/test/app.spec.ts › createServerApp › exposes the action registry | covered | lune/specs/server-app.luau › server app › exposes the action map it was created with (same identity check). Also ported |
| app.test.ts › createServerApp › dispatch validates input and calls the action through dispatchAction | src/test/app.spec.ts › createServerApp › dispatch validates input and calls the action through dispatchAction | ported-adapted | ctx `{}` becomes `{ player: "tester" }`: the native dispatch ctx requires a player, because the in-flight cap is a Map keyed on it |
| app.test.ts › createServerApp › accepts a transport that returns nothing | src/test/app.spec.ts › createServerApp › accepts a transport that returns nothing | ported-adapted | Cast past the native `ServerTransport` type, which asks for `{ disconnect }`. Behavior matches: called once, double dispose is safe |
| app.test.ts › createServerApp › accepts a transport that returns a cleanup function | — (removed) | retired | D: native `ServerTransport` returns only `{ disconnect }`; a bare cleanup function was Node-only API (natively, `app.dispose()` errors with `attempt to index function with 'disconnect'`, server-app.ts:357) |
| app.test.ts › createServerApp › accepts a transport that returns a disposable object | — (removed) | retired | D: native `ServerTransport` returns only `{ disconnect }`; a `{ dispose }` object was Node-only API (natively, `app.dispose()` errors with `attempt to call a nil value`, server-app.ts:357) |
| app.test.ts › createServerApp › owns the PlayerRemoving connection for per-player cleanup | src/test/app.spec.ts › createServerApp › owns the PlayerRemoving connection for per-player cleanup | covered | lune/specs/server-app.luau › server app › owns the PlayerRemoving connection for per-player cleanup (fake Players service). Also ported with the same injected source through the native `players` option |
| app.test.ts › createServerApp › makes the owned transport dispose idempotent | — (removed) | retired | native ServerApp.dispose() calls binding.disconnect() on every call (server-app.ts:355-364) — tracked as a follow-up bug, not ported because it would pin the bug |
| app.test.ts › player sessions and lifecycle › injects the per-player session into ctx.session | src/test/app.spec.ts › player sessions and lifecycle › injects the per-player session into ctx.session | covered | lune/specs/server-app.luau › player sessions and lifecycle › injects the per-player session into ctx.session. Also ported through the `players` option |
| app.test.ts › player sessions and lifecycle › fires onPlayerAdded with the freshly-created session | src/test/app.spec.ts › player sessions and lifecycle › fires onPlayerAdded with the freshly-created session | ported | Partly overlaps server-app.luau › player sessions and lifecycle › fires onPlayerAdded with the session and drops it on leave, which does not check that dispose disconnects |
| app.test.ts › player sessions and lifecycle › boot-backfills onPlayerAdded for players already present | src/test/app.spec.ts › player sessions and lifecycle › boot-backfills onPlayerAdded for players already present | covered | lune/specs/server-app.luau › player sessions and lifecycle › boot-backfills onPlayerAdded for players already present. Also ported |
| app.test.ts › player sessions and lifecycle › passes the session to onPlayerRemoving, then drops it | src/test/app.spec.ts › player sessions and lifecycle › passes the session to onPlayerRemoving, then drops it | ported-adapted | `sessionsSeen` entries are wrapped `{ session }`, because the expected `undefined` cannot sit inside a Luau array |
| app.test.ts › player sessions and lifecycle › dispose disconnects both lifecycle connections and clears sessions | src/test/app.spec.ts › player sessions and lifecycle › dispose disconnects both lifecycle connections and clears sessions | ported | |
| app.test.ts › input defaults › fills a defaulted input field before the handler runs | src/test/app.spec.ts › input defaults › fills a defaulted input field before the handler runs | covered | lune/specs/server-app.luau › input defaults › fills a defaulted input field before the handler runs. Also ported |
| app.test.ts › in-process round-trip › connects a generated-style stub, client app, server app, and schema validation | src/test/app.spec.ts › in-process round-trip › connects a generated-style stub, client app, server app, and schema validation | ported | |
| middleware-app.test.ts › createServerApp middleware › wraps the run outermost-first and can observe input and output | src/test/middleware-app.spec.ts › createServerApp middleware › wraps the run outermost-first and can observe input and output | covered | lune/specs/dispatch.luau › server dispatch › runs middleware outermost-first around the handler. Also ported through app.dispatch (with a ctx player) |
| middleware-app.test.ts › createServerApp middleware › short-circuits when a middleware throws, without running the action | src/test/middleware-app.spec.ts › createServerApp middleware › short-circuits when a middleware throws, without running the action | divergence (native kept) | C: asserts name `ActionInternalError`, message `internal error`, run not called, and `cause` nil. `new Error(msg)` becomes a thrown `{ name: "Error", message }` table |
| middleware-app.test.ts › createServerApp middleware › does not reach middleware when the rate limit rejects first | src/test/middleware-app.spec.ts › createServerApp middleware › does not reach middleware when the rate limit rejects first | ported | `vi.fn` replaced by a counter |
| middleware-app.test.ts › createServerApp onError › observes run errors before they propagate | src/test/middleware-app.spec.ts › createServerApp onError › observes run errors before they propagate | ported-adapted | Thrown `{ name: "Error", message: "kaboom" }` table instead of an Error. The `/^[0-9a-f]{8}$/` check becomes length 8 plus the Lua pattern `^[0-9a-f]+$`. The ctx gets a player |
| middleware-app.test.ts › createServerApp onError › passes an actionError through with its own name and message | src/test/middleware-app.spec.ts › createServerApp onError › passes an actionError through with its own name and message | ported-adapted | onError info is `{ actionId, player: caller }` instead of `player: undefined`, because the native ctx requires a player. The point (no errorId) is kept by exact equality |
| middleware-app.test.ts › createServerApp onError › rethrows the original error when exposeInternalErrors is set | src/test/middleware-app.spec.ts › createServerApp onError › rethrows the original error when exposeInternalErrors is set | ported-adapted | Thrown table instead of an Error; ctx player. Overlaps dispatch.luau › server dispatch › sends the real message when exposeInternalErrors is set |
| middleware-app.test.ts › createServerApp onError › is not called for input validation failures | src/test/middleware-app.spec.ts › createServerApp onError › is not called for input validation failures | ported-adapted | ctx player; `vi.fn` replaced by a counter |
| rate-limit.test.ts › action rate limits › allows unlimited calls when no rate limit is declared | src/test/rate-limit.spec.ts › action rate limits › allows unlimited calls when no rate limit is declared | ported-adapted | `dispatchAction(registry, …)` → `createTestServerApp(...).invoke(player, …)`; `vi.fn` call count → closure counter. |
| rate-limit.test.ts › action rate limits › applies defaultRateLimit to actions that do not declare their own | src/test/rate-limit.spec.ts › action rate limits › applies defaultRateLimit to actions that do not declare their own | divergence (native kept) | Native shape asserted: the rejection is exactly `{ name, message, retryAfterMs: 1000, resetAtMs: 2000 }`, and `actionId`, `max`, `windowMs` are asserted undefined. The retired Node `ActionRateLimitError` also carried `actionId`, `max: 2`, `windowMs: 1000`. Source: server-runtime.ts:263-270, server-app.ts:344-350. Throttling and run count are unchanged. The injected `rateLimiter` is dropped: the registry owns its limiter. |
| rate-limit.test.ts › action rate limits › lets a per-action rateLimit override the defaultRateLimit | src/test/rate-limit.spec.ts › action rate limits › lets a per-action rateLimit override the defaultRateLimit | divergence (native kept) | Native shape asserted (exact `{ name, message, retryAfterMs, resetAtMs }`; `actionId`, `max`, `windowMs` undefined). The retired Node runtime also carried `max: 3`. The override behavior is unchanged: 3 calls allowed, the 4th refused. |
| rate-limit.test.ts › action rate limits › createServerApp forwards defaultRateLimit to dispatch | src/test/rate-limit.spec.ts › action rate limits › createServerApp forwards defaultRateLimit to dispatch | divergence (native kept) | Native shape asserted: `name` is set, and `message` embeds the numeric `retryAfterMs`. There is no `nowMs`, so `retryAfterMs` and `resetAtMs` come from os.clock() and are only type-checked. `actionId`, `max`, `windowMs`, `errorId` are asserted undefined. The retired Node runtime also carried `max: 1`. |
| rate-limit.test.ts › action rate limits › buckets by a per-action custom key function | src/test/rate-limit.spec.ts › action rate limits › buckets by a per-action custom key function | ported-adapted | `toBeInstanceOf(ActionRateLimitError)` → `.name`. Key resolution alone is also covered by lune/specs/rate-limit.luau › rate-limit (fixed window) › resolves a per-action custom key function; that case does not assert bucketing through dispatch. |
| rate-limit.test.ts › action rate limits › enforces a fixed window and resets after the window expires | src/test/rate-limit.spec.ts › action rate limits › enforces a fixed window and resets after the window expires | divergence (native kept) | Native shape asserted: exactly `{ name, message, retryAfterMs: 1000, resetAtMs: 2000 }`, with `actionId`, `max`, `windowMs` undefined. The retired Node runtime also carried `actionId`, `max: 2`, `windowMs: 1000`. The window and reset behavior are unchanged. Fake timers → harness clock: `advance(1000)` mirrors `setSystemTime(1000)`, then another `advance(1000)`. |
| rate-limit.test.ts › action rate limits › does not consume quota for invalid input | src/test/rate-limit.spec.ts › action rate limits › does not consume quota for invalid input | ported-adapted | `rejects.toThrowError(msg)` → `rejects.toThrow(msg)` (substring of `.message`, same full message). |
| rate-limit.test.ts › action rate limits › does not consume quota for unsafe serialization input | src/test/rate-limit.spec.ts › action rate limits › does not consume quota for unsafe serialization input | divergence (native kept) | Native shape asserted: exactly `{ name: "ActionSerializationError", message: "non-serializable action input" }`, with `actionId` and `role` undefined. The retired Node runtime also carried `actionId` and `role: "input"`. Same Player look-alike input; natively it is refused because it holds a function. No quota is spent. Source: server-runtime.ts:223-229. |
| rate-limit.test.ts › action rate limits › does not call run when the action is rate limited | src/test/rate-limit.spec.ts › action rate limits › does not call run when the action is rate limited | ported-adapted | dispatchAction → harness.invoke; call count via closure. |
| rate-limit.test.ts › action rate limits › keeps separate action buckets isolated | src/test/rate-limit.spec.ts › action rate limits › keeps separate action buckets isolated | ported-adapted | dispatchAction → harness.invoke. |
| rate-limit.test.ts › action rate limits › keeps separate player keys isolated | src/test/rate-limit.spec.ts › action rate limits › keeps separate player keys isolated | ported-adapted | The Node dispatch-level `rateLimitKey` override (bucketing on `ctx.player.bucket`) has no native counterpart. The native `"player"` key buckets on `UserId`, so two `createTestPlayer`s stand in for "alpha" and "beta". Limiter-level key isolation is also in lune/specs/rate-limit.luau › rate-limit (fixed window) › tracks keys independently. |
| rate-limit.test.ts › action rate limits › includes the expected fields on ActionRateLimitError | src/test/rate-limit.spec.ts › action rate limits › includes the expected fields on ActionRateLimitError | divergence (native kept) | Native shape asserted: exactly `{ name, message, retryAfterMs: 1000, resetAtMs: 2000 }`, with `actionId`, `max`, `windowMs` undefined. The retired Node runtime also carried `actionId`, `max: 1`, `windowMs: 1000`. |
| rate-limit.test.ts › action rate limits › surfaces a readable error response through RemoteEvent binding | src/test/rate-limit.spec.ts › action rate limits › surfaces a readable error response through RemoteEvent binding | ported-adapted | Fake remote + `bindRemoteEventActions` → `createServerApp({ transport: robloxRemoteEvent(), nowMs })` + raw envelopes over the real action RemoteEvent (`wireRemote`). The native wire result is flat: Node's `error.message` / `error.name` become `error` / `errorName`. It asserts the same message, `retryAfterMs: 1000` and a numeric `resetAtMs`. The `rateLimitKey` override is dropped (one LocalPlayer). |
| rate-limit.test.ts › action rate limits › purges only fully-elapsed buckets and reports the count | src/test/rate-limit.spec.ts › action rate limits › purges only fully-elapsed buckets and reports the count | ported-adapted | Native limiter clock is in seconds (1000/1500/1999/2000 ms → 1/1.5/1.999/2). Same counts 0, 2, 0. A related looser check is in lune/specs/rate-limit.luau › purge removes expired buckets. |
| rate-limit.test.ts › action rate limits › lazily purges abandoned keys on check while keeping the active window | src/test/rate-limit.spec.ts › action rate limits › lazily purges abandoned keys on check while keeping the active window | divergence (native kept) | Native shape asserted: the success result is exactly `{ ok: true }`, with `remaining` undefined. The retired Node runtime returned `remaining: 0`. Source: rate-limit.ts:73, 82-83. The lazy sweep, the surviving bucket and the 3rd-check refusal are unchanged (times in seconds). |
| rate-limit.test.ts › action rate limits › lets createServerApp share limiter state across dispatch calls | src/test/rate-limit.spec.ts › action rate limits › lets createServerApp share limiter state across dispatch calls | ported-adapted | Native `createServerApp` has no `rateLimiter` option. The registry owns one limiter that all dispatches share, which is what this asserts. `nowMs` is kept. |
| default-rate-limit-app.test.ts › createServerApp defaultRateLimit reaches the RemoteEvent dispatch path › blocks an action that only inherits the app-wide defaultRateLimit | src/test/default-rate-limit-app.spec.ts › createServerApp defaultRateLimit reaches the RemoteEvent dispatch path › blocks an action that only inherits the app-wide defaultRateLimit | ported-adapted | Fake remote + `bindRemoteEventActions` / `createRemoteEventActionInvoker` → real RemoteEvent via `robloxRemoteEvent()` / `createActionInvoker()`; `/rate limited/` → `message` contains "rate limited". |
| default-rate-limit-app.test.ts › createServerApp defaultRateLimit reaches the RemoteEvent dispatch path › blocks via the owned `transport` API and recovers after the window | src/test/default-rate-limit-app.spec.ts › createServerApp defaultRateLimit reaches the RemoteEvent dispatch path › blocks via the owned `transport` API and recovers after the window | ported-adapted | Same mechanics. The injected `rateLimiter` is dropped (registry-owned). The `nowMs` clock is stepped 0 → 1000. |
| default-rate-limit-app.test.ts › createServerApp defaultRateLimit reaches the RemoteEvent dispatch path › accepts the first `max` calls and rejects the rest under the owned transport | src/test/default-rate-limit-app.spec.ts › createServerApp defaultRateLimit reaches the RemoteEvent dispatch path › accepts the first `max` calls and rejects the rest under the owned transport | ported-adapted | Same mechanics; try/catch → `.then(() => true, () => false)`. |
| default-rate-limit-app.test.ts › createServerApp defaultRateLimit reaches the RemoteEvent dispatch path › exposes robloxRemoteEvent() as a transport factory | src/test/default-rate-limit-app.spec.ts › createServerApp defaultRateLimit reaches the RemoteEvent dispatch path › exposes robloxRemoteEvent() as a transport factory | ported | `toBeTypeOf("function")` → `typeIs(…, "function")`. |
| remote-signal-runtime.test.ts › unreliable signal routing › routes unreliable signals over the unreliable remote when present | src/test/remote-signal-runtime.spec.ts › unreliable signal routing › routes unreliable signals over the unreliable remote when present | ported | Also covered in part by lune/specs/signal.luau › signal transport › routes unreliable signals over the unreliable remote (counts deliveries, not wire ids). Native `createRemoteSignalPublisher` imported from `aruna/internal/signal-runtime` (not on a public subpath natively). |
| remote-signal-runtime.test.ts › unreliable signal routing › falls back to the reliable remote when no unreliable remote is given | src/test/remote-signal-runtime.spec.ts › unreliable signal routing › falls back to the reliable remote when no unreliable remote is given | ported | Also covered by lune/specs/signal.luau › signal transport › falls back to the reliable remote when no unreliable remote is given (delivery count, not the wire id). |
| remote-signal-runtime.test.ts › unreliable signal routing › delivers unreliable-channel messages through the subscriber | src/test/remote-signal-runtime.spec.ts › unreliable signal routing › delivers unreliable-channel messages through the subscriber | ported | `vi.fn` replaced by a recording closure; listener count checked after dispose. |
| remote-signal-runtime.test.ts › createRemoteSignalPublisher › validates and fires a payload to a single player | src/test/remote-signal-runtime.spec.ts › createRemoteSignalPublisher › validates and fires a payload to a single player | ported | Full `sent` record deep-equal. Partly covered by lune/specs/signal.luau › signal transport › delivers a published payload to a dynamic subscriber. |
| remote-signal-runtime.test.ts › createRemoteSignalPublisher › broadcasts to all clients | src/test/remote-signal-runtime.spec.ts › createRemoteSignalPublisher › broadcasts to all clients | ported | Partly covered by lune/specs/signal.luau › signal transport › broadcasts to all subscribers. |
| remote-signal-runtime.test.ts › createRemoteSignalPublisher › fans a payload out to many players | src/test/remote-signal-runtime.spec.ts › createRemoteSignalPublisher › fans a payload out to many players | ported | Also asserts the recipients' order. |
| remote-signal-runtime.test.ts › createRemoteSignalPublisher › throws on an unknown signal id | src/test/remote-signal-runtime.spec.ts › createRemoteSignalPublisher › throws on an unknown signal id | ported | lune/specs/signal.luau › rejects an unknown signal id on publish only checks that it throws; spec checks the message. |
| remote-signal-runtime.test.ts › createRemoteSignalPublisher › rejects a payload that violates the schema before it reaches the wire | src/test/remote-signal-runtime.spec.ts › createRemoteSignalPublisher › rejects a payload that violates the schema before it reaches the wire | ported | Also covered by lune/specs/signal.luau › signal transport › rejects a schema-invalid payload before the wire. |
| remote-signal-runtime.test.ts › createRemoteSignalPublisher › rejects a non-serializable payload before it reaches the wire | src/test/remote-signal-runtime.spec.ts › createRemoteSignalPublisher › rejects a non-serializable payload before it reaches the wire | ported-adapted | Message wording differs: vitest matches /not serializable/ (Node: "... is not serializable ..."); native throws "non-serializable signal payload: combat.damaged" (roblox/signal-runtime.ts:126). Asserted on the native wording; same reason, same nothing-on-the-wire check. |
| remote-signal-runtime.test.ts › createRemoteSignalPublisher › toBatched sends every payload to one player, yielding between chunks | src/test/remote-signal-runtime.spec.ts › createRemoteSignalPublisher › toBatched sends every payload to one player, yielding between chunks | ported-adapted | Native `yield` option is `() => void` (synchronous, called on the batch thread) instead of `() => Promise<void>`. Also covered by lune/specs/signal.luau › toBatched sends every payload… (count only; spec checks payload order). |
| remote-signal-runtime.test.ts › createRemoteSignalPublisher › toBatched rejects the whole batch on the first invalid payload | src/test/remote-signal-runtime.spec.ts › createRemoteSignalPublisher › toBatched rejects the whole batch on the first invalid payload | ported | `.rejects.toThrow(substring)`. |
| remote-signal-runtime.test.ts › createRemoteSignalSubscriber › delivers messages to dynamic .on() subscribers | src/test/remote-signal-runtime.spec.ts › createRemoteSignalSubscriber › delivers messages to dynamic .on() subscribers | ported | Partly covered by lune/specs/signal.luau › stops delivering after disconnect. |
| remote-signal-runtime.test.ts › createRemoteSignalSubscriber › drops payloads that violate the declared schema | src/test/remote-signal-runtime.spec.ts › createRemoteSignalSubscriber › drops payloads that violate the declared schema | ported | Also covered by lune/specs/signal.luau › signal transport › drops a schema-invalid payload on delivery. |
| remote-signal-runtime.test.ts › createRemoteSignalSubscriber › ignores malformed envelopes and signals with no handlers | src/test/remote-signal-runtime.spec.ts › createRemoteSignalSubscriber › ignores malformed envelopes and signals with no handlers | ported-adapted | `null` envelope sent as nil (no `null` in Luau). |
| remote-signal-runtime.test.ts › createRemoteSignalSubscriber › dispose disconnects from the client signal and rejects further subscriptions | src/test/remote-signal-runtime.spec.ts › createRemoteSignalSubscriber › dispose disconnects from the client signal and rejects further subscriptions | ported | |
| remote-signal-runtime.test.ts › createRemoteSignalSubscriber › round-trips publisher to subscriber over one remote | src/test/remote-signal-runtime.spec.ts › createRemoteSignalSubscriber › round-trips publisher to subscriber over one remote | ported | |
| signal-app.test.ts › createServerApp signal publisher ownership › builds the publisher at boot and routes payloads to subscribers | src/test/signal-app.spec.ts › createServerApp signal publisher ownership › builds the publisher at boot and routes payloads to subscribers | ported | |
| signal-app.test.ts › createServerApp signal publisher ownership › omits the publisher when no createPublisher is supplied | src/test/signal-app.spec.ts › createServerApp signal publisher ownership › omits the publisher when no createPublisher is supplied | ported | App disposed afterwards (native app connects to the shared fake Players). |
| signal-app.test.ts › createClientApp signal subscriber ownership › builds the subscriber at boot and receives published payloads | src/test/signal-app.spec.ts › createClientApp signal subscriber ownership › builds the subscriber at boot and receives published payloads | ported | `vi.fn` transport replaced by a plain async function. |
| signal-app.test.ts › createClientApp signal subscriber ownership › disposes the owned subscriber with the app | src/test/signal-app.spec.ts › createClientApp signal subscriber ownership › disposes the owned subscriber with the app | ported | |
| signal-app.test.ts › createClientApp signal subscriber ownership › omits the subscriber when no createSubscriber is supplied | src/test/signal-app.spec.ts › createClientApp signal subscriber ownership › omits the subscriber when no createSubscriber is supplied | ported | |
| signal-app.test.ts › createClientApp invoke injection › invokes through the app handle without relying on the global install | src/test/signal-app.spec.ts › createClientApp invoke injection › invokes through the app handle without relying on the global install | ported | Call count via closure; additionally asserts the disposed invoke never reached the transport. |
| signal-app.test.ts › action ctx.publisher injection › threads the app-owned publisher into an in-process dispatch | src/test/signal-app.spec.ts › action ctx.publisher injection › threads the app-owned publisher into an in-process dispatch | ported-adapted | Definer typed `createActionDefiner<typeof signals, Player>()`; dispatched as the fake LocalPlayer instead of the string "p1". |
| signal-app.test.ts › action ctx.publisher injection › threads the publisher through the wire transport (createServerApp owns dispatch) | src/test/signal-app.spec.ts › action ctx.publisher injection › threads the publisher through the wire transport (createServerApp owns dispatch) | ported-adapted | Node `bindRemoteEventActions` over a structural fake remote → native `robloxRemoteEvent()` over the real (fake-game) action RemoteEvent, driven by a raw `FireServer("r1", "score.bump", {score: 9})` via support.ts `wireRemote`. `toMatchObject({requestId, ok})` → per-field checks on the native `(requestId, result)` response. |
| signal-app.test.ts › turnkey signal helpers are part of the public surface › exposes createSignalPublisher/createSignalSubscriber and the remote ensurers | src/test/signal-app.spec.ts › turnkey signal helpers are part of the public surface › exposes createSignalPublisher/createSignalSubscriber and the remote ensurers | ported-adapted | createSignalPublisher/createSignalSubscriber checked as functions on `aruna/roblox`. `ensureSignalRemote`/`waitForSignalRemote` are not exported natively (the ensure/wait functions in roblox/roblox.ts are module-private); asserted as their behavior instead: createSignalPublisher creates `ArunaSignalRemoteEvent` in ReplicatedStorage, a second call reuses it, and createSignalSubscriber finds it and receives a toAll. |
| request-guard.test.ts › request budget › drops envelopes past the burst, silently, and refills over time | src/test/request-guard.spec.ts › request budget › drops envelopes past the burst, silently, and refills over time | ported-adapted | Node structural remote → native `robloxRemoteEvent()` over the real action RemoteEvent, envelopes sent from the client end. Clock via `createServerApp({ nowMs })`. Related: lune/specs/transport.luau › RemoteEvent transport request budget › drops envelopes past the burst, and malformed ones, without a response (no refill check). |
| request-guard.test.ts › request budget › charges invalid payloads too, before validation runs | src/test/request-guard.spec.ts › request budget › charges invalid payloads too, before validation runs | ported-adapted | Real action RemoteEvent; a function-valued input is the non-wire-safe payload. |
| request-guard.test.ts › request budget › keeps each player's budget separate and drops it on leave | src/test/request-guard.spec.ts › request budget › keeps each player's budget separate and drops it on leave | ported-adapted | Ada = fake LocalPlayer over the real RemoteEvent; Bo is driven through the same registry calls the transport makes (`admitEnvelope` then `dispatch`, registry captured from the transport factory), because the fake game's FireServer always arrives as LocalPlayer. Leave via an injected `players` source. |
| request-guard.test.ts › request budget › refuses calls past the in-flight cap with ActionRateLimitError | src/test/request-guard.spec.ts › request budget › refuses calls past the in-flight cap with ActionRateLimitError | ported-adapted | Native wire response is `(requestId, { ok, errorName, retryAfterMs, ... })` rather than `{ requestId, ok, error: { name, retryAfterMs } }`; asserted field by field (requestId r3, ok false, errorName ActionRateLimitError, retryAfterMs 100, only response). Related: lune/specs/transport.luau › refuses calls past the in-flight cap and frees the slots on forgetPlayer (registry level, not over the wire). |
| request-guard.test.ts › request budget › frees a player's in-flight slots on leave | src/test/request-guard.spec.ts › request budget › frees a player's in-flight slots on leave | ported-adapted | Real RemoteEvent + injected `players` source (app-level leave), vs. the Luau case which calls `registry.forgetPlayer` directly. |
| request-guard.test.ts › wire node budget › rejects a value with more than 2048 values in it, however shallow | src/test/request-guard.spec.ts › wire node budget › rejects a value with more than 2048 values in it, however shallow | ported-adapted | Node `validateSerializableActionValue` (violation list with reason "more than 2048 values cannot cross action boundaries") → native `isWireSafe` (boolean, no reason). The reason is pinned by the same 2048 array passing with `maxNodes` 2049, plus `DEFAULT_MAX_WIRE_NODES === 2048`; additionally asserted at the action boundary (2048-item input → ActionSerializationError, 2047 runs). |
| request-guard.test.ts › wire node budget › does not hold an action's own output to it | src/test/request-guard.spec.ts › wire node budget › does not hold an action's own output to it | ported | `app.dispatch` resolves a 5000-item output. |
| testing-harness.test.ts › createTestServerApp › dispatches through validation and returns the action output | src/test/testing-harness.spec.ts › createTestServerApp › dispatches through validation and returns the action output | ported | `.resolves.toEqual` → `expect(await ...).toEqual`. Also covered by lune/specs/testing.luau › testing harness › dispatches through validation and returns the output (weaker: only checks `output.ok`). |
| testing-harness.test.ts › createTestServerApp › rejects input the schema does not accept | src/test/testing-harness.spec.ts › createTestServerApp › rejects input the schema does not accept | ported-adapted | Regex `/invalid action input\|quantity/i` → substring checks `"quantity"` and `"input validation failed"` (native message: `Aruna action shop.buy input validation failed: quantity: ...`). Also covered by testing.luau › testing harness › rejects input the schema does not accept (different field). |
| testing-harness.test.ts › createTestServerApp › shows a spec the real failure rather than the masked one | src/test/testing-harness.spec.ts › createTestServerApp › shows a spec the real failure rather than the masked one | ported-adapted | `throw new Error("kaboom")` → `throw "kaboom"` (no Error class). Also covered by testing.luau › testing harness › shows a spec the real failure rather than the masked one. |
| testing-harness.test.ts › createTestServerApp › records every signal the action publishes, with its recipient | src/test/testing-harness.spec.ts › createTestServerApp › records every signal the action publishes, with its recipient | ported-adapted | Native `published` is a function (`harness.published()`), not a property. Added an identity check that the recorded `player` is the same double. Also covered by testing.luau › testing harness › records every published signal with its recipient. |
| testing-harness.test.ts › createTestServerApp › validates published payloads the way the real publisher does | src/test/testing-harness.spec.ts › createTestServerApp › validates published payloads the way the real publisher does | ported-adapted | Regex `/shop\.purchased.*item: expected string/` → two substring checks on the same rejection (`"shop.purchased"`, `"item: expected string"`); native message `invalid signal payload: shop.purchased (item: expected string ...)`. Not covered in Lune before. |
| testing-harness.test.ts › createTestServerApp › drives the player lifecycle: sessions, hooks, and boot state | src/test/testing-harness.spec.ts › createTestServerApp › drives the player lifecycle: sessions, hooks, and boot state | ported-adapted | `harness.players` → `harness.players()`; TestPlayer generic → `Player` (native createTestPlayer returns Player). Uses `createActionDefiner<signals, Player, {visits}>` from aruna/server. Also covered by testing.luau › testing harness › drives the player lifecycle: sessions and hooks. |
| testing-harness.test.ts › createTestServerApp › enforces the app's rate limit | src/test/testing-harness.spec.ts › createTestServerApp › enforces the app's rate limit | ported | `/rate limited/i` → substring `"rate limited"`. Also covered by testing.luau › testing harness › enforces the app's rate limit. |
| testing-harness.test.ts › createTestServerApp › crosses a rate-limit window when the spec advances the clock | src/test/testing-harness.spec.ts › createTestServerApp › crosses a rate-limit window when the spec advances the clock | ported | Also covered by testing.luau › testing harness › crosses a rate-limit window when the spec advances the clock. |
| testing-harness.test.ts › createTestServerApp › refuses to advance a clock the caller owns | src/test/testing-harness.spec.ts › createTestServerApp › refuses to advance a clock the caller owns | ported | Regex → substring `"given its own nowMs"`. Not covered in Lune before. |
| testing-harness.test.ts › createTestServerApp › runs middleware around the action | src/test/testing-harness.spec.ts › createTestServerApp › runs middleware around the action | ported-adapted | Middleware param `next` renamed `proceed` (reserved in roblox-ts); typed as `ActionMiddleware<Player>`. Not covered in Lune before. |
| testing-harness.test.ts › TestServerApp.client › invokes actions through a client app bound to the server | src/test/testing-harness.spec.ts › TestServerApp.client › invokes actions through a client app bound to the server | ported | Asserts the full output `{ ok: true }`. Partially covered by testing.luau › testing harness › routes a client's invoke and its subscriber through the server (only checks resolution). |
| testing-harness.test.ts › TestServerApp.client › delivers signals published to that player to the client subscriber | src/test/testing-harness.spec.ts › TestServerApp.client › delivers signals published to that player to the client subscriber | ported | Also covered by testing.luau › testing harness › routes a client's invoke and its subscriber through the server. vitest's file-level `afterEach(clearActionInvoker)` is an `afterEach` inside each describe (native hooks must be inside a describe). |
| testing-framework.test.ts › collection and running › runs collected tests and reports pass/fail counts | src/test/testing-framework.spec.ts › collection and running › runs collected tests and reports pass/fail counts | divergence (native kept) | Native kept: asserts `"math > adds"`; the retired Node runtime joined names with " › " (Node framework.ts:116 vs native testing-framework.ts:119). Counts/message unchanged. Also covered by testing.luau › testing framework › collects tests, runs them, and counts pass/fail. Guarded: beforeEach waits a frame, afterEach resetTests. |
| testing-framework.test.ts › collection and running › awaits async bodies and records rejections as failures | src/test/testing-framework.spec.ts › collection and running › awaits async bodies and records rejections as failures | ported-adapted | `Promise.reject(new Error("boom"))` → `Promise.reject({ message: "boom" })` awaited inside an async body. Also covered by testing.luau › testing framework › awaits promise-returning bodies and records rejections. |
| testing-framework.test.ts › collection and running › runs hooks outermost-in and afterEach even when the test failed | src/test/testing-framework.spec.ts › collection and running › runs hooks outermost-in and afterEach even when the test failed | ported-adapted | `throw new Error("nope")` → `throw "nope"`. Also covered by testing.luau › testing framework › runs hooks outermost-in, and afterEach even after a failure. |
| testing-framework.test.ts › collection and running › keeps skipped tests visible in the report without running them | src/test/testing-framework.spec.ts › collection and running › keeps skipped tests visible in the report without running them | divergence (native kept) | Native kept: asserts `{ name: "suite > not yet", ok: true, skipped: true }`; Node used " › ". Also covered by testing.luau › testing framework › keeps skipped tests visible without running them. |
| testing-framework.test.ts › collection and running › streams outcomes to onTest as they settle | src/test/testing-framework.spec.ts › collection and running › streams outcomes to onTest as they settle | divergence (native kept) | Native kept: asserts `["suite > one", "suite > two"]`; Node used " › ". Not covered in testing.luau before. |
| testing-framework.test.ts › collection and running › rejects a hook registered outside a describe block | src/test/testing-framework.spec.ts › collection and running › rejects a hook registered outside a describe block | ported | Regex → substring `"inside a describe block"`. Not covered in Lune before. |
| testing-framework.test.ts › matchers › compares structurally with toEqual and by identity with toBe | src/test/testing-framework.spec.ts › matchers › compares structurally with toEqual and by identity with toBe | ported | Partially covered by testing.luau › testing framework › matches structurally, negates, and reads both rejection shapes (positive toEqual only). |
| testing-framework.test.ts › matchers › negates through .not | src/test/testing-framework.spec.ts › matchers › negates through .not | ported | Partially covered by testing.luau › testing framework › matches structurally, negates, ... (positive `.not` only). |
| testing-framework.test.ts › matchers › covers presence, truthiness, containment, and length | src/test/testing-framework.spec.ts › matchers › covers presence, truthiness, containment, and length | divergence (native kept) | Native kept: Luau truthiness, so `expect("").toBeTruthy()` plus falsy checks on `undefined` and `false`; the retired Node runtime treated "" as falsy (JS truthiness). Native: testing-framework.ts:377-381. |
| testing-framework.test.ts › matchers › asserts throws and rejections through both runtimes' error shapes | src/test/testing-framework.spec.ts › matchers › asserts throws and rejections through both runtimes' error shapes | ported-adapted | `throw new Error("kaboom")` → throw an instance of a local roblox-ts class `ThrownError` with a `message` field. Partially covered by testing.luau › testing framework › matches structurally, negates, ... |
| testing-framework.test.ts › matchers › reads a message out of every rejection shape | src/test/testing-framework.spec.ts › matchers › reads a message out of every rejection shape | ported-adapted | `new Error("a")` → `new ThrownError("a")` (class instance with message). Not covered in Lune before. |
| testing-framework.test.ts › matchers › deepEquals compares plain values but not class instances | src/test/testing-framework.spec.ts › matchers › deepEquals compares plain values but not class instances | divergence (native kept) | Native kept: two equal class instances are deepEquals `true` (tables compared structurally, metatable ignored; testing-framework.ts:301-321); the retired Node runtime returned false for non-plain prototypes (framework.ts:253-262). The vitest name is unchanged. |
| idempotency.test.ts › idempotency keys › does not remember a call refused before it ran | src/test/idempotency.spec.ts › idempotency keys › does not remember a call refused before it ran | ported-adapted | toMatchObject({ name }) → rejectionOf(...).name. |
| idempotency.test.ts › idempotency keys › evicts the oldest key past the per-player bound | src/test/idempotency.spec.ts › idempotency keys › evicts the oldest key past the per-player bound | ported | harness invoke with { idempotencyKey }. |
| idempotency.test.ts › idempotency keys › forgets a player's keys when they leave | src/test/idempotency.spec.ts › idempotency keys › forgets a player's keys when they leave | ported | harness invoke with { idempotencyKey }. |
| idempotency.test.ts › idempotency keys › keeps keys apart per player and per action, and without a key | src/test/idempotency.spec.ts › idempotency keys › keeps keys apart per player and per action, and without a key | ported | harness invoke with { idempotencyKey }. |
| idempotency.test.ts › idempotency keys › reads the key from the wire envelope and ignores an invalid one | src/test/idempotency.spec.ts › idempotency keys › reads the key from the wire envelope and ignores an invalid one | ported-adapted | Node bindRemoteEventActions over a structural remote → robloxRemoteEvent() over the real action RemoteEvent, raw envelopes via support.wireRemote; responses are (requestId, { ok, output }). |
| idempotency.test.ts › idempotency keys › runs a duplicate key once and gives both callers the same result | src/test/idempotency.spec.ts › idempotency keys › runs a duplicate key once and gives both callers the same result | ported | harness invoke with { idempotencyKey }. |
| idempotency.test.ts › idempotency keys › runs again once the remembered result expires | src/test/idempotency.spec.ts › idempotency keys › runs again once the remembered result expires | ported | harness invoke with { idempotencyKey }. |
| public-exports.test.ts › public exports › returns defineConfig objects unchanged | stays in vitest (packages/aruna/test/public-exports.test.ts) — root entry, Node | kept | The root entry still runs under Node. |
| public-exports.test.ts › public exports › keeps the stable entrypoints wired together | src/test/public-exports.spec.ts › public exports › keeps the stable entrypoints wired together | ported-adapted | dispatchAction → app.dispatch; schema `.kind` → `.typeName`; Node-only exports (error classes, createActionRateLimiter, validateSerializableActionValue) dropped from the assertion with the Node runtime. |
| public-exports.test.ts › public exports › exposes the RemoteEvent client invoker | — | retired | createRemoteEventActionInvoker over a structural remote was Node-only; the native invoker over the real remote is covered by src/test/remote-event-runtime.spec.ts. |
| public-exports.test.ts › public exports › exposes the default Roblox action remote helpers | src/test/public-exports.spec.ts › public exports › exposes the default Roblox action remote helpers | ported-adapted | getActionRemote/ensureActionRemote/waitForActionRemote are Node-only exports; asserts the native helper surface (ACTION_REMOTE_NAME, SIGNAL_REMOTE_NAME, robloxRemoteEvent, createActionInvoker, bindActions). |
| conformance.test.ts › dispatch conformance (Node) › (one case per dispatch.json row) | lune/specs/conformance.luau (same table, every row) | covered | The table already ran natively; only the Node runner is deleted. |

### Ported after the consolidation

Four fixes landed on `fix/stabilization` after this branch forked, each with vitest cases
against the Node runtime. They were ported here with their Node halves dropped:

| Commit (ported as) | vitest case | Lune spec case |
|---|---|---|
| 83c621f (2a88eb2) | serialization.test.ts › serialization policy › keeps the walk inside the node budget when a field is a union | lune/specs/serialization.luau › same name |
| 83c621f (2a88eb2) | serialization.test.ts › serialization policy › does not narrow nested unions by validating them | lune/specs/serialization.luau › same name |
| 83c621f (2a88eb2) | serialization.test.ts › serialization policy › accepts an Instance where any union member at that position is schema.instance() | lune/specs/serialization.luau › same name |
| 9931a59 (c105b49) | binary-signals.test.ts › … › refuses a binary unreliable frame that is over the limit with its envelope | lune/specs/signal.luau › same name |
| 9931a59 (c105b49) | binary-signals.test.ts › … › rejects toBatched with the same error | lune/specs/signal.luau › refuses a binary unreliable frame that is over the limit with its envelope (asserts the toBatched rejection) |
| 9931a59 (c105b49) | binary-signals.test.ts › … › leaves reliable and table-encoded signals alone | lune/specs/signal.luau › same name |
| 2fc1cb8 (ef60e95) | request-guard.test.ts › after leave › drops an envelope that arrives after the player left, and creates no state for it | lune/specs/transport.luau › RemoteEvent transport after leave › same name |
| 2fc1cb8 (ef60e95) | request-guard.test.ts › after leave › does not remember a late call's idempotency key | lune/specs/transport.luau › RemoteEvent transport after leave › same name |
| 2fc1cb8 (ef60e95) | request-guard.test.ts › after leave › forgets the departed mark after DEPARTED_PLAYER_TTL_MS, so it does not pin the player | lune/specs/transport.luau › RemoteEvent transport after leave › forgets the departed mark after its TTL, so it does not pin the player |
| 2fc1cb8 (ef60e95) | request-guard.test.ts › after leave › sweeps expired departures when another player leaves | src/test/request-guard.spec.ts › after leave › same name |
| 2fc1cb8 (ef60e95) | request-guard.test.ts › request budget › (two cases changed to rejoin before sending again) | src/test/request-guard.spec.ts › keeps each player's budget separate and drops it on leave; frees a player's in-flight slots on leave (same change) |
| f248d46 (5a28f05) | request-guard.test.ts › in-process dispatch › is not held to the in-flight cap, while the transport still is | lune/specs/server-app.luau › exempts app.dispatch from the in-flight cap the transport still applies |
| f248d46 (5a28f05) | request-guard.test.ts › in-process dispatch › still de-duplicates by idempotency key | lune/specs/server-app.luau › keeps idempotency for app.dispatch |
