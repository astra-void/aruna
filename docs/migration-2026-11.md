# Migrating to the 2026-11 round

What changed for an existing project, what you have to do (usually nothing), and what to
watch for. Everything new is opt-in except the four `strict.sharedSafety` checks, which
can be turned off. No wire format, persisted record format, or generated action id
changed.

## Do this

1. **Rebuild** (`aruna build`). The tsconfig upkeep adds two aliases,
   `$aruna/resources/client` and `$aruna/resources/server`, to `tsconfig.json` and says
   so. Commit the change. (They map to files that exist only once you declare a resource;
   an unused mapping is harmless.)
2. **Read your `aruna check` output.** `strict.sharedSafety` used to do nothing; it now
   reports four conditions. If a shared module reads `DataStoreService`, `ServerStorage`,
   `ServerScriptService`, `MessagingService`, or `MemoryStoreService` at load
   (`aruna::308`, an error) or in an unguarded function (`aruna::309`, a warning), or loads
   server/client code through other shared modules (`aruna::306`/`307`, errors), it was
   already broken on one side; the fix is usually to move the access into a server
   module. To defer it: `strict: { sharedSafety: false }`, or list the code in
   `diagnostics.ignore`. Three real projects (ARCANUM, draw-a-tower, troll-tower) and both
   harnesses produced no new reports.

## What changed underneath, and whether it affects you

| Change | Effect | Action |
| --- | --- | --- |
| Type-only imports skip the runtime boundary rules | Fewer reports: `import type { X } from "../server/x"` in shared or client code is no longer `aruna::303`/`300`. `inspect graph` marks such edges `typeOnly`. | None. `aruna::304` (domains) still applies. |
| `aruna::109` retired | The "sharedSafety is not enforced" warning is gone. | Remove it from `diagnostics.ignore` if you listed it. |
| Inputless stubs take `input?` | `ready()` type-checks; `ready(undefined)` still does. | None. You may drop the `undefined`. |
| `ActionStub<I, O, E>` is conditional on `undefined extends I` | A stub whose input accepts `undefined` has an optional parameter. | Only if you wrote your own `ActionStub`-typed functions with a required parameter for an unknown input. |
| `invokeAction(id, input?)`, `ClientApp.invoke(id, input?)` | Input optional. | None. |
| `$aruna/signals` exports `Signals` | `createActionDefiner<Signals, Player>()` works as documented. | If you declared your own `type Signals = typeof signals` next to the import, remove the duplicate. |
| `SignalPublisher`, `SignalSubscriber` public | Importable from `aruna/server`, `aruna/client`, `aruna/roblox`. | Replace any `aruna/internal/...` imports. |
| `ServerTransport` gets a second, optional parameter (the resource host) | A transport you wrote yourself still type-checks; it ignores resources. | Only to support resources over a custom transport: attach the host and pass subscription items to `admitResourceItem`. |
| `WIRE_ITEM_RESOURCE_PATCH` | Now an alias of `WIRE_ITEM_RESOURCE` (4), which is in use. | None. |
| Player store `waitFor` after `release` | Answers `StoreClosedError` instead of loading (and re-locking) the record again. | If you relied on `waitFor` to re-open a released player's document, call `load(player)`. |
| Player store `releaseAll` (shutdown) | Also releases loads still in flight. | None. |
| `StoreDocument.snapshot` | `existed`, `migrated`, `version`, `updatedAtMs` describe the record before the load's lock claim (a new player's document reports `existed: false`, a migrated one `migrated: true`). | If you read `snapshot.existed` to detect new players and worked around it always being `true`, remove the workaround. |
| `createServerApp` hooks | A throwing `onPlayerAdded`/`onPlayerRemoving` is reported with `warn` and no longer skips the store release after it. | None. |
| `aruna build` cache | One-shot builds keep an incremental stage in the OS temp dir (`aruna-rbxtsc-cache/<hash>`). Output is byte-identical to a fresh build (`pnpm verify:incremental-build`). | None. `--no-cache` compiles in a fresh stage; delete the directory to reclaim the space. |
| Generated files and `out/` | Files whose bytes did not change are no longer rewritten; `out/` and `include/` are mirrored (stale files removed, as before). | None. |
| `aruna add domain` | Also scaffolds `signals.ts` (the starter action publishes it); `--with resource` adds `resources.ts`; the scaffolded spec checks the error name instead of a message the runtime never produced. | None for existing domains. |
| `create-aruna-app` | `rokit.toml` pins Lune; `package.json` has `"test": "aruna test"`. | For an app made earlier: `rokit add lune-org/lune@0.10.0`, and add the script. |

## New, opt-in

- Resources: `defineResource`, `createServerApp({ resources })`,
  `createClientApp({ resources: true })` — [resources.md](../packages/aruna/docs/resources.md).
- Several player stores, readiness, `requireStores` —
  [stores.md](../packages/aruna/docs/stores.md#several-player-stores).
- `createTestNetwork`, `createTestStoreBackend` —
  [testing.md](../packages/aruna/docs/testing.md#multiplayer-networks).
- `createNetworkMetrics`, `onReject`, `aruna inspect network` —
  [observability.md](../packages/aruna/docs/observability.md).
- `aruna build --timings`.

## Replacing a snapshot handshake with a resource

The pattern resources replace — an action that returns the initial state plus a signal
for changes — maps one to one:

```ts
// before: quests.ready returns the snapshot; quests.progress pushes changes
export const questReady = defineAction({ id: "quests.ready", output: progressSchema, run: (ctx) => snapshot(ctx.player) });
publisher.to(player, "quests.progress", snapshot(player)); // after every change

// after
export const questProgress = defineResource({ id: "quests.progress", schema: progressSchema, load: (ctx) => snapshot(ctx.player) });
ctx.resources?.invalidate(questProgress); // after every change
// client: questProgress.subscribe(render) instead of `await questReady()` + `subscriber.on(...)`
```

Keep the old action and signal while clients built against them may still connect, and
remove them in a later release (`aruna contract diff` reports the removal as breaking).
