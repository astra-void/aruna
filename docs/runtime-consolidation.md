# Runtime consolidation audit (Stage 0, Part A1)

Status: **audit only — no code changed.** Written 2026-10-27 against `fix/stabilization`
at `9c61fdd`. The decision gate at the end is the open question.

Aruna implements its runtime twice:

- the **Node runtime** — `packages/aruna/src/{runtime,app,actions,signals,stores,runtimes,schema,testing}`
  plus the five barrels `src/{server,client,roblox,schema,testing}.ts`, compiled by
  `tsconfig.json` into `dist/` and validated by vitest;
- the **native runtime** — `packages/aruna/roblox/*.ts`, roblox-ts source shipped in the
  package's `files`, vendored into a consumer's `<generatedDir>/shared/runtime/` by
  `aruna build --emit-runtime`, and executed under Lune by `apps/roblox-runtime-test` and
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
| `apps/package-consumption-harness` | Vendored aliases (`aruna build --emit-runtime`); `tsc` and `rbxtsc` both see native source. |
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
