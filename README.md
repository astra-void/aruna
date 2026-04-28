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
