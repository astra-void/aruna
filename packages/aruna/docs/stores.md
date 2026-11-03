# Stores

A **store** is Aruna's safe front end to `DataStoreService`. You declare what a record
looks like once; the runtime owns validation, retries, request budget, versioning, and —
for player save files — the session lock that keeps two servers from overwriting each
other.

Stores are server-only. There is no generated client binding: a client that imports a
store module is a compile error (`aruna::574`). Read the data on the server, return what
the client needs through an action.

## Why not call DataStoreService directly

Four failure modes cost real player data, and each one is closed here rather than left to
every call site:

| Failure | What the store does |
| --- | --- |
| A read fails and the code starts from a default, then saves over the real record | A failed load returns an error, never a value. Nothing is written over a record that could not be read. |
| A transient DataStore error takes down a game thread | Nothing throws. Every operation resolves with a `StoreResult`. |
| Two servers hold the same player (teleport, rejoin during shutdown) | The lock is claimed inside the same `UpdateAsync` that reads the record, and a server that lost its lock refuses to write. |
| A shape change makes old records unreadable | Every write carries a version; older records go to `migrate` instead of being reinterpreted. |
| An old server reads a record a newer version wrote | The record is refused (`StoreVersionAheadError`): never migrated, never written back. See [Mixed-version servers](#mixed-version-servers). |

## Defining a store

```ts
import { defineStore, definePlayerStore } from "aruna/server";
import { schema } from "aruna/schema";

// Keyed store: you choose the key.
export const settings = defineStore({
  id: "game.settings",          // the DataStore name — a static string literal
  scope: "live",                // optional DataStore scope
  schema: schema.object({ doubleCoinsEnabled: schema.boolean() }),
  defaultValue: { doubleCoinsEnabled: false },
});

// Player store: keyed by player and held under a session lock.
export const profile = definePlayerStore({
  id: "player.profile",
  version: 2,
  schema: schema.object({
    coins: schema.u32(),
    unlocked: schema.array(schema.string()),
  }),
  // A factory runs per key, so a mutable default is never shared between players.
  defaultValue: () => ({ coins: 0, unlocked: [] }),
  migrate: (stored, fromVersion) =>
    fromVersion === 1 ? upgradeFromV1(stored) : undefined,
});
```

`id` must be a static string literal: it is the DataStore name, and `aruna inspect stores`
reports it without executing your code.

`schema` and `defaultValue` are required. The schema is what stops a corrupt record from
reaching game code; the default is what a never-written key resolves to.

## Results, not exceptions

```ts
type StoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: StoreError };

type StoreError = {
  name: StoreErrorName;
  message: string;
  retryable: boolean;      // whether another attempt could plausibly succeed
  attempts?: number;
  retryAfterMs?: number;
  cause?: unknown;
};
```

| `StoreErrorName` | Meaning | Retried |
| --- | --- | --- |
| `StoreUnavailableError` | No API access (Studio setting off, unpublished place, 403) | No |
| `StoreThrottledError` | Request budget exhausted or the service throttled us | Yes |
| `StoreRequestError` | Network or 5xx, or an unclassified DataStore throw | Yes |
| `StoreValidationError` | The record does not match the schema | No |
| `StoreSerializationError` | The value cannot be persisted (function, Instance, NaN, cycle, > 4 MB) | No |
| `StoreMigrationError` | `migrate` threw, refused, or produced an invalid value | No |
| `StoreVersionAheadError` | The record is at a newer version than this server's (an old server after an update) | No |
| `StoreKeyError` | Empty key, or longer than the 50-character DataStore limit | No |
| `StoreLockedError` | Another live server holds the session lock | Yes |
| `StoreClosedError` | The document was released (player left, shutting down) | No |

## Using a keyed store

```ts
import { createStore } from "aruna/server";
import { robloxDataStore } from "aruna/roblox";

const store = createStore(settings, { createBackend: robloxDataStore() });

const loaded = await store.load("global");
if (loaded.ok) {
  print(loaded.value.doubleCoinsEnabled);
}

// Read-modify-write inside a single UpdateAsync.
await store.update("global", (current) => ({ ...current, doubleCoinsEnabled: true }));
```

`save` and `update` both go through `UpdateAsync`, so an existing session lock and the
record's [framework metadata](#persisted-format-v1) are carried forward rather than
clobbered. `overwrite` uses `SetAsync` and ignores the current record entirely — the lock
and the metadata (processed receipts among it) are not carried over. It exists for admin
and migration tooling, not for game code.

## Player stores and the session lock

```ts
import { createPlayerStore } from "aruna/server";
import { robloxDataStore } from "aruna/roblox";

export const profiles = createPlayerStore(profile, {
  createBackend: robloxDataStore(),
  onLoadFailed: (player, error) => {
    // No document means no trustworthy value. Decide explicitly: kick, retry, or
    // run the player in a no-save mode. Never "start fresh" — that overwrites a
    // real save the moment the next write lands.
    player.Kick(`Could not load your data (${error.name}). Please rejoin.`);
  },
});
```

The lifecycle:

1. **Load** claims the lock and reads the record in one `UpdateAsync`. A lock held by
   another live server refuses the load (retried `acquireAttempts` times); a lock whose
   heartbeat aged past `lockTtlMs` is stale and is taken over.
2. **Heartbeat** (`heartbeatMs`, default 30s) flushes pending changes, refreshing the lock
   with the same write. It is the autosave: an unclean shutdown loses at most one
   interval. A tick with nothing to flush writes only once the lock is half `lockTtlMs`
   old, since then the write's only job is keeping the lock alive
   ([cost](#where-the-session-lock-lives)).
   A heartbeat write that still fails after its retries goes to `onSaveFailed`; the
   document stays open with the change pending, and the next tick writes it again.
3. **Release** writes one final time and clears the lock, so the player's next server can
   load immediately instead of waiting out the TTL.

**Edit a player's data through their session.** `playerStore.store` is the plain `Store`
underneath: its `get`, `save`, and `update` read and write the record directly and carry
the session lock forward without checking it. Used on a player whose session is open on
any server, such a write lands, and the session's next heartbeat or save writes its own
value over it. Change an online player's data through their document (`ctx.store`, or
`playerStore.get(player)` on the server that holds them); use `playerStore.store` only for
players who are offline (no lock in the record), such as admin tools or migrations.
`defaultPlayerStoreKey(userId)` from `aruna/server` gives the key a player store uses
when it has no `key` of its own (`player_<UserId>`), as a `StoreResult<string>`.

**A session that lost its lock never writes again.** Every write of an open document
checks that the record still carries this server's lock. If another server took the lock
over (this server's heartbeats failed past the TTL), the write is refused with
`StoreLockedError` and the document closes, whether that server still holds the lock or
has already released it: its saves are newer than this server's value. A save or
heartbeat that runs after the document's own release is refused with `StoreClosedError`
instead of putting the lock back.

**One session per key on a server.** A player who rejoins the same server is a new
`Player` with the same key, and a server's own lock never blocks it. So a load ends the
key's previous session on this server first: a departed player's document (still
loading, or open because the game has not released it yet) is released, and a release
still writing (a retried final save, say) is waited out. The new session therefore reads
what the old one last wrote, and nothing the old one held can land on top of the new
one's saves. A later `release` of the departed player is a no-op.

```ts
readonly session?: {
  readonly lockTtlMs?: number;        // default 120_000; forced to at least 2 heartbeats
  readonly heartbeatMs?: number;      // default 30_000
  readonly acquireAttempts?: number;  // default 5
  readonly acquireDelayMs?: number;   // default 3_000
};
```

### Documents

`load` resolves with a `StoreDocument` — a live handle on the record for as long as the
lock is held.

```ts
const opened = await profiles.load(player);
if (!opened.ok) {
  return;
}
const document = opened.value;

document.get();                                            // current value, always schema-valid
document.update((current) => ({ ...current, coins: current.coins + 10 }));
await document.save();                                     // flush now (no-op when unchanged)
await document.release();                                  // final flush + unlock
```

`set` and `update` validate before they mutate, so a bad value fails at the call site
instead of silently at the next flush. After `release` the document is closed: further
writes fail with `StoreClosedError` rather than resurrecting a departed player's record.

### Mixed-version servers

An update does not replace the servers that are already running. Until they empty out,
old and new servers serve the same DataStore side by side, and a player moves between
them: they play on a new server, which saves their record at v3, then follow a friend
into an old server still at v2.

`migrate` only goes forward, so the old server must not touch that record. Before this
was refused, a permissive `migrate` (`(stored) => stored`) passed the v3 data straight
through, the old server saved it back under a v2 envelope, and the next new server ran
the v2 → v3 migration on it a second time — for a currency rescale, that multiplies
every balance again.

Now a record whose version is higher than the store's is a load failure:
`StoreVersionAheadError`, not retryable. `migrate` is never called for it, a keyed
store's `save` and `update` refuse it the same way, and a player store treats it like
any other failed load: no document, no default value, and no session lock written —
the record stays exactly as the newer server left it. Handle it in `onLoadFailed`:

```ts
export const profiles = createPlayerStore(profile, {
  createBackend: robloxDataStore(),
  onLoadFailed: (player, error) => {
    if (error.name === "StoreVersionAheadError") {
      player.Kick("This server is running an older version of the game. Please rejoin.");
      return;
    }
    player.Kick(`Could not load your data (${error.name}). Please rejoin.`);
  },
});
```

Rejoining usually lands the player on a new server. This is the same `onLoadFailed`
the app's own load reports through when you pass the store to
`createServerApp({ playerStore })`; the app does not swallow it.

## Wiring into the server app

`createServerApp({ playerStore })` owns the whole lifecycle — load on join, flush and
release on leave, and a `BindToClose` flush at shutdown — and injects the open document
into every action as `ctx.store`.

```ts
import { createServerApp } from "aruna/server";
import { robloxRemoteEvent } from "aruna/roblox";
import { actions } from "$aruna/actions/server";

const app = createServerApp({
  actions,
  transport: robloxRemoteEvent(),
  playerStore: profiles,
});
```

```ts
import { actionError, defineAction } from "aruna/server";

export const buy = defineAction({
  id: "shop.buy",
  run(ctx) {
    // Undefined while the locked read is still in flight, and after a failed
    // load. That is deliberate: the alternative is handing out a default value
    // that the next save would write over a real record.
    const document = ctx.store;
    if (document === undefined) {
      throw actionError("ProfileNotReady", "Your data is still loading.");
    }
    document.update((current) => ({ ...current, coins: current.coins - 10 }));
    return { ok: true };
  },
});
```

For a typed `ctx.store`, bind a definer:

```ts
export const defineAction = createActionDefiner<Signals, Player, Session, Profile>();
```

### Several player stores

Most games keep more than one record per player — progression, inventory, settings —
and a separate store per record keeps each one's schema, versioning, and migration
independent. `createServerApp({ playerStores })` owns all of them:

```ts
const app = createServerApp<Player>({
  actions,
  transport: robloxRemoteEvent(),
  playerStores: {
    progress: createPlayerStore(progressStore, { createBackend: robloxDataStoreBackend }),
    inventory: createPlayerStore(inventoryStore, { createBackend: robloxDataStoreBackend }),
  },
  middleware: [requireStores("progress")], // or per action, see below
  onStoresReady: (player, report) => {
    if (!report.ok) {
      warn(`${player.Name}: ${report.failed.join(", ")} did not load`);
      // kick, retry, or run without that data: the game's call
    }
  },
});
```

- **Lifecycle.** Every store loads on join (started at once, not waited on), flushes and
  releases on leave, and is flushed at shutdown, **each on its own**: a store that fails
  never skips another's release, and a throwing `onPlayerRemoving` (or `onPlayerAdded`)
  hook is reported with `warn` and the lifecycle carries on. A player who leaves while a
  load is in flight is released once it lands, and shutdown releases loads still in
  flight too.
- **Actions** see the open documents as `ctx.stores.<name>`, each undefined until it
  lands and after a failed load — never a default. Type them with the definer's fifth
  parameter: `createActionDefiner<Signals, Player, Session, Profile, { progress:
  Progress; inventory: Inventory }>()`.
- **`requireStores("progress", "inventory")`** is middleware that refuses an action with
  `StoreNotReadyError` (a public error the client sees, and can retry; the name is
  exported as `STORE_NOT_READY_ERROR_NAME`) until the named
  documents are open, so a sensitive mutation never runs against data that has not
  loaded. `requireStores()` with no names means the single `playerStore` (`ctx.store`).
- **Partial failure** is explicit: `onStoresReady(player, report)` runs once every load
  settled, with `report.ok`, `report.failed` (names), `report.statuses`, and
  `report.errors`. Nothing is defaulted after an unknown failure.
- The single `playerStore` keeps working (`ctx.store`), and is named `"store"` in
  `app.stores`.

### Readiness

`app.stores` (present whenever the app owns a store) and every `PlayerStore` report where
a player's document is:

```ts
app.stores!.status(player);              // { progress: PlayerStoreStatus, inventory: ... }
app.stores!.isReady(player, ["progress"]); // an open document for each named store
await app.stores!.ready(player);          // every load settled: a PlayerStoresReport
progressStore.status(player);             // one store
```

| `status.state` | Meaning |
| --- | --- |
| `idle` | Nothing was asked for this player. |
| `loading` | The locked read is in flight. |
| `ready` | The document is open. `isNew`: the key held nothing, so it is the default. `memoryOnly`: the backend persists nothing (Studio fallback, specs). |
| `failed` | The load gave up; `error` says why. `locked`: another server holds the session lock. |
| `released` | The document was flushed and closed (reported for 30 s after the player left). |

`isPlayerStoreReady(status)` is `status.state === "ready"`. `waitFor(player)` resolves
with the in-flight load, the open document, the last failure, or — for a player whose
document was just released — `StoreClosedError`; it never re-locks a player who left.

## Studio without API access

`robloxDataStore()` probes once at creation. In Studio with "Enable Studio Access to API
Services" off, it warns and falls back to an in-memory backend, so a playtest exercises
the same load/save code path instead of erroring on every call. Pass
`robloxDataStore({ studioFallback: false })` to make the missing access loud.

## Inspecting

```bash
aruna inspect stores
aruna inspect stores --json
```

```text
aruna inspect stores

  2 stores discovered

  game.settings
    kind: store
    source: src/domains/settings/store.ts
    version: 1
    scope: live
    schema: object { doubleCoinsEnabled: boolean }

  player.profile
    kind: player store (session locked)
    source: src/domains/economy/store.ts
    version: 2 (migrate declared)
    schema: object { coins: u32, unlocked: string[] }
```

## The compatibility gate

A store's records outlive the code that wrote them. In Roblox, a client is replicated
from the server it joined, so client and server code inside one server always match —
but the DataStore is shared by every version of the game that has ever run. The real
cross-version boundary is a saved record: the next build has to read what this one
writes.

Commit a contract snapshot and every `aruna check` and `aruna build` compares your stores
against it:

```bash
aruna contract update      # writes aruna.contract.json; commit it
```

The question for each store is: *can the new code read a record the old code wrote at
the same version?* At the same version nothing converts a record on the way in, so the
new schema must accept everything the old one did.

| Change | Verdict |
| --- | --- |
| Same version, a new required field with no `.default()` | **breaking** — every saved record lacks it |
| Same version, a field's type changed, or narrowed (`number` → `u8`, an enum value or union member dropped, optional → required) | **breaking** |
| Same version, a bound tightened: `.maxLength` / `.maxItems` / `.maxEntries` / `.max()` lowered, `.minLength` / `.min()` raised, `.int()` or a `.refine()` added, or any of them added where there was none | **breaking** — a saved value may not satisfy it |
| Same version, a `.refine()` predicate changed, or a bound computed at runtime | warning — "constraint changed; saved records not verified": the compiler sees the change (it hashes the source) but cannot run it against saved records |
| Same version, a field removed | warning — saved records still hold it, and rebuilding the value drops it |
| Same version, a new optional field, or one with `.default()`; a type widened; a bound loosened or removed | compatible |
| Version bumped, `migrate` declared | info — old records go through `migrate`, so the schemas are not compared |
| Version bumped, no `migrate` | **breaking** — every saved record fails to load |
| Version decreased | **breaking** — saved records are now [ahead of this build](#mixed-version-servers) |
| Scope changed, or `defineStore` ↔ `definePlayerStore` | **breaking** — the old records are no longer read |

A breaking change fails the build as `aruna::578 store-incompatible-change`
(`strict.storeCompatibility` sets its severity; `"error"` by default). `aruna contract diff`
with no arguments shows the full comparison, warnings included. Intending the change
does not make the old records readable; only two things do — a `.default(...)` on the
new field, or a version bump with a `migrate()` that converts the old records. Make one
of them, then run `aruna contract update` and commit the new snapshot alongside it.
`contract update` refuses to record a change that still leaves saved records unreadable
(`--accept-unreadable-records` overrides it, loudly, when dropping those records is the
plan), and `aruna contract update --check` fails CI when the snapshot was not updated
([recipe](./cli.md#keeping-the-snapshot-current-in-ci)).

The snapshot path is `contract.snapshot` in `aruna.config.ts` (default
`aruna.contract.json`, relative to the project root). Without the file, there is no gate.

## Diagnostics

| Code | Name | Severity |
| --- | --- | --- |
| `aruna::570` | `invalid-store-definition` | error |
| `aruna::571` | `store-missing-schema` | error |
| `aruna::572` | `store-schema-invalid` | warning |
| `aruna::573` | `duplicate-store-id` | error |
| `aruna::574` | `store-imported-from-client` | error |
| `aruna::575` | `invalid-store-version` | error |
| `aruna::576` | `store-missing-default` | error |
| `aruna::577` | `store-version-without-migrate` | warning |
| `aruna::578` | `store-incompatible-change` | error (`strict.storeCompatibility`) |
| `aruna::579` | `contract-snapshot-invalid` | error |

Every runtime failure reaches `onError` as a `StoreError` (`name` is its category,
`retryable`, `attempts`, `retryAfterMs`) with a `StoreErrorInfo` (`storeId`, `key`,
`operation`). `describeStoreError(error, info)` turns the pair into one log line with
none of the record's data:

```
[aruna store player.progress] lock player_6: StoreLockedError (retryable, retry after 118000ms): Store player.progress key player_6 is locked by another server (server-a).
```

## Persisted format v1

Every record a store writes is wrapped in this envelope:

```json
{ "$aruna": 1, "v": 2, "d": { "coins": 40 }, "t": 1767225600000, "m": { "!r": ["…"] }, "l": { "o": "…", "h": 1767225600000 } }
```

**This format is permanent.** Records outlive every build that wrote them, so once a game
has saved one, v1 is read for as long as Aruna exists. The top level is **closed** and
`m` is **open**, which is how the format grows without breaking a rollout (below).

| Field | Type and bounds | Meaning |
| --- | --- | --- |
| `$aruna` | integer ≥ 1 | The marker, and the **envelope format version**: `1` for this format. Owned by Aruna, independent of the store's `version`. |
| `v` | number ≥ 0 | The **store's schema version** (`version` in `defineStore`, default 1) the data was written at. Drives `migrate`. |
| `d` | any DataStore-storable value | The data: validated against the store's schema on every read and write. |
| `t` | number | When the record was last written, in ms since the Unix epoch. |
| `m` | table with string keys, optional; omitted when empty | **Framework metadata.** Never validated against the store's schema, never passed to `migrate`, and carried through every write unchanged unless the framework changes it. Each key below is optional; keys not below follow the [evolution rule](#how-the-format-evolves). |
| `l` | `{ o: string, h: number }`, optional | The **session lock** of a player store: the owner (`${JobId}:${PlaceId}`, a `studio-…` id in Studio) and its last heartbeat in ms. Absent when no server holds the record. |

The `m` keys v1 defines. A key starting with `!` is **must-understand**; the others are
**may-ignore** (see the rule below for what each means to a reader that does not know it):

| Key | Type and bounds | Meaning | Kind, and why |
| --- | --- | --- | --- |
| `!r` | array of at most **100** strings, each 1–128 UTF-8 bytes | Processed purchase receipt ids, oldest first. Recording the 101st evicts the oldest. For the planned `ProcessReceipt` support: a grant and its receipt id land in the same write. | **Must-understand.** A server that ignored it would not see that a receipt was already granted and would grant a retried purchase again; writing the list back unread does not prevent that. Refusing the record costs a failed load on an outdated server; ignoring it costs real currency. |
| `h` | `{ k: string of 1–128 bytes, x: number }` | A session handoff token (`k`) and its expiry in ms (`x`). For the planned teleport handoff: the destination server presents it to take the lock without waiting out the TTL. | **May-ignore.** A server that ignores it waits out the lock TTL, as any takeover does: slower, never unsafe. The token expires on its own (`x`), which the handoff must keep shorter than the lock TTL, so a token carried unread is dead before an ignoring server can take the lock. |
| `e` | number | Erasure marker: when the record's data was erased on a right-to-erasure request, in ms. | **May-ignore.** It records what happened, for tooling and audits; no server decision reads it, so ignoring it changes nothing a server does, and it is carried through. |

Worst case the envelope adds about 17.5 KB to the data: 100 receipt ids of 128 bytes
(~13.2 KB), up to 4 KB of metadata from newer releases, a handoff token (~160 bytes), the
lock (~100 bytes), and the fixed fields. The 4 MB size check counts the whole envelope.

### How the format evolves

The format changed once before the first release: the top level used to be read
leniently (an unknown top-level field was dropped on the next write) and so did `m`.
Both rules below replace that.

- **The top level is closed.** A v1 envelope has exactly `$aruna`, `v`, `d`, `t`, and
  optionally `m` and `l`. Any other top-level key makes it a **malformed envelope**:
  `StoreValidationError`, never adopted, never written back. A change to the top-level
  shape is the only reason to bump `$aruna`, and a server refuses a newer `$aruna` with
  `StoreVersionAheadError`.
- **`m` is open.** A new field goes in `m`, and the format version stays `1`. A reader
  meets a key it does not know in one of two ways:
  - **May-ignore** (no `!`): preserved **verbatim** on every write — through `save`,
    `update`, a user `migrate`, the session lock and its heartbeat — and otherwise
    ignored. All of them together are bounded at **4,096 bytes**, JSON-encoded
    (`STORE_MAX_PRESERVED_META_BYTES`); a record over the bound is a malformed envelope
    (`StoreValidationError`) when read, never silently truncated, since truncating is
    erasing.
  - **Must-understand** (starts with `!`, `STORE_MUST_UNDERSTAND_PREFIX`): the reader
    refuses the record with `StoreVersionAheadError`, exactly as for a newer `$aruna`, and
    never writes it back — not even a player store already holding the session lock.
- **Which to use.** A new field is may-ignore by default. It is must-understand only when
  a server that ignored it would do harm (grant twice, resurrect what should stay gone,
  break an invariant another server relies on). Must-understand is cheap to read but
  expensive to roll out: until every server knows the key, an older one refuses the
  records that carry it.
- **Why 4 KB.** The keys v1 defines are small — a handoff token is ~160 bytes — so 4 KB
  leaves room for dozens of ids, timestamps, or tokens from later releases, while capping
  what an older server carries blindly (and measures on every read) at 0.1% of the 4 MB
  record. A later release must keep its may-ignore keys inside the bound, or older servers
  would refuse those records during a rollout; a field that cannot fit is a reason to
  reconsider the field, not to raise the bound under servers that are already running.

A rollout therefore never needs every server upgraded first, except for must-understand
keys, and never loses a field an older server did not know.

### Reading a stored value

| The key holds | Read as | Then |
| --- | --- | --- |
| nothing | absent | the store's default; `existed: false` |
| a table whose `$aruna` is `1` and whose fields fit the table above | an **envelope v1** | `v` above the store's version → `StoreVersionAheadError`; below → `migrate(d, v)`; equal → validated |
| a table whose `$aruna` is `1` but a field does not fit (`v` not a number, `t` missing, `m["!r"]` not an array, an unknown top-level field, over 4 KB of unknown `m` keys, …) | a malformed envelope | `StoreValidationError`; never treated as raw data, never written back |
| a table whose `$aruna` is `1` and whose `m` holds a `!` key this server does not know | an envelope from a newer Aruna | `StoreVersionAheadError`; never migrated, never written back |
| a table whose `$aruna` is an integer above `1` | an envelope from a newer Aruna | `StoreVersionAheadError`; never migrated, never written back |
| anything else, **including** a table that looks like an envelope but fails the marker check (`{ v: 1, t: 2 }`, `$aruna: "1"`, `$aruna: 0`) | a **raw legacy value**: data from before this store owned the key | adopted at version 0: `migrate(value, 0)`, the whole value as the data, no metadata, no lock; the next write wraps it in a v1 envelope |

The marker is an explicit field rather than a shape test because a game adopting an
existing DataStore can hold anything, including tables with numeric `v` and `t` fields.

### Where the session lock lives

The lock stays **in the record**, as `l`. Claiming it and reading the data are then one
`UpdateAsync`, and every later write checks the lock in the same `UpdateAsync` that
writes the data, so a server that lost its lock cannot write. The cost is that refreshing
the lock rewrites the whole record. For a 50-player server, with the defaults
(`heartbeatMs` 30 s, `lockTtlMs` 120 s):

| | per minute | share of the write budget |
| --- | ---: | ---: |
| DataStore write budget per server (`60 + 10 × players`; `UpdateAsync` counts against it) | 560 | 100% |
| Heartbeats, every player's document changed every tick (2 per player) | 100 | 17.9% |
| Heartbeats, every player idle (lock refresh at half the TTL: 1 per player) | 50 | 8.9% |
| Joins and leaves (1 lock write + 1 release per session) | per session, not per minute | — |

That leaves at least 460 writes a minute to the game's own stores. Per key, one write per
30 s is five times under the 6-second write cooldown. The bytes matter only for large
records: each refresh writes the whole record, and at 2 writes a minute the per-key write
throughput limit (4 MB per minute) is reached by a record of 2 MB, so a record that large
should raise `heartbeatMs`.

Moving the lock to a MemoryStore would save only the idle refreshes — at most those 50
writes a minute, since a changed document still needs its autosave write — and would
cost the atomicity the lock exists for. The claim and the read would be two services, so
the record would need a fencing token written on every acquire anyway, and every write
would depend on a second service with its own quota and outages, where an expired or
evicted MemoryStore lock lets a second server in while the first still writes. Under 10%
of the budget does not pay for that.

## Limits the runtime enforces locally

- Keys: 50 characters, non-empty.
- Values: ~4 MB serialized, measured with the same JSON encoder the service uses.
- Payloads: JSON-storable only. `Vector3`/`CFrame`/`Instance` travel over RemoteEvents but
  not into a DataStore, so they are rejected before the request leaves.
