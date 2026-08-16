# Architecture

This page covers the model an agent needs to avoid the non-obvious traps: how files are
classified, what the compiler generates, how the build maps onto Roblox, and the
two-runtime story.

## Module boundaries (client / server / shared)

Every source file is classified as **client**, **server**, or **shared** by path
convention (default globs `**/client/**`, `**/server/**`, `**/shared/**`, plus well-known
entry filenames like `server.ts` and `client.tsx`). Classification drives two things:

1. **Where generated code and compiled output go** (the partition, below).
2. **What may import what.** With `strict.sharedSafety` on (default), shared and client
   code may not pull in server-only modules. Putting `createServerApp`, `bindActions`, or
   an action's `run` body somewhere client-reachable is a boundary violation the compiler
   reports — it would otherwise replicate server logic to every player.

Rule: action `run` implementations and server registration live in server-classified
files. Schemas and pure helpers live in `shared`. UI and `invokeAction` calls live in
client.

Every file-name convention also covers its folder form — `**/actions.ts` classifies
`**/actions/**`, `**/ui.tsx` classifies `**/ui/**` — so a concern that outgrew one file
splits into a folder without a config change. Definitions are found by their
`defineAction`/`defineSignal`/`defineStore`/`defineRuntime` call, not by file name, so
they can live in any file on the right side of the boundary. Ranking, strongest first:
a directory glob (`**/server/**`), the derived concern folder (`**/actions/**`), then the
file name. `src/shared/actions/util.ts` is therefore shared, not server.

## Domain boundaries (domain to domain)

A **domain** is one directory below `domains/` (`domains.roots` in aruna.config.ts adds
more roots). Its `client/` and `server/` subtrees are private to it; what other domains
may import is everything else at the domain root — or, once the domain has an
`index.ts`, exactly that barrel. An import that reaches past this surface reports
`aruna::304 cross-domain-private-import` (`strict.domainBoundary`: `warning` by default,
`error` to fail the build, `off` to disable).

Imports inside a single domain are unrestricted, and app-shell code (`src/client/**`,
`<root>/app/**`, the entry files) may boot a domain's own client and server modules —
the rule only governs domain-to-domain edges.

Rule: cross-domain reuse goes through the other domain's public surface (its model,
schema, signals, or barrel), or through an action or signal. Not through its internals.

## Generated modules

`aruna build` writes into the generated dir (default `src/.aruna/`, treat it as
build output — don't edit, safe to delete and rebuild) and exposes them through tsconfig
path aliases:

| Alias | Generated file | Exports |
| --- | --- | --- |
| `$aruna/actions/server` | `server/actions.server.generated.ts` (server-only) | `actions` registry, `defaultRateLimit` |
| `$aruna/actions/client` | `shared/actions.client.generated.ts` | one typed call fn per action |
| `$aruna/signals` | `shared/signals.generated.ts` | `signals` registry + payload aliases |

The `aruna/server`, `aruna/client`, `aruna/roblox`, `aruna/schema` specifiers are also
path aliases (written by `build` / `doctor --fix`) pointing at the runtime — either the
npm package or, after vendoring, the runtime copied into `shared/runtime/`. The server
registry is emitted under `server/` so it is server-classified; stubs, signals, and the
runtime are `shared/`.

## The partition (Roblox DataModel mapping)

`aruna build` partitions the compiled output into client / server / shared subtrees by
classification, and emits a service-separated `default.project.json`. This is what keeps
**server code in `ServerScriptService`** (not replicated to clients) while shared code
goes to `ReplicatedStorage`. The default Rojo project file is the contract for that
layout — if you hand-edit it, keep the service separation.

## The dual runtime

There are two implementations of the runtime, and you should know which you are editing or
reasoning about:

- **Node reference runtime** — plain TypeScript, used for unit tests and as the source of
  truth for behavior.
- **roblox-ts native runtime** — the version that compiles to Luau and runs in-game,
  vendored into `shared/runtime/` by `aruna build --emit-runtime` (the default).

The two are kept behaviorally identical. The binary codec in particular is designed to be
**byte-identical across both runtimes**: schema-driven `encodeBinary`/`decodeBinary`
(exported from the package root) with numeric width hints (u8..f32) and userdata kinds
(vector3/color3/cframe encoded as f32 components). Userdata that travels as plain records
in Node is reconstructed as native `Vector3`/`Color3`/`CFrame` in Roblox.

## Transport

Actions use a single multiplexed RemoteEvent: `ReplicatedStorage/ArunaActionRemoteEvent`
carries request/response pairs keyed by request id. `createActionInvoker()` (client) and
`bindActions()` (server) wire this up for you — in the normal flow `createClientApp()` /
`createServerApp()` own that wiring. Signals travel over their own dedicated
`ReplicatedStorage/ArunaSignalRemoteEvent` via the turnkey `createSignalPublisher` /
`createSignalSubscriber` helpers. There is no transport to select: the RemoteEvent
transport is the transport.

## Common traps

- **Only `build` regenerates.** `check` validates but won't refresh stubs — stale client
  contracts come from running only `check` after a change.
- **`ctx.player` is always present** on a real dispatch. Import `defineAction` from
  `aruna/roblox` so it is typed `Player` instead of `unknown`.
- **Don't put server logic in shared/client files.** It's a boundary violation and would
  replicate server code.
- **Aliases unresolved?** Run `aruna doctor --fix` to repair the tsconfig path aliases.
- **`.aruna/` is generated.** Don't hand-edit it; rebuild instead.
