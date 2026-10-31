---
title: Running the full suite on one commit in a fresh git worktree
author: Astra-void
date: 2026-10-31
branch: prerelease/v1-formats
cost: { minutes: 47, tokens: 238724 }
touches:
  - docs/rfcs/binary-wire.md
  - docs/wire-protocol.md
  - packages/aruna/CHANGELOG.md
  - README.md
  - api/aruna-client.d.ts
  - api/aruna-roblox.d.ts
  - api/aruna-server.d.ts
  - api/aruna-testing.d.ts
  - api/aruna.d.ts
  - apps/rbxts-harness/src/domains/shop/actions.test.ts
---

## Decided
- To check an intermediate commit, run CI's steps in a separate `git worktree`, one commit at a time (the Lune specs are timing-sensitive): `cargo test --locked --all-targets`, `pnpm build:native`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, the api check (`turbo run build --filter=@arunajs/aruna && pnpm api:check`), `pnpm verify:package-consumption`. Between commits, `git clean -fdx -e node_modules -e target` drops build output and turbo's cache but keeps deps and cargo's incremental cache; pass `--force` to the turbo runs.

## Tried and ruled out
- Relinking with `pnpm install --offline --frozen-lockfile` or `pnpm install --force` after a build: both stop at "Already up to date" and never create the missing bin.

## Watch out
- A worktree installed before anything is built has no `apps/rbxts-harness/node_modules/.bin/aruna` (the `aruna` alias bin points at packages/aruna/dist/cli.js, which does not exist yet). `pnpm test` then dies at `@arunajs/rbxts-harness#build` with `aruna: command not found`, and turbo cancels the other tasks, so they look failed too. After one build, `pnpm install --offline --frozen-lockfile --config.optimistic-repeat-install=false` links it.
- packages/compiler's release.test.ts, native-staging.test.ts and native-loader.test.ts all stage into `.npm/`; under vitest's parallel files one release test fails now and then ("Staged packages do not match the selected release targets"), a different one each time. It passes alone and on a rerun; it is not a regression signal.
