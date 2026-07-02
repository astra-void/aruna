# Signals

A **signal** is a server → client push channel — the counterpart to an action. The server
emits; subscribed clients receive. There is no response. Define once with `defineSignal`;
the compiler generates a typed signal registry in `$aruna/signals`.

## `defineSignal`

Identity helper, same pattern as `defineAction`. Available from both `aruna/server` and
`aruna/roblox`.

```ts
import { defineSignal } from "aruna/server";
import { schema } from "aruna/schema";

export const playerDamaged = defineSignal({
  id: "combat.playerDamaged",
  payload: schema.object({
    amount: schema.u16(),
    source: schema.string(),
    position: schema.vector3(),
  }),
});

export const worldTick = defineSignal({ id: "world.tick" }); // no payload (untyped)
```

```ts
type SignalDefinition<TPayload> = {
  readonly id: string;
  readonly payload?: Schema;   // omit for a payloadless signal
};
```

## Generated registry

After `aruna build`, `$aruna/signals` exports `signals` — a registry of every discovered
signal — plus payload type aliases. Both the publisher and the subscriber are keyed by
this registry, so signal ids and payload types stay in sync across both sides.

```ts
import { signals } from "$aruna/signals";
```

## Server: publishing

`createSignalPublisher(signals)` (from `aruna/roblox`) is the turnkey entry point: it
ensures the default `ReplicatedStorage/Aruna/Signals` RemoteEvent **at call time** and
returns a typed publisher. Call it once at server boot — that single call creates the
signal remote before any client subscribes, so you no longer need a hand-written
lazy-singleton plumbing module. Payloads are validated before they go on the wire.

```ts
import { createSignalPublisher } from "aruna/roblox";
import { signals } from "$aruna/signals";

const publisher = createSignalPublisher(signals);

// to one player
publisher.to(player, "combat.playerDamaged", {
  amount: 42, source: "trap", position: { x: 100, y: 10, z: -50 },
});

// to several
publisher.toMany(playersInArea, "combat.playerDamaged", { amount: 15, source: "blast", position: { x: 0, y: 0, z: 0 } });

// to everyone
publisher.toAll("world.tick", undefined);
```

The `signalId` argument is constrained to the registry's keys, and the payload type is
inferred from that signal's schema — a wrong id or mismatched payload is a compile error.

Even better, let `createServerApp` **own** the publisher so it is built (and the remote
created) at boot alongside your actions:

```ts
import { createServerApp } from "aruna/server";
import { robloxRemoteEvent, createSignalPublisher } from "aruna/roblox";
import { actions, defaultRateLimit } from "$aruna/actions/server";
import { signals } from "$aruna/signals";

const serverApp = createServerApp<Player>({
  actions,
  defaultRateLimit,
  transport: robloxRemoteEvent(),
  signals,
  createPublisher: createSignalPublisher, // app ensures the signal remote at boot
});

serverApp.publisher?.toAll("world.tick", undefined);
```

> **Advanced:** `createRemoteSignalPublisher(remote, signals)` is the lower-level overload
> when you supply your own RemoteEvent instead of the default Aruna signal remote.

## Publishing from inside an action

When `createServerApp` owns the publisher, it is **injected into every action's `ctx`**, so
an action's `run` can publish signals directly — no hand-written holder module, no importing
the server entry (which would be a cycle). On the base `defineAction`, `ctx.publisher` is
optional (`ctx.publisher?.toAll(...)`), since an app may own no publisher.

To get a non-optional, registry-checked `ctx.publisher`, bind a `defineAction` to your signal
registry once with `createActionDefiner` and import that from your action modules:

```ts
// src/shared/define.ts — one small, runtime-stateless module
import { createActionDefiner } from "aruna/server";
import type { Signals } from "$aruna/signals";

export const defineAction = createActionDefiner<Signals, Player>();
```

```ts
// src/domains/combat/actions.ts
import { defineAction } from "../../shared/define";
import { schema } from "aruna/schema";

export const dealDamage = defineAction({
  id: "combat.dealDamage",
  input: schema.object({ amount: schema.number() }),
  run(ctx, input) {
    // Typed against the signal registry: a wrong id or payload is a compile error.
    ctx.publisher.to(ctx.player, "combat.playerDamaged", {
      amount: input.amount,
      source: "melee",
      position: { x: 0, y: 0, z: 0 },
    });
    return undefined;
  },
});
```

The publisher is still owned and built by `createServerApp`; `createActionDefiner` is pure
typing sugar that carries the registry type to `ctx.publisher` — it holds no runtime state.

## Client: subscribing

`createSignalSubscriber(signals, options?)` (from `aruna/roblox`) is the turnkey subscriber:
it waits for the default signal remote and returns a typed subscriber. Register handlers up
front via `handlers`, or dynamically via `on`.

```ts
import { createSignalSubscriber } from "aruna/roblox";
import { signals } from "$aruna/signals";

const subscriber = createSignalSubscriber(signals, {
  handlers: {
    "combat.playerDamaged": (payload) => {
      // payload typed: { amount: number; source: string; position: { x,y,z } }
      showDamage(payload.amount, payload.position);
    },
    "world.tick": () => tick(),
  },
});

// dynamic subscription
const connection = subscriber.on("combat.playerDamaged", (p) => updateHud(p));
connection.disconnect();

// teardown all handlers
subscriber.dispose();
```

> **Advanced:** `createRemoteSignalSubscriber(remote, signals, options?)` is the lower-level
> overload for a RemoteEvent you supply yourself.

Payloads that fail validation on arrival are dropped rather than thrown — a malformed
push from a misbehaving peer won't crash the client.
