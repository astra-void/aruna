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

- `TS.import` resolves sibling modules by base name from the compiled output dir.
- `TS.Promise` is the real roblox-ts `Promise` library, loaded standalone.
- Roblox globals the runtime touches (`task`, `typeIs`, `game`, `Instance`) are
  injected per module; `lune/fakes.luau` supplies an in-process `RemoteEvent` so
  a client invoker and a server binding sharing the instance complete a real
  round trip.
