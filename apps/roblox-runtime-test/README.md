# @arunajs/roblox-runtime-test

Runtime **execution** tests for the roblox-ts-native runtime (`packages/aruna/roblox`).

The rest of the suite only *compiles* the native runtime to Luau (`rbxtsc`) and
type-checks it. This harness goes one step further: it compiles the runtime and
then **runs** the compiled Luau under [Lune](https://lune-org.github.io/docs),
exercising real behavior — schema validation, the `plain-data-v1` serialization
boundary, the fixed-window rate limiter, server dispatch, and the default
`RemoteEvent` transport (a full client → server → client round trip plus request
timeouts).

## Run it

```sh
pnpm --filter @arunajs/roblox-runtime-test test
```

What happens, in a fresh temp directory per run (so runs never collide and nothing
is written into this package):

1. `packages/aruna/roblox/*.ts` is staged where a consumer's vendored runtime
   lives (`src/shared/aruna/runtime/`), next to the TypeScript specs from
   `src/test/`.
2. `rbxtsc` compiles both to Luau.
3. Lune runs `lune/run.luau`: the hand-written Luau specs in `lune/specs/`
   against the compiled runtime, including `lune/specs/conformance.luau`, which
   runs the dispatch case table in `conformance/dispatch.json`.
4. Lune runs the TypeScript specs through `packages/aruna/lune/run.luau` — the
   runner `aruna test` ships — so they execute the way a game project's specs do.

There is one runtime, so this is where its behavior is tested. Specs in
`src/test/*.spec.ts` import it the way a game does (`aruna/server`,
`aruna/testing`, …; `aruna/internal/<module>` reaches a module no subpath
exports) and use the `describe` / `it` / `expect` that `aruna/testing` ships.
Most of them were ported from the retired Node runtime's vitest suites; the
case-by-case mapping is in `docs/runtime-consolidation.md`.

Flags: `--spec <text>` stages only the TypeScript specs whose file name contains
`<text>` (repeatable), `--ts-only` skips the Luau specs, and `--keep` keeps the
temp project and prints its path.

This package's `turbo.json` lists the native runtime sources and the shipped
Lune runner as test inputs, because the package doesn't depend on `aruna` and
turbo would otherwise replay a stale pass.

Lune is pinned in the repo-root `rokit.toml`; install it with `rokit install`.
If Lune is not on `PATH`, the harness still compiles the runtime and specs
(proving they build) and skips execution with a loud notice. Under CI (`CI`
set) a missing Lune fails the run instead: a skip there would report a pass for
tests that never ran.

## How the Lune loader works

This section is about the Luau specs' loader. (The TypeScript specs use the
shipped `packages/aruna/lune/loader.luau`, which rebuilds the Instance tree and
loads the real `RuntimeLib`.) The real roblox-ts `RuntimeLib` resolves imports
through the Roblox Instance tree (`require` on `ModuleScript`s), which Lune
cannot do. Instead `lune/loader.luau` provides a minimal `TS` shim:

- `TS.import` resolves sibling modules by base name, searching one or more
  compiled output directories in order (see below).
- The `require(ReplicatedStorage.rbxts_include.RuntimeLib)` every module opens
  with is served by that shim.
- `TS.Promise` is the real roblox-ts `Promise` library, loaded standalone.
- Roblox globals the runtime touches (`task`, `typeIs`, `game`, `Instance`) are
  injected per module; `lune/fakes.luau` supplies an in-process `RemoteEvent` so
  a client invoker and a server binding sharing the instance complete a real
  round trip.

## Testing a consumer repo's own action modules

This harness only exercises `packages/aruna/roblox` itself. A game repo that
consumes aruna (e.g. via `--project` cross-repo, per the dogfooding report) hits
three barriers trying to unit-test its own compiled action modules under plain
Node: unresolved extensionless/`baseUrl` imports, tsconfig aliases pointing at
Luau-dialect vendored runtime (`pairs`/`typeIs`), and Luau globals in the action
body (`math.clamp`, `os.clock`, `HttpService`, ...). Loading the *compiled Luau*
under Lune sidesteps all three, the same way this harness does for the runtime
itself.

`makeLoader` (`lune/loader.luau`) accepts either a single compiled-output
directory or an ordered list of them:

```lua
local makeLoader = require("./loader")
-- Search the vendored runtime output first, then the consumer's own compiled
-- action modules. Base names must be unique across every dir in the list.
local loader = makeLoader({ "out/runtime", "out/actions" }, promisePath, fakes)

local spray = loader.load("spray") -- a consumer action module, not part of aruna
```

To adopt this pattern in a consumer repo: compile your action modules with
`rbxtsc` to a flat-ish output dir (nested paths are fine as long as filenames
don't collide, since resolution is by base name only), point a copy of this
`lune/` harness (loader + fakes + framework) at `{vendoredRuntimeDir,
yourActionsDir}`, then `loader.load("yourActionModule")` and call its exported
`run(ctx, input)` directly against a hand-built `ActionContext` (player, and
`ctx.publisher` if the action publishes signals) — no transport or RemoteEvent
required. There is currently no packaged/`pnpm add`-able version of this
harness; copy `lune/loader.luau`, `lune/fakes.luau`, and `lune/framework.luau`
into the consumer repo until one exists.
