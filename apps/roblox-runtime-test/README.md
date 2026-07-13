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

What happens:

1. `packages/aruna/roblox/*.ts` is staged into `src/runtime/` (gitignored).
2. `rbxtsc` compiles it to Luau in `out/runtime/`.
3. Lune runs `lune/run.luau`, which loads the compiled modules and runs the specs.

Lune is pinned in the repo-root `rokit.toml`; install it with `rokit install`.
If Lune is not on `PATH`, the harness still compiles the runtime (proving it
builds) and skips execution with a notice, so CI without the Roblox toolchain
stays green.

## How the Lune loader works

The real roblox-ts `RuntimeLib` resolves imports through the Roblox Instance tree
(`require` on `ModuleScript`s), which Lune cannot do. Instead `lune/loader.luau`
provides a minimal `TS` shim:

- `TS.import` resolves sibling modules by base name, searching one or more
  compiled output directories in order (see below).
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
