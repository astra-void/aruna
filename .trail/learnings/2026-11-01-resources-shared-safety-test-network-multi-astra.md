---
title: "Resources, shared safety, test network, multi-store, metrics, incremental builds"
author: Astra-void
date: 2026-11-01
branch: feat/framework-expansion
cost: { minutes: 3, tokens: 16705 }
touches:
  - arcanum-quests-resource.patch
  - docs/rounds/2026-11-framework-expansion.md
  - docs/rfcs/resources.md
---

## Decided
- Resources (docs/rfcs/resources.md) send whole snapshots on the one reliable channel (wire kind 4) and take subscriptions on the call remote (kind 5, admitted through `registry.admitItem` like a call). Revisions come from one per-server counter taken at load START; both ends refuse to go backwards, and the client keeps its floor after unsubscribe. A subscription is registered before its first load. One load in flight + one queued per key; `WireOutbox.replace` keeps one snapshot per resource per player per frame.
- Player-scoped resources key on the sender; the client sends only `r` and `o`. `authorize` is a property (`authorize: (ctx) => bool`), `load` a method — roblox-ts cannot test an optional method for presence ("Cannot index a method without calling it").
- `strict.sharedSafety` = aruna::306/307 (transitive, one reverse BFS per side) + 308/309 (server-only services at load / unguarded in a function). aruna::109 retired. Type-only imports (syntactic `type`, or bindings never read as a value) skip the runtime boundary rules but not aruna::304.
- The one-shot build's rbxtsc stage persists in `os.tmpdir()/aruna-rbxtsc-cache/<sha(realpath(project))>` with `incremental` + tsBuildInfo; rbxtsc's own one-shot `cleanup` removes outputs of deleted sources. `pnpm verify:incremental-build` is the correctness check (cached vs --no-cache out/ byte-identical).
- `requireStores(...names)` takes explicit names: a store that has not loaded is a nil field, and a Luau table cannot hold it, so "every store in ctx.stores" cannot be enumerated.

## Tried and ruled out
- Staging the build cache under `node_modules/.cache`: TypeScript treats files under node_modules as library code and realpaths them, so a symlinked node_modules broke `rootDir` (TS6059); it also wrote into a node_modules shared between checkouts. Moved to the temp dir.

## Watch out
- A scratch copy of a consumer that symlinks `node_modules` to the real project writes into the real project through it. Check where anything under node_modules lands before running builds in a copy.
- A memory/test store backend resolves synchronously: a load's `.then` cleanup ran before `loading.set`, leaving it "in flight" forever. Any "record pending, delete on settle" map needs a settled flag.
- The lock claim rewrites the record, so a snapshot decoded after it says existed/migrated wrong; carry those from the pre-claim decode.
- roblox-ts reserved identifiers bit again: `next`, `local`, `game` (as a function name in a spec). A regex rename also rewrites comments.
- `trail check` reports ~20 keyword "conflicts" against the Oct 31 learnings on this branch, mostly in files it did not touch; they are false positives.
