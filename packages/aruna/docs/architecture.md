# Architecture

This page covers the model an agent needs to avoid the non-obvious traps: how files are
classified, what the compiler generates, how the build maps onto Roblox, and the
two-runtime story.

## Module boundaries (client / server / shared)

Every source file is classified as **client**, **server**, or **shared** by path
convention (default globs `**/client/**`, `**/server/**`, `**/shared/**`, plus well-known
entry filenames like `server.ts` and `client.tsx`). Classification drives two things:

1. **Where generated code and compiled output go** (the partition, below).
2. **What may import what.** Shared and client code may not pull in server-only
   modules. This boundary is always checked; no `strict` option turns it off. Putting
   `createServerApp`, `bindActions`, or an action's `run` body somewhere client-reachable
   is a boundary violation the compiler reports — it would otherwise replicate server
   logic to every player.

Rule: action `run` implementations and server registration live in server-classified
files. Schemas and pure helpers live in `shared`. UI and `invokeAction` calls live in
client.

An import TypeScript erases (`import type`, or bindings only used as types) never loads
its module, so it crosses no boundary. Beyond each import, `strict.sharedSafety` checks
what a shared module reaches through other shared modules (`aruna::306`/`307`) and the
server-only services it reads (`aruna::308`/`309`); see
[shared-safety.md](shared-safety.md), including what a static check cannot see.

Every file-name convention also covers its folder form — `**/actions.ts` classifies
`**/actions/**`, `**/ui.tsx` classifies `**/ui/**` — so a concern that outgrew one file
splits into a folder without a config change. Definitions are found by their
`defineAction`/`defineSignal`/`defineStore`/`defineRuntime`/`defineResource` call, not by
file name, so they can live in any file on the right side of the boundary (a file that
calls `defineResource` is server code). Ranking, strongest first:
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
| `$aruna/signals` | `shared/signals.generated.ts` | `signals` registry, `Signals`, payload aliases |
| `$aruna/resources/server` | `server/resources.server.generated.ts` (server-only) | `resources` registry |
| `$aruna/resources/client` | `shared/resources.client.generated.ts` | one typed binding per resource, `Resources`, value aliases |

The `aruna/server`, `aruna/client`, `aruna/roblox`, `aruna/schema` specifiers are also
path aliases (written by `build` / `doctor --fix`) pointing at the runtime copied into
`shared/runtime/`. Without the aliases they resolve to the package's declarations of the
same runtime. The server
registry is emitted under `server/` so it is server-classified; stubs, signals, and the
runtime are `shared/`.

### Generated entries (`entries: "generated"`)

With `entries: "user"` (the default) your `src/server.ts` and `src/client.tsx` are the
Script and LocalScript, and you call `createServerApp` / `createClientApp` yourself. With
`entries: "generated"` in `aruna.config.ts`, `aruna build` writes the entries instead:
`server/main.server.ts` creates the server app from the generated registries (actions,
`defaultRateLimit`, signals, resources, domain runtimes) with the RemoteEvent transport,
and `client/main.client.ts` creates the client app. Your `src/server.ts` and
`src/client.tsx`, when present, become **hook modules** the generated entries import.
They export only these names; any other export is `aruna::568 unknown-hook-export`
(warning), because nothing would ever read it:

| Module | Export | What the generated entry does with it |
| --- | --- | --- |
| `src/server.ts` | `middleware` | passes it to `createServerApp({ middleware })` |
| | `onError` | passes it to `createServerApp({ onError })` |
| | `configure(app)` | calls it with the created server app |
| `src/client.tsx` | `createRequestId` | passes it to `createActionInvoker({ createRequestId })` |
| | `onStart(app)` | calls it with the created client app |

## The partition (Roblox DataModel mapping)

`aruna build` partitions the compiled output into client / server / shared subtrees by
classification, and emits a service-separated `default.project.json`. This is what keeps
**server code in `ServerScriptService`** (not replicated to clients) while shared code
goes to `ReplicatedStorage`. The default Rojo project file is the contract for that
layout — if you hand-edit it, keep the service separation.

## The runtime

There is one runtime: the roblox-ts native one in `roblox/`, which compiles to Luau and
runs in-game. `aruna build` vendors it into
`shared/runtime/`, and the game compiles that copy. The package does not run it under
Node: the `aruna/*` runtime subpaths are type-only, and their declarations
(`dist/native/`) are emitted from the same source, so a project gets the same types with
or without the doctor aliases. The root `aruna` entry — `defineConfig` and the compiler —
is the only part that runs under Node.

Its behavior is tested by executing it: `apps/roblox-runtime-test` compiles it with
`rbxtsc` and runs it under Lune, through hand-written Luau specs, the dispatch
conformance table, and TypeScript specs run by the same runner `aruna test` ships.

The binary codec — schema-driven `encodeBinary`/`decodeBinary`, exported from
`aruna/schema` — packs into a Luau `buffer`, with numeric width hints (u8..f32) and
userdata kinds (vector3/color3/cframe encoded as f32 components).

## Transport

One multiplexed RemoteEvent, `ReplicatedStorage/ArunaRemoteEvent`, carries action calls
to the server and, back to each player, one ordered stream of action responses (keyed by
request id) and reliable signals: every item names its kind, and a player reads them in
the order the server produced them. `createActionInvoker()` / `createSignalSubscriber()`
(client) and `robloxRemoteEvent()` / `createSignalPublisher()` (server) share that remote's
channel — in the normal flow `createClientApp()` / `createServerApp()` own the wiring.
Resource state travels the same ordered stream (item kind 4), and resource subscriptions
travel with calls (kind 5), admitted like a call. Unreliable signals use their own
`UnreliableRemoteEvent`. There is no transport to select: the RemoteEvent transport is
the transport ([wire protocol](../../../docs/wire-protocol.md)).

## Observing it

Static policy comes from the contract (`aruna inspect network|actions|signals|resources`);
runtime traffic from `createNetworkMetrics()`, opt-in and bounded; refusals from
`onAbuse` (before dispatch) and `onReject` (after). See
[observability.md](observability.md).

## Common traps

- **Only `build` regenerates.** `check` validates but won't refresh stubs — stale client
  contracts come from running only `check` after a change.
- **`ctx.player` is always present** on a real dispatch. Import `defineAction` from
  `aruna/roblox` so it is typed `Player` instead of `unknown`.
- **Don't put server logic in shared/client files.** It's a boundary violation and would
  replicate server code.
- **Aliases unresolved?** Run `aruna doctor --fix` to repair the tsconfig path aliases.
- **`.aruna/` is generated.** Don't hand-edit it; rebuild instead.
