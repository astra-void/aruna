---
title: "ARCANUM integration: same-server rejoin, metrics on the client, vendoring at one version"
author: Astra-void
date: 2026-11-01
branch: feat/framework-expansion
touches:
  - packages/aruna/roblox/player-store.ts
  - packages/aruna/roblox/client.ts
  - apps/roblox-runtime-test/src/test/player-store.spec.ts
  - apps/roblox-runtime-test/src/test/public-exports.spec.ts
---

## Decided
- One player-store session per key per server (d21982d). A rejoin to the same server is a new `Player` with the same key and our own lock never blocks it, so `load` now releases the key's previous holder (`holders`) or waits out its in-flight release (`releasing`) before acquiring. Without it a retried final save was read stale, and a departed load landing late wrote its older value over the new session.
- `createNetworkMetrics`/`formatNetworkReport` are also exported from `aruna/client` (75f6cb6): the docs showed client use, but importing `aruna/server` on a client loads the whole server runtime.

## Watch out
- `createTestStoreBackend().hold("update")` holds both a release write and the next acquire in one FIFO, so it cannot show the rejoin race; `failNext("update")` plus a scheduler that parks retry delays can.
- A consumer vendoring a re-packed tarball at the same version keeps getting the old one: pnpm serves it by the lockfile's integrity. Update the `integrity` in the consumer's `pnpm-lock.yaml` to the new sha512.
- `createNetworkMetrics()` reads real time unless given `nowMs`; under `createTestNetwork` pass the network clock or the window is ~0 s and rates are nonsense.
- roblox-ts: `game` is reserved as an identifier (again); a spec cannot import a module from the client container (StarterPlayerScripts) — "import a file inside of an isolated container".
