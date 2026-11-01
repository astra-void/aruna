# Resources

A **resource** is state the server owns and clients observe: quest progress, a boss's
health, a player's inventory as the HUD shows it. You declare how the server reads it;
Aruna sends each subscribed client a snapshot, sends a new one whenever the server says
the state changed, and guarantees the client never ends up on an older value than one
it already had.

Resources are for **observation**. Clients cannot write one. Change state with an
[action](actions.md) (or the server's own systems), then invalidate the resource.

The protocol, and why it is race-free, is in
[docs/rfcs/resources.md](../../../docs/rfcs/resources.md).

## Defining one

```ts
// src/domains/quests/resources.ts — a defineResource file is server code
import { defineResource } from "aruna/roblox"; // or aruna/server (player type left open)
import { schema } from "aruna/schema";
import { questStore } from "./server/store";

export const questProgress = defineResource({
  id: "quests.progress",
  schema: schema.object({ quest: schema.string().maxLength(32), step: schema.u16() }),
  load(ctx) {
    return questStore.snapshot(ctx.player.UserId); // may return a promise
  },
});

export const bossHealth = defineResource({
  id: "encounter.boss",
  scope: "global",              // one value for everyone (default: "player")
  schema: schema.object({ health: schema.u16() }),
  load: () => ({ health: boss.health }),
  authorize: (ctx) => isInEncounter(ctx.player), // optional
});
```

| Field | |
| --- | --- |
| `id` | Static string literal, unique (`aruna::586`, `aruna::587`). |
| `scope` | `"player"`: one value per player; a client only ever receives its own. `"global"`: one value, loaded once per change, sent to every subscriber. |
| `schema` | Required (`aruna::589`). A loaded value that fails it — or is not wire-safe — is never sent. |
| `load(ctx)` | The authoritative read, run on subscribe and on every invalidation. `ctx.player`, `ctx.session`, `ctx.store` for a player-scoped resource. |
| `authorize` | Optional, a property (`authorize: (ctx) => boolean`). Runs on every subscription; `false` or a throw refuses it with `ResourceForbiddenError`. |

## Serving them

`aruna build` generates `$aruna/resources/server` (the registry) and
`$aruna/resources/client` (typed bindings). Give the registry to the server app:

```ts
// src/server.ts
import { createServerApp } from "aruna/server";
import { robloxRemoteEvent } from "aruna/roblox";
import { actions } from "$aruna/actions/server";
import { resources } from "$aruna/resources/server";

const app = createServerApp<Player>({
  actions,
  resources,
  transport: robloxRemoteEvent(),
  onResourceError: (failure, info) => warn(`[${info.errorId}] ${info.resourceId}: ${failure}`),
});
```

The app owns the resource host (`app.resources`), drops a player's subscriptions when
they leave, and stops sending on `dispose()`. `entries: "generated"` wires all of this
for you.

## Invalidating

Invalidation says "the state behind this resource changed; read it again". It never
carries a value: what a client sees always comes from `load`.

```ts
export const advanceQuest = defineAction({
  id: "quests.advance",
  run(ctx) {
    questStore.advance(ctx.player.UserId);
    ctx.resources?.invalidate(questProgress); // the calling player's value
  },
});

// Anywhere on the server:
app.resources!.invalidate(questProgress, player); // one player's value
app.resources!.invalidate(questProgress);         // every subscribed player's
app.resources!.invalidate(bossHealth);            // a global resource: once, to everyone
```

- When `load` returns synchronously, an invalidation inside an action reaches the client
  **before that action's response**, on the same ordered channel — so after
  `await advanceQuest()` the HUD already shows the new step.
- A burst of invalidations is coalesced: one load runs at a time per resource and
  player, at most one more follows it, and a batched channel sends one snapshot per
  resource per player per frame.

## Subscribing on the client

```ts
// src/client.tsx
import { createClientApp } from "aruna/client";
createClientApp({ resources: true }); // installs the default resource client

// anywhere on the client
import { questProgress } from "$aruna/resources/client";

const subscription = questProgress.subscribe((value, info) => {
  renderQuest(value.quest, value.step); // typed from the schema
});
subscription.get();       // the newest value, or undefined before the first
subscription.status();    // "loading" | "ready" | "error"
subscription.revision();  // the revision of the newest item applied
subscription.refresh();   // ask for a fresh snapshot
subscription.disconnect();
```

- Several local subscriptions to one resource share one subscription on the wire; the
  last `disconnect()` unsubscribes. A subscription made while the resource already has a
  value is handed it at once.
- `subscribe(listener, { onError })` is told `ResourceLoadError` (a `load` that failed,
  with the `errorId` the server's `onResourceError` got) or `ResourceForbiddenError`.
  The last value stays; the next successful snapshot clears the error.
- `app.resources.resync()` asks for a fresh snapshot of everything subscribed.
- The `Resources` type maps each id to its value type, and `<ExportName>Value` is each
  value type on its own.

## Guarantees, and what is not guaranteed

- **No stale overwrite.** Every snapshot carries a revision from one per-server
  counter, taken when its load starts. Neither end ever goes backwards: a snapshot
  older than one already applied is dropped, as is a duplicate or an item with a
  malformed revision.
- **No missed change.** The server registers a subscription before it loads the first
  snapshot, so every invalidation after that point reaches the subscriber.
- **No cross-player leak.** The client sends a resource id and nothing else; a
  player-scoped resource is always loaded for the player the subscription came from.
- **Admission.** Subscriptions are charged against the player's request budget like
  calls; an unknown resource id is dropped and reported to `onAbuse` as
  `unknown-resource`.
- **Not guaranteed:** delivery to a client that left (a rejoin subscribes from scratch
  and gets a fresh snapshot), patches (every item is a whole snapshot), or any caching
  beyond a global resource's last value while it has subscribers.

## Testing

`createTestServerApp({ resources })` runs the real host; `harness.client(player)` has a
real resource client (`client.resources`). See [testing.md](testing.md#resources) and the
multiplayer network there.

## Diagnostics and tooling

`aruna inspect resources` lists every resource with its scope, value shape, and whether
subscriptions are authorized. Resources are in the contract snapshot and its hash;
`aruna contract diff` reports a removed resource or a changed scope as breaking, and the
value's fields by the output rules (a removed field breaks clients, an added one does
not).
