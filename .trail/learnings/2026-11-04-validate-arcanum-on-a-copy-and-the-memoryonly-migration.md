---
title: "Validate ARCANUM on a copy; the one migration 0.7.0 needs there"
author: Astra-void
date: 2026-11-04
branch: main
touches:
  - packages/aruna/CHANGELOG.md
  - packages/create-aruna-app/src/cli.ts
---

## Decided
- Downstream checks against ARCANUM run on a copy, never in `~/Desktop/Workspace/rojo/arcanum` itself. That checkout is not a git repository and is edited by hand, so an install into it (overrides, lockfile) cannot be undone.
- Hiding `isMemoryStoreBackend` (588dad9) stays. The public replacement is `playerStore.status(player).memoryOnly` once the document is ready. It is better than the old check, because it also reports the Studio fallback. The CHANGELOG Removed entry names it.
- A clean-room starter rehearsal uses the packed tarballs as a stand-in for the registry: `npm exec --package=<create-aruna-app.tgz> -- create-aruna-app my-game --no-install`, then `overrides` for the four `@arunajs/*` packages pointing at `file:` tarballs, with an empty `npm_config_cache`.

## Watch out
- Give re-packed tarballs new file names (e.g. `-rc.<sha>`) in the consumer's `vendor/`, and keep its lockfile. pnpm then rewrites only the aruna entries, each pinned to its tarball's sha512, and leaves lattice/vela untouched.
- Stop a started `aruna dev` by its own process group (`bash -c 'set -m; … & kill -- -$!'`). Never use `pkill -f rojo`, which can kill the user's own `rojo serve`.
- ARCANUM pins Lune 0.10.5 in `rokit.toml`, while the starter pins 0.10.0. Both run `aruna test`.

In the code: ARCANUM's only break was `src/domains/quests/server/store.ts` (`DataStoreProgressRepository`). Migrated gates: aruna check, build (154 .luau), doctor, tsc, 285/285 specs, `rojo build`.
