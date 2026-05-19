# Aruna Spec Alignment

## Current status

Aruna is aligned with the compiler-first direction of the RFC, but the implementation has started to drift toward transport and harness convenience before the core MVP contract is finished.

`apps/rbxts-harness` now intentionally mirrors Recommended Layout v0 closely enough to serve as the realistic starter/reference harness, while still remaining harness metadata rather than generated Rojo output or create-app scaffolding.

## Aligned with Notion spec

| Area | Status | Notes |
| --- | --- | --- |
| Rust-owned compiler core | Keep | Compiler discovery, graphing, diagnostics, and manifest generation are Rust-owned. |
| No TypeScript analyzer fallback | Keep | Native compiler loading is the only path. |
| Action discovery | Keep | Server action discovery and manifest emission exist. |
| Generated stubs | Keep | Client/server action stubs are generated and snapshot-tested. |
| Schema runtime validation | Keep | Action input/output validation runs at dispatch time. |
| Virtual generated imports | Keep | `$aruna/actions/client` and `$aruna/actions/server` are supported. |
| `rbxts` harness | Keep | The harness validates generated output, typecheck, and `rbxtsc`. |
| Recommended layout harness shape | Keep | `apps/rbxts-harness` mirrors the recommended app/domain/shared layout closely enough for starter/reference use. |

## Ahead-of-scope but retained

| Area | Status | Notes |
| --- | --- | --- |
| Default Roblox `RemoteEvent` binding helper | Retain | Useful for current harness/tests, but do not expand. |
| Structural `RemoteFunction` transport | Retain | Exists as a test/future integration foundation only. |
| Structural `RemoteEvent` transport | Retain | Exists as a test/future integration foundation only. |
| Harness `default.project.json` | Retain | Manual harness metadata only, not generated Rojo integration. |
| Mixed bootstrap wiring | Temporary workaround | The harness keeps `src/app/bootstrap.ts` as a shared shim and uses `src/app/client-runtime.ts` / `src/app/server-runtime.ts` for the actual environment-specific wiring because the current compiler classifies the mixed bootstrap as unknown. |
| `aruna doctor --fix` path alias management | Retain | Keep the minimal alias setup; do not broaden into more config automation yet. |

## Drift / gaps

| Area | Status | Notes |
| --- | --- | --- |
| README framing | Needs correction | It should not read as if transport/harness work is the product endpoint. |
| Config shape | Needs correction | Current projects use flat `generatedDir` and `manifest.output`; nested `compiler.*` config is not yet supported. |
| Recommended layout starter harness | In progress | The rbxts harness now mirrors the recommended layout, but create-app and generated Rojo remain deferred. |
| Serialization boundary policy | Missing | No default rejection of `Instance`, `Player`, function, or thread-like values yet. |
| Basic action rate limit | Missing | No per-player/action limiter or stable rate-limit error shape yet. |
| Inspect actions | Missing | No action inventory / schema summary / transport metadata inspection layer yet. |
| Authority visibility | Missing | No inspectable authority flow, policy metadata, or manifest-driven contract view yet. |

## Correct MVP cutline

1. Stabilize current action runtime, compiler, and harness behavior.
2. Serialization boundary policy:
   - reject `Instance`, `Player`, function, and thread-like values across action input/output by default
   - emit manifest metadata and diagnostics
3. Basic action rate limit:
   - action metadata parsing
   - manifest output
   - runtime per-player/action limiter
   - stable error shape
4. Inspect actions:
   - list client-callable actions
   - input/output schema summary
   - transport info
   - rate limit info
   - serialization warnings
5. Contract snapshot foundation:
   - stable JSON snapshot of actions, schemas, and rate limits
   - diffing can be deferred

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

1. Stabilize current action runtime/compiler/harness behavior.
2. Add serialization boundary policy and diagnostics.
3. Add basic action rate limiting and manifest support.
4. Add inspect actions for actions, schemas, transport, and rate limits.
5. Add the contract snapshot foundation.
