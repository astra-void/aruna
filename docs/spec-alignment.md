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
| Serialization boundary policy | Keep | Runtime now enforces the default `plain-data-v1` action boundary and rejects non-wire-safe input/output values. |
| Basic action rate limit | Keep | Manifest-visible fixed-window rate limits are parsed and enforced per action and player/key. |
| Virtual generated imports | Keep | `$aruna/actions/client` and `$aruna/actions/server` are supported. |
| `rbxts` harness | Keep | The harness validates generated output, typecheck, and `rbxtsc`. |
| Recommended layout harness shape | Keep | `apps/rbxts-harness` mirrors the recommended app/domain/shared layout and conventional Roblox service tree closely enough for starter/reference use. |

## Ahead-of-scope but retained

| Area | Status | Notes |
| --- | --- | --- |
| Default Roblox `RemoteEvent` binding helper | Retain | Useful for current harness/tests, but do not expand. |
| Structural `RemoteFunction` transport | Retain | Exists as a test/future integration foundation only. |
| Structural `RemoteEvent` transport | Retain | Exists as a test/future integration foundation only. |
| Harness `default.project.json` | Retain | Manual harness metadata only, with a conventional Roblox service tree and `rbxts_include` package mounting rather than generated Rojo integration. |
| Shared-safe app wiring | Keep | The harness now wires client/server behavior from `src/client.tsx` and `src/server.ts` directly, while `src/app/bootstrap.ts` and `src/app/providers.ts` stay shared-safe helpers instead of hidden runtime entry files. |
| `aruna doctor --fix` path alias management | Retain | Keep the minimal alias setup; do not broaden into more config automation yet. |
| Basic action rate limit | Retain | The fixed-window runtime limiter exists, but it is not a full anti-abuse or policy system. |

## Drift / gaps

| Area | Status | Notes |
| --- | --- | --- |
| README framing | Needs correction | It should not read as if transport/harness work is the product endpoint. |
| Config shape | Needs correction | Current projects use flat `generatedDir` and `manifest.output`; nested `compiler.*` config is not yet supported. |
| Recommended layout starter harness | In progress | The rbxts harness now mirrors the recommended layout, but create-app and generated Rojo remain deferred. |
| Inspect actions | Missing | No action inventory / schema summary / transport metadata inspection layer yet. |
| Authority visibility | Missing | No inspectable authority flow, policy metadata, or manifest-driven contract view yet. |

## Correct MVP cutline

1. Stabilize current action runtime, compiler, and harness behavior.
2. Serialization boundary policy:
   - runtime enforces the default `plain-data-v1` boundary
   - reject `Instance`, `Player`, function, class-instance, cyclic, non-finite, and other non-plain values across action input/output by default
   - manifest records include serialization policy metadata
   - static diagnostics remain limited for now
3. Inspect actions:
   - list client-callable actions
   - input/output schema summary
   - transport info
   - rate limit info
   - serialization warnings
4. Contract snapshot foundation:
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
3. Add inspect actions for actions, schemas, transport, and rate limits.
4. Add the contract snapshot foundation.
