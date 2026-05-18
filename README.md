# aruna

Aruna is a compiler-first Roblox framework for server-authoritative games.

The model is intentionally closer to Svelte-style compile-time transforms than to a heavy OOP framework. Classes are allowed. Services are not the framework model. Actions are.

Aruna owns boundaries, actions, generated output, and diagnostics. Users own domain taxonomy.

## Recommended Layout v0

This is the recommended project shape for starters, examples, docs, and MVP fixtures:

```text
src/
  client.tsx
  server.ts

  app/
    bootstrap.ts
    providers.ts

  domains/
    shop/
      actions.ts
      schema.ts
      model.ts
      ui.tsx

    inventory/
      actions.ts
      schema.ts
      model.ts
      ui.tsx

    combat/
      model.ts
      runtime.ts

    waves/
      actions.ts
      schema.ts
      model.ts
      runtime.ts

  shared/
    constants.ts
    ids.ts
    result.ts

  .aruna/
    actions.client.generated.ts
    actions.server.generated.ts
    manifest.json
```

Policy notes:

- `src/client.ts` and `src/client.tsx` are default client entries.
- `src/server.ts` and `src/server.tsx` are default server entries.
- `domains/` is a recommended organization pattern, not a boundary kind.
- `shared/` is reserved for cross-domain shared-safe code.
- `.aruna/` is generated output and can be deleted and regenerated safely.
- Do not require every client-only or server-only module to use `.client.ts` or `.server.ts`.
- Reserve `.client` and `.server` suffixes for explicit runtime entry hints, not broad folder conventions.

## Phase 1 scope

- project config loading from `aruna.config.ts`
- Rust-owned compiler core in `crates/aruna_compiler` and N-API binding in `crates/aruna_napi`
- TypeScript CLI and package wrappers
- source discovery, entry classification, module classification, import graph construction, action discovery, boundary validation, diagnostics, and manifest generation in Rust
- deterministic compiler output
- `aruna check`
- `aruna inspect`
- running `aruna` with no subcommand aliases to `aruna check`
- fixture-based tests without Roblox Studio
- `packages/compiler` loads the Rust native compiler
- no TypeScript analyzer fallback

## Native compiler preflight

Phase 1 requires the Rust native compiler. Build it before running the CLI or the test suite:

```bash
pnpm build:native
```

Phase 1 prepares native packages through generated `.npm/` staging directories.

Raw Cargo artifacts are written under `target/**` and may be named `libaruna_napi.dylib`, `libaruna_napi.so`, `aruna_napi.dll`, or `aruna_napi.node` depending on platform and profile.

`pnpm build:native` builds and stages the current host native package only. It always produces `.npm/compiler-<target>/compiler.<target>.node` and `.npm/compiler-<target>/package.json` when the Rust build succeeds. If `packages/compiler/dist` is missing, wrapper staging is skipped with a clear message instead of failing the native build.

`pnpm --filter @arunajs/compiler verify:native` checks the staged native package for the current host target and fails if the `.npm/compiler-<target>/` artifact is missing or malformed.

The wrapper package under `.npm/compiler/` is reserved for release packaging or for runs after the TypeScript build has produced `packages/compiler/dist`.

`pnpm release:prepare` is the release orchestrator entrypoint:

```bash
pnpm release:prepare --mode local
pnpm release:pack --mode local
pnpm release:publish --mode local --dry-run

pnpm release:prepare --mode cross --targets linux-x64-gnu --zig auto
pnpm release:prepare --mode cross --targets linux-x64-gnu --zig always
pnpm release:prepare --mode cross --targets linux-x64-gnu --zig never
pnpm release:prepare --mode cross --targets linux-x64-gnu --allow-missing-tools

pnpm release:pack --mode cross --targets linux-x64-gnu --zig auto
```

Local mode builds the current host target only and uses `cargo` by default. Cross mode evaluates each requested target independently:

- `--zig auto` uses `cargo` for the host target and `cargo zigbuild` for Linux cross targets when `cargo-zigbuild` and `zig` are available.
- `--zig always` requires `cargo-zigbuild` for Linux cross targets.
- `--zig never` never calls `cargo zigbuild` and fails for targets that need it.
- Missing `cargo-zigbuild` or `zig` fails by default.
- `--allow-missing-tools` skips requested cross targets when the required tools are unavailable.

Skipped targets are not staged, are not added to `.npm/compiler/package.json` `optionalDependencies`, and never produce fake platform packages.

Full mode is reserved for CI/public release validation and builds every target that the current host can actually stage with the selected tools.
Unsupported cross targets are not faked or substituted.

Staged native artifacts use target-qualified names such as `compiler.darwin-arm64.node` and are copied from the real Rust output only.

Packages are staged under `.npm/`, then packed and published from `.npm/` rather than `packages/*`.
The generated `.npm/` output is ignored by git and can be regenerated at any time.

Aruna never fakes platform support by renaming a binary built for another target or by staging placeholder packages for skipped targets.

Packaging automation is TypeScript-based and executed with `tsx`.

Common CLI checks:

```bash
pnpm aruna check --project fixtures/valid-client-imports-shared/input
pnpm aruna check --project fixtures/invalid-client-imports-server/input
pnpm aruna inspect modules --project fixtures/feature-local-layout/input
pnpm aruna inspect graph --project fixtures/invalid-client-imports-server/input
pnpm aruna check --json --project fixtures/invalid-client-imports-server/input
pnpm aruna check --no-color --project fixtures/invalid-client-imports-server/input
pnpm aruna build --project fixtures/action-generated-output/input
pnpm aruna doctor --project apps/rbxts-harness
pnpm aruna doctor --fix --project apps/rbxts-harness
```

`packages/compiler` loads the native Rust compiler directly. There is no TypeScript analyzer fallback in Phase 1.

Future Linux cross-compiles use real `cargo zigbuild --target x86_64-unknown-linux-gnu`, `cargo zigbuild --target aarch64-unknown-linux-gnu`, `cargo zigbuild --target x86_64-unknown-linux-musl`, and `cargo zigbuild --target aarch64-unknown-linux-musl` builds instead of staged fake packages.

## Generated action foundation

- server action discovery exists in Rust
- action manifest records now include basic schema metadata when `input` or `output` is declared
- generated action files are snapshot-tested in the fixture suite
- application code should import generated actions through `$aruna/actions/client` and `$aruna/actions/server`
- `aruna build` writes deterministic `src/.aruna/actions.client.generated.ts` and `src/.aruna/actions.server.generated.ts`
- generated client stubs are typed from schema metadata where the metadata is supported
- generated client stubs now connect to a minimal action runtime contract
- an in-memory action invoker exists for non-Roblox tests
- thin client/server app bootstrap helpers at `aruna/client` and `aruna/server-app` wire the runtime invoker and server action registry
- the bootstrap helpers are functional, disposable, and intentionally do not scan modules or register services
- a structural Roblox `RemoteFunction` action transport adapter exists for tests and future Studio integration
- a structural Roblox `RemoteEvent` request/response transport adapter exists for tests and future Studio integration
- `packages/aruna` is organized internally into `cli/`, `runtime/`, `actions/`, and `schema/` implementations
- the public subpath exports remain stable through top-level compatibility shims
- `@rbxts/types` and `@rbxts/compiler-types` are used at typecheck time for Roblox-facing runtime types
- runtime schema validation now runs on action input and output at dispatch time
- the MVP schema helpers support string, number, boolean, and undefined literal values, plus array, object, optional, and enum validation
- the schema DSL now has TypeScript inference for primitives, literals, arrays, objects, optionals, and enums
- the generated files are safe to delete and regenerate
- structural runtime remoting transport exists for tests and future integration; generated Roblox Instances, Rojo integration, create-app, and full Studio validation remain deferred

### Generated action imports

Application code should import generated action APIs through Aruna virtual modules:

```ts
import { purchaseItem } from "$aruna/actions/client";
import { actions } from "$aruna/actions/server";
```

Do not import the physical `../.aruna/*.generated` files directly in app code.
Aruna owns the physical files under `src/.aruna/`.
`aruna check` resolves these virtual modules without writing files.
`aruna build` writes the physical generated files used by TypeScript and roblox-ts tooling.
For TypeScript and roblox-ts tooling, run `aruna doctor --fix` once to install the required tsconfig path aliases.

## Real app harness

`apps/rbxts-harness` is a private roblox-ts-style app harness.
It runs `aruna build` against a real app layout, then validates the harness with both TypeScript and `rbxtsc`.
Use `pnpm --filter @arunajs/rbxts-harness typecheck` for the TypeScript check and `pnpm --filter @arunajs/rbxts-harness rbxtsc` for the roblox-ts compile.
The harness covers generated action files, app bootstrap, schema inference, structural RemoteEvent transport, and public Aruna runtime imports.
It is not create-app, Rojo generation, generated Roblox Instance creation, or full Studio validation yet.

## Intentionally not implemented

- full runtime remoting transport
- full schema compiler
- remote/action codegen
- generated Roblox Instance creation and Rojo integration
- LSP
- VSCode extension
- create-app scaffolding
- plugin API
- custom Luau emitter
- full roblox-ts build orchestration
