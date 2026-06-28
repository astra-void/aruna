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

`createRemoteSignalPublisher(remote, signals)` (from `aruna/roblox`) returns a typed
publisher over a RemoteEvent. Payloads are validated before they go on the wire.

```ts
import { createRemoteSignalPublisher } from "aruna/roblox";
import { signals } from "$aruna/signals";

const publisher = createRemoteSignalPublisher(signalRemote, signals);

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

## Client: subscribing

`createRemoteSignalSubscriber(remote, signals, options?)` (from `aruna/roblox`) returns a
typed subscriber. Register handlers up front via `handlers`, or dynamically via `on`.

```ts
import { createRemoteSignalSubscriber } from "aruna/roblox";
import { signals } from "$aruna/signals";

const subscriber = createRemoteSignalSubscriber(signalRemote, signals, {
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

Payloads that fail validation on arrival are dropped rather than thrown — a malformed
push from a misbehaving peer won't crash the client.
