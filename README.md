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

Staged native artifacts use target-qualified names such as `compiler.darwin-arm64.node`.

Aruna never fakes platform support by renaming a binary built for another target.

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

Future Linux cross-compiles are expected to use `cargo-zigbuild --target x86_64-unknown-linux-gnu`, `cargo-zigbuild --target aarch64-unknown-linux-gnu`, `cargo-zigbuild --target x86_64-unknown-linux-musl`, and `cargo-zigbuild --target aarch64-unknown-linux-musl` instead of staged fake packages.

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
