# RFC: server-owned resources (`defineResource`)

Status: **implemented** (2026-11). This document is the contract the runtime, the
compiler, and the tests are written against. Where the implementation and this text
disagree, that is a bug in one of them.

## Why

Every server-authoritative game grows the same code for each piece of state a client
displays: an action that returns the initial value, a signal that pushes changes, a
handler that merges the two, and — usually only after a bug report — something that
copes with a change arriving before the initial value, or a player who rejoins. ARCANUM
has three of these (combat, quests, encounters), each with its own handshake.

The hard part is not the plumbing; it is the race. A client that fetches a snapshot and
then subscribes can miss a change made between the two, and one that subscribes first
can have a newer pushed value overwritten by an older snapshot. A resource is the
plumbing plus a protocol that makes both impossible.

A resource is **observation, not mutation**. Clients read; the server writes through
actions (or its own systems) and tells the resource it changed. There is no client
write path, no client-chosen scope, and no cache a client can poison.

## History

`docs/spec-alignment.md` deferred resources until the starter contract and the compiler
had stabilized ("Design resources and invalidation after the starter contract is
stable"). Two things since then made the design small: the one ordered reliable channel
per player (wire protocol v1, which already reserved item kind 4 for "resource patches"),
and the primitive registry, which makes a new compiler-discovered `define*` one module.
The deferral was about not designing on sand; the sand has set.

## Definition

```ts
// src/domains/quests/resources.ts — server code (the file is reclassified as server)
import { defineResource } from "aruna/server";
import { schema } from "aruna/schema";

export const questProgress = defineResource({
  id: "quests.progress",          // static string literal, unique
  scope: "player",                // "player" (default) or "global"
  schema: questProgressSchema,    // what a snapshot is; validated before it is sent
  load(ctx) {                     // the authoritative read
    return quests.snapshot(ctx.player.UserId);
  },
  authorize(ctx) {                // optional; refuse a subscription
    return true;
  },
});
```

- **Identity.** `id` is the resource's identity on the wire, in the manifest, and in the
  contract, like an action id. It must be a static string literal; the compiler reports
  a non-literal (`aruna::586`) and a duplicate (`aruna::587`).
- **Ownership.** The definition is server code. A file that calls `defineResource` is
  reclassified as `server`, so a client import of it is `aruna::300`. Clients use the
  generated bindings in `$aruna/resources/client`, which carry the id and the value type
  and nothing else.
- **Scope.** `"player"`: one value per player, read with that player's context. The scope
  key is the player the subscription arrived from — the client sends a resource id and
  nothing else, so there is no scope identifier for it to forge. `"global"`: one value
  for every subscriber, loaded once per invalidation and sent to each.
- **Loading.** `load(ctx)` returns the value or a promise of it. Its context is the
  action context's server half: `player` (player scope), `session`, `store`, `stores`.
  A value that fails `schema` or is not wire-safe is never sent (below).
- **Authorization.** `authorize(ctx)`, when present, runs on every subscription (player
  scope gets `ctx.player`; global scope gets the subscribing player as `ctx.player`
  too). `false` (or a throw) refuses it; the client is told `ResourceForbiddenError`
  and nothing is loaded.

## Wire

Two item kinds on the existing remotes (docs/wire-protocol.md). Kind 4 was reserved for
this.

| `t` | Kind | Direction | Fields |
| ---: | --- | --- | --- |
| `4` | resource state | server → client, reliable channel | `r` resource id, `v` revision, then `d` (the value) **or** `e` (an error name) |
| `5` | resource subscription | client → server | `r` resource id, `o` `1` subscribe / `0` unsubscribe |

Kind 4 travels the player's one ordered reliable channel, interleaved with action
responses and reliable signals in production order. Kind 5 travels the same remote as
calls and is admitted the same way: charged one request from the player's budget before
its id is read, dropped (and reported through `onAbuse`) when malformed, over budget, or
naming a resource the server does not define (`unknown-resource`), and dropped silently
from a player who has left.

A state item always carries the **whole value**. There are no patches in this version:
a snapshot is self-contained, so a lost or skipped item never leaves the client holding
a value no server state ever had — at worst an older one, which the next item replaces.
Patches can be added later as a new field (`p`) behind a new item kind without
changing this one.

## Revisions

Each state item carries a revision `v`: a positive integer from **one counter per
server**, incremented for every load the server starts. It is never reset while the
server runs, so it orders every item a server produces for a resource, across
invalidations, unsubscribes, resubscribes, and players leaving and joining again.

- **Assigned when the load starts**, not when it finishes. Two overlapping loads of the
  same resource and key finish in either order; the one that started later read the
  later state, and it carries the higher revision.
- **The server sends only forward.** Per resource and key it remembers the highest
  revision it has sent; a load that finishes with a lower one (it was overtaken) is
  dropped instead of sent.
- **The client accepts only forward.** Per resource it keeps the highest revision it has
  applied, and drops any item whose revision is not greater: a duplicate, a stale
  snapshot, or one reordered behind a newer item. An item whose revision is not a
  positive integer is dropped too. The client keeps that floor after it unsubscribes,
  so an item still in flight from before a resubscription cannot roll it back.

An error item takes part in the same order: it carries the revision of the load that
failed, raises the floor, and marks the subscription `error` while keeping the last
value. The next successful item clears it.

## Synchronization protocol

The race-free property is: **once a subscription is acknowledged by its first state
item, every change the server announces afterwards reaches the client, and no item can
replace a newer one.**

1. The client sends `subscribe(r)`. Its local state for `r` is `loading`, revision floor
   as before.
2. The server admits the item, runs `authorize`, then **registers the subscription
   before loading**. From this moment every `invalidate` of `r` for this key pushes to
   this player.
3. The server starts a load (revision `n`). If a load for this key is already running,
   it does not start another: that load will reach the new subscriber when it finishes,
   and if an invalidation arrived while it ran, one more load follows it (below).
4. The load finishes; the value is checked against the schema and the serialization
   boundary; the item `{ r, v: n, d }` is queued on the player's channel.
5. The client applies it if `n` is above its floor.

Because registration (2) happens before the snapshot load (3), there is no window in
which a change can be made and not be followed by an item. Because every item carries a
revision assigned at load start, and both ends refuse to go backwards, an item that
arrives early (a push that overtook the snapshot) is kept and the late snapshot is
dropped, never the other way round.

### Invalidation

`invalidate(r, player?)` (on `app.resources`, and as `ctx.resources.invalidate(r)` in an
action, where the player defaults to the caller) says "the state behind `r` changed;
re-read it". It never carries a value: the server re-runs `load`, so the authoritative
read is the only source of what a client sees.

- Player scope: reloads that player's key, if they are subscribed; without a player,
  every subscribed player's key.
- Global scope: reloads once and sends the result to every subscriber.
- **Coalescing (backpressure).** Per resource and key at most one load runs, and at most
  one more is pending: an invalidation while a load runs marks the key dirty, and one
  reload follows when the running load finishes, however many invalidations arrived.
  On the wire, a batched channel replaces a state item for the same resource still
  queued for the same player this frame instead of adding a second one, keeping the
  first one's place. A burst of invalidations therefore costs one load in flight and one
  item per frame per subscriber. Keeping that place means the newer state overtakes
  whatever was queued between the two items (a response, a signal): a client can apply
  state that already reflects a call before the call's response arrives. It never
  applies older state after newer.
- **A load that never settles** holds its key: later invalidations mark it dirty and
  wait behind it, and new subscribers to a global resource wait on it. There is no load
  timeout; a `load` that can hang (an external request) should bound itself.
- **Read-your-writes.** When `load` returns synchronously, an `invalidate` inside an
  action's `run` queues the new state before the action's response, on the same
  channel, so the client applies it before the caller's `await` resumes. An async
  `load` settles when it settles; its item may follow the response.

### Unsubscribe and cleanup

- The client's last local listener for `r` disconnecting sends `unsubscribe(r)`. The
  server drops the key's subscription; a load still running for it finishes and is
  dropped.
- A player leaving drops every subscription and every per-key state they had; nothing
  keeps a reference to them once their in-flight loads settle. A subscription item that
  arrives after the leave is dropped.
- `app.dispose()` drops every subscription and stops pushing; loads still running settle
  into nothing.

### Reconnection and resync

A Roblox client does not reconnect: a disconnected player leaves, and coming back is a
new join with a new client. That new client subscribes from scratch and receives a fresh
snapshot (step 1). Within one session, `subscription.refresh()` (or
`resources.resync()` for all) sends `subscribe` again, which the server treats as a
resync: it loads and sends a fresh snapshot whatever the client holds. A resync is
idempotent; any number of them leave the client on the newest value. Each one is a
subscription item, charged to the player's request budget like a call; resyncs that
arrive while a load runs coalesce into one more load, synchronous ones do not. A resync
is authorized again: one that is refused ends the subscription it was refreshing.

`resources.dispose()` on the client unsubscribes everything it held.

## Errors

| Situation | Client sees | Server |
| --- | --- | --- |
| `load` throws or rejects | `status: "error"`, `error: "ResourceLoadError"`, last value kept | `onResourceError(error, { resourceId, player?, errorId })` |
| `load` returns a value that fails the schema or is not wire-safe | the same `ResourceLoadError` | the same, with the validation failure |
| `authorize` returns false or throws | `status: "error"`, `error: "ResourceForbiddenError"`; not subscribed (a refused resync unsubscribes) | — |
| `onResourceError` or a schema `refine` throws | the same `ResourceLoadError` | a `warn`; the key is free for the next load |
| subscription to an id the server does not define | nothing (dropped) | `onAbuse` `unknown-resource` |

No message travels with an error, by design: a `load` failure is a server bug or an
outage, and its message would name server code. `errorId` matches the client's report to
the server log, as for `ActionInternalError`.

## Interaction with actions and signals

- **Actions** mutate. A resource never does. An action that changes what a resource
  reads calls `ctx.resources.invalidate(...)`.
- **Signals** announce events ("a boss died"); resources hold state ("the boss's health
  is 40"). A signal can be missed by a client that was not listening; a resource cannot,
  once subscribed. Neither replaces the other.
- **Ordering.** State items, responses, and reliable signals share one ordered channel
  per player, so everything the server produced is read in the order it was produced.
  Unreliable signals stay on their own remote with no ordering promise; losing one never
  touches a resource.

### Optimistic calls

A call marked `o` (docs/rfcs/ui-bindings.md) carries tags into this protocol without
changing any rule above. When such a call invalidates a key its caller is subscribed to,
the server records a tag `(k, caller)` on the key before the load starts. A load takes
the tags recorded before it starts, and its item, when sent, names them to their caller
in `k` and drops them; an item that is not sent leaves them to the next load. The call's
response lists in `p` the resources whose tags are still undelivered. The client uses
both to remove its optimistic updates in the step that applies the first item containing
the call. A snapshot never carries an optimistic value.

## Scope limits of this version

- No client writes, no client-chosen scope, no implicit server mutation.
- Snapshots only; no patches, no diffing.
- No caching guarantees beyond "the newest value this server loaded": the server keeps a
  global resource's last value while it has subscribers, and nothing per player.
- One server. Revisions order a server's own items; nothing is coordinated across
  servers (a client never talks to two).

## Compiler and tooling

- `defineResource` is a compiler primitive (`resource`): `aruna::586
  invalid-resource-definition`, `aruna::587 duplicate-resource-id`, `aruna::588
  resource-schema-invalid` (warning), `aruna::589 resource-missing-schema`.
- Generated: `$aruna/resources/server` (the `resources` registry for `createServerApp`)
  and `$aruna/resources/client` (one typed binding per resource, the `Resources` type,
  and a `<ExportName>Value` alias per resource).
- Recorded in `manifest.resources`, listed by `aruna inspect resources`, included in the
  contract snapshot and the contract hash; `contract diff`: a removed resource or a
  changed scope is breaking, the value follows the output rules (it travels server to
  client).
