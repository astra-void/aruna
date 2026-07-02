# Package Consumption Notes

Aruna has two package-consumption checks today:

- `apps/package-consumption-harness` validates the package-style consumption shape against the workspace-linked package.
- `pnpm verify:package-consumption` builds local tarballs and installs them in a standalone consumer outside the monorepo source layout.

Both compile a consumer to Luau end-to-end, including the Roblox-facing runtime.

## Final package-consumption model

Roblox-facing code is consumed through a **vendored runtime**, not through direct `node_modules` package imports of Roblox modules:

- The roblox-ts-native runtime lives at `packages/aruna/roblox/` and is separate from the Node reference runtime under `packages/aruna/src` (which vitest validates). It is intentionally thin: schema (`string`/`number`/`boolean`/`object`/`array`/`optional`/`literal`/`enum`/`union`), `defineAction`, client `invokeAction`, server dispatch, a default `RemoteEvent` action transport, and `plain-data-v1` serialization plus fixed-window rate-limit enforcement in dispatch.
- The native runtime ships in the published package via `files`.
- `aruna build --emit-runtime` vendors that runtime into the consumer as project source under `<generatedDir>/runtime/` (e.g. `src/.aruna/runtime/`).
- `aruna doctor --fix --emit-runtime` installs the `aruna/*` → vendored-runtime tsconfig `paths` aliases that pair with `build --emit-runtime`.
- `default.project.json` maps the full `out` tree, so `rbxtsc` compiles the whole consumer project — including the vendored runtime — to Luau.

Consumers import `defineConfig` from the root package for config only, and use the runtime-safe public subpaths (`aruna/server`, `aruna/client`, `aruna/roblox`, `aruna/schema`) for Roblox-facing code; those subpaths resolve to the vendored runtime through the aliases.

`aruna init` scaffolds a turnkey project for this model (`aruna.config.ts`, a roblox-ts `tsconfig.json` with the action + runtime aliases and `@rbxts` typeRoots, and a full-`out` `default.project.json`). A scaffolded project plus an action compiles to Luau via `aruna build --emit-runtime` then `rbxtsc` with no hand-editing.

## What is now validated

- The packed smoke installs local tarballs for `aruna`, `@arunajs/core`, and `@arunajs/compiler` without contacting the npm registry.
- `aruna doctor --fix --emit-runtime`, `aruna check`, `aruna build --emit-runtime`, `aruna inspect actions`, `aruna inspect contract --json`, and `aruna contract diff` run against the package-style layout.
- `aruna build --emit-runtime` generates the `src/.aruna` action files and vendors the native runtime.
- The consumer passes TypeScript (`tsc --noEmit`).
- The consumer compiles to Luau with `rbxtsc`, including the vendored runtime — the earlier "modules directly under node_modules" rejection no longer occurs.

This is package-layout and `rbxtsc` compile validation. It is **not** production Studio validation, and the structural `RemoteEvent`/`RemoteFunction` adapters are not production-complete.

## Remaining follow-ups

- Production Studio validation, which remains later work.

Native-runtime *runtime* execution is now covered: `apps/roblox-runtime-test` compiles
`packages/aruna/roblox/` to Luau with rbxtsc and executes it under Lune against
in-process RemoteEvent fakes (`pnpm --filter @arunajs/roblox-runtime-test test`) —
dispatch, serialization, rate limiting, and the action/signal transports run for real,
not just compile.

## Historical context

Earlier, the packed smoke failed at `rbxtsc` with a package-layout boundary: roblox-ts rejected direct `node_modules` package modules for `aruna/server` and `aruna/schema`, and the temporary Rojo tree did not cover emitted files such as `out/domains/shop/model.luau`. The investigation also surfaced that the Node reference runtime is not roblox-ts-compatible (Node idioms, ~71 `rbxtsc` errors that had been masked by the `rbxts-harness` dist-as-ambient mount). Both findings are what drove the separate roblox-ts-native runtime and the vendored-runtime model documented above; the blocker is now closed.
