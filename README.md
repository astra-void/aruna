# aruna

Aruna Phase 1 is a monorepo and compiler MVP focused on static boundary checks for rbxts projects.

## Phase 1 scope

- project config loading from `aruna.config.ts`
- Rust-owned compiler core in `crates/aruna_compiler` and N-API binding in `crates/aruna_napi`
- TypeScript CLI and package wrappers
- source discovery, module classification, import graph construction, boundary validation, diagnostics, and manifest generation in Rust
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

`pnpm build:native` builds and stages the current host target only.

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
```

`packages/compiler` loads the native Rust compiler directly. There is no TypeScript analyzer fallback in Phase 1.

Future Linux cross-compiles use real `cargo zigbuild --target x86_64-unknown-linux-gnu`, `cargo zigbuild --target aarch64-unknown-linux-gnu`, `cargo zigbuild --target x86_64-unknown-linux-musl`, and `cargo zigbuild --target aarch64-unknown-linux-musl` builds instead of staged fake packages.

## Intentionally not implemented

- typed remotes
- server actions
- runtime schema DSL
- remote/action codegen
- Roblox `RemoteEvent` generation
- runtime dispatch
- LSP
- VSCode extension
- create-app scaffolding
- plugin API
- server components
- custom Luau emitter
- full roblox-ts build orchestration
- typed remotes/actions/schema runtime are intentionally deferred
