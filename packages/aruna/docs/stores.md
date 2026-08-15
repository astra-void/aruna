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

`save` and `update` both go through `UpdateAsync`, so an existing session lock is carried
forward rather than clobbered. `overwrite` uses `SetAsync` and ignores locks — it exists
for admin and migration tooling, not for game code.

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
2. **Heartbeat** (`heartbeatMs`, default 30s) refreshes the lock *and* flushes pending
   changes. It is the autosave: an unclean shutdown loses at most one interval.
3. **Release** writes one final time and clears the lock, so the player's next server can
   load immediately instead of waiting out the TTL.

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
export const buy = defineAction({
  id: "shop.buy",
  run(ctx) {
    // Undefined while the locked read is still in flight, and after a failed
    // load. That is deliberate: the alternative is handing out a default value
    // that the next save would write over a real record.
    const document = ctx.store;
    if (document === undefined) {
      throw { name: "ProfileNotReady", message: "Your data is still loading." };
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

## Limits the runtime enforces locally

- Keys: 50 characters, non-empty.
- Values: ~4 MB serialized, measured with the same JSON encoder the service uses.
- Payloads: JSON-storable only. `Vector3`/`CFrame`/`Instance` travel over RemoteEvents but
  not into a DataStore, so they are rejected before the request leaves.
