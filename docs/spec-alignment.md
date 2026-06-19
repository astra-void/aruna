# Aruna Spec Alignment

## Current status

Aruna is aligned with the compiler-first direction of the RFC, but the implementation has started to drift toward transport and harness convenience before the core MVP contract is finished.

`apps/rbxts-harness` now intentionally mirrors Recommended Layout v0 closely enough to serve as the realistic starter/reference harness, while still remaining harness metadata rather than generated Rojo output or create-app scaffolding.

Phase 1 verification is green: `cargo test`, `pnpm typecheck` (8/8), and the spec smoke commands (`aruna check`, `aruna inspect modules`, `aruna inspect graph`) all pass, and the unit/contract suites are green (`@arunajs/compiler` 100/100, `aruna` 152/152). The Rust compiler parser is now OXC; the RFC's "SWC-based" references are superseded by the completed Phase 1.1 OXC migration. Generated action stubs are emitted as compact, deterministic single-line type aliases.

Public package subpaths for packed installs are now complete: root re-export shims build to `packages/aruna/*.js`/`*.d.ts` via `tsconfig.shims.json`, ship through `files`, and back the subpath `exports`, so `packages/aruna/test/public-subpaths.test.ts` passes.

The roblox-ts package-layout blocker is now resolved for `apps/package-consumption-harness`. A roblox-ts-native runtime lives at `packages/aruna/roblox/` (separate from the Node reference runtime under `packages/aruna/src`, which vitest validates). `aruna build --emit-runtime` vendors it into the consumer's `<generatedDir>/runtime/` as project source, and the harness aliases the Roblox-facing `aruna/*` subpaths to that vendored runtime via tsconfig `paths`. With the harness `default.project.json` mapping the full `out` tree, `rbxtsc` compiles the whole consumer project — including the vendored runtime — to Luau. `pnpm test` (which runs the harness `rbxtsc` build) and `pnpm typecheck` are fully green. The native runtime is intentionally thin (schema string/number/boolean/object/array/optional, `defineAction`, client `invokeAction`, server dispatch, and a default `RemoteEvent` action transport); rate-limit and serialization enforcement parity with the Node runtime remain follow-ups.

## Aligned with Notion spec

| Area                             | Status | Notes                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust-owned compiler core         | Keep   | Compiler discovery, graphing, diagnostics, and manifest generation are Rust-owned.                                                                                                                                                                                                                                                                  |
| No TypeScript analyzer fallback  | Keep   | Native compiler loading is the only path.                                                                                                                                                                                                                                                                                                           |
| Config shape                     | Keep   | `defineConfig()` and the nested `compiler`, `actions`, `conventions`, and `strict` config shape are implemented.                                                                                                                                                                                                                                    |
| First-run DX flow                | Keep   | The intended flow is documented as `doctor --fix`, `check`, `build`, `inspect actions`, and `inspect contract --json`.                                                                                                                                                                                                                              |
| Action discovery                 | Keep   | Server action discovery and manifest emission exist.                                                                                                                                                                                                                                                                                                |
| Generated stubs                  | Keep   | Client/server action stubs are generated and snapshot-tested.                                                                                                                                                                                                                                                                                       |
| Inspect actions                  | Keep   | `aruna inspect actions` inventories client-callable actions, schema summaries, serialization policy metadata, rate limits, and basic authority notes.                                                                                                                                                                                               |
| Contract snapshot foundation     | Keep   | `aruna inspect contract` emits a deterministic JSON snapshot of the public action contract surface, including ids, source paths, generated export names, schema metadata and summaries, serialization policy, rate limits, authority notes, and warnings.                                                                                           |
| Contract diff command            | Keep   | `aruna contract diff` compares action contract snapshots or a baseline snapshot against the current project and reports breaking, non-breaking, and info-level changes.                                                                                                                                                                             |
| Authority visibility             | Keep   | The inspect command exposes server-owned actions and generated client-callable stubs without adding a full policy/capability system yet.                                                                                                                                                                                                            |
| Schema runtime validation        | Keep   | Action input/output validation runs at dispatch time.                                                                                                                                                                                                                                                                                               |
| Serialization boundary policy    | Keep   | Runtime now enforces the default `plain-data-v1` action boundary and rejects non-wire-safe input/output values.                                                                                                                                                                                                                                     |
| Basic action rate limit          | Keep   | Manifest-visible fixed-window rate limits are parsed and enforced per action and player/key.                                                                                                                                                                                                                                                        |
| Virtual generated imports        | Keep   | `$aruna/actions/client` and `$aruna/actions/server` are supported.                                                                                                                                                                                                                                                                                  |
| Package consumption validation   | Keep   | `apps/package-consumption-harness` validates package-style consumption through workspace package resolution, package exports, doctor/check/build/inspect/contract diff, and the current TypeScript path setup. The packed tarball smoke now resolves the local Aruna tarballs without registry access, runs `doctor --fix`, generates `src/.aruna` action files, and passes TypeScript; the remaining blocker is `rbxtsc` package-layout, where roblox-ts rejects direct `node_modules` package modules and the temp Rojo tree does not cover `out/domains/shop/model.luau`. |
| `rbxts` harness                  | Keep   | The harness validates generated output, typecheck, and `rbxtsc`.                                                                                                                                                                                                                                                                                    |
| Recommended layout harness shape | Keep   | `apps/rbxts-harness` mirrors the recommended app/domain/shared layout and conventional Roblox service tree closely enough for starter/reference use, while the temporary layout shim is driven from compiler manifest metadata and partitions emitted output into `out/client`, `out/server`, and `out/shared`.                                     |

## Ahead-of-scope but retained

| Area                                        | Status | Notes                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default Roblox `RemoteEvent` binding helper | Retain | Useful for current harness/tests, but do not expand.                                                                                                                                                                                                                                                                                              |
| Structural `RemoteFunction` transport       | Retain | Exists as a test/future integration foundation only.                                                                                                                                                                                                                                                                                              |
| Structural `RemoteEvent` transport          | Retain | Exists as a test/future integration foundation only.                                                                                                                                                                                                                                                                                              |
| Harness `default.project.json`              | Retain | Manual harness metadata only, with a conventional Roblox service tree and `rbxts_include` package mounting rather than generated Rojo integration. It no longer exposes Aruna-specific `App`/`Domains` nodes or a broad `out/` mount, but it still mounts the workspace `aruna` package inside `rbxts_include` as harness-only glue for `rbxtsc`. |
| Shared-safe app wiring                      | Keep   | The harness now wires client/server behavior from `src/client.tsx` and `src/server.ts` directly, while `src/app/bootstrap.ts` and `src/app/providers.ts` stay shared-safe helpers instead of hidden runtime entry files.                                                                                                                          |
| `aruna doctor --fix` path alias management  | Retain | Keep the minimal alias setup; do not broaden into more config automation yet.                                                                                                                                                                                                                                                                     |
| Basic action rate limit                     | Retain | The fixed-window runtime limiter exists, but it is not a full anti-abuse or policy system.                                                                                                                                                                                                                                                        |

## Drift / gaps

| Area                               | Status      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| README framing                     | Keep        | The README now distinguishes the general source layout from the temporary harness build-layout shim for `src/.aruna`.                                                                                                                                                                                                                                                                                                     |
| Harness generatedDir               | Keep        | The private rbxts harness keeps generated files under `src/.aruna`; the temporary layout shim now derives its staging paths from the normalized compiler config, stages compiler-derived copies into `shared/.aruna` and `server/.aruna` as needed for `rbxtsc`, and keeps the committed source of truth under `src/.aruna`. The workspace `aruna` package mount remains in `rbxts_include` as private harness-only glue. |
| Recommended layout starter harness | In progress | The rbxts harness now mirrors the recommended layout, but create-app and generated Rojo remain deferred.                                                                                                                                                                                                                                                                                                                  |
| Package consumption foundation     | Keep        | The first-party package-consumption harness is in place, and the packed smoke now installs the local tarballs without registry fetches, installs the generated aliases, validates public package subpaths, and passes TypeScript. The remaining blocker is `rbxtsc` package-layout, so the publish-like package story is closer but still not closed.                                                                                                          |

## Correct MVP cutline

1. Stabilize current action runtime, compiler, and harness behavior.
2. Serialization boundary policy:
   - runtime enforces the default `plain-data-v1` boundary
   - reject `Instance`, `Player`, function, class-instance, cyclic, non-finite, and other non-plain values across action input/output by default
   - manifest records include serialization policy metadata
   - static diagnostics remain limited for now
3. Contract snapshot foundation:
   - stable JSON snapshot of actions, schemas, and rate limits
   - diffing can be deferred
4. Create-app and generated Rojo remain deferred.

## Do not implement yet

- `defineResource`
- resource invalidation
- policies and capabilities
- player sessions
- Studio overlay
- Studio runner flow
- DataStore workflows
- create-app
- Rojo generation
- generated Roblox Instance creation
- full production Studio validation
- LSP or editor extensions

## Next implementation order

1. Close the packed-smoke `rbxtsc` package-layout / runtime-package blocker (chosen next focus):
   1. ~~Complete public package subpaths for packed installs — emit root `*.js`/`*.d.ts` re-export shims, ship them via `files`, and point the subpath `exports` at the root shims.~~ **Done**: `tsconfig.shims.json` builds the 8 root shims, `files` ships `*.js`/`*.d.ts`, subpath `exports` point at the root shims, and `public-subpaths.test.ts` is green.
   2. **Done**: authored a thin roblox-ts-native runtime at `packages/aruna/roblox/` (chosen option **(b)**, kept separate from the Node reference runtime so vitest stays green). It is shipped via package `files` and vendored into the consumer with `aruna build --emit-runtime`. The discovery that the Node runtime is not roblox-ts-compatible (Node idioms, ~71 `rbxtsc` errors, masked previously by the `rbxts-harness` dist-as-ambient mount) is what forced the separate native runtime.
   3. **Done**: `apps/package-consumption-harness` compiles to Luau end-to-end. Its tsconfig aliases the Roblox `aruna/*` subpaths to the vendored runtime, and `default.project.json` maps the full `out` tree. `pnpm test` and `pnpm typecheck` are fully green; `rbxts-harness` is unaffected (still uses the dist-mount model).

   Remaining follow-ups for this workstream:
   - Automate the `aruna/*` → vendored-runtime tsconfig aliases in `aruna doctor --fix` (the harness currently commits them by hand).
   - Bring the native runtime to parity with the Node runtime: rate-limit enforcement, serialization boundary policy, fuller schema surface.
   - Add a dedicated roblox-ts typecheck/CI gate for `packages/aruna/roblox/` so native-runtime regressions are caught without going through a harness build.
   - Re-run `pnpm verify:package-consumption` (packed-tarball smoke) and confirm the vendored-runtime path also closes the packed case.
2. Then create-app planning document or thin create-app RFC.
3. Thin inspect authority.
4. Then defineResource / resource invalidation design.
5. Resource implementation later.
