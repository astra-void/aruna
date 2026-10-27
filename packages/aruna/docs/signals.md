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
ensures the default `ReplicatedStorage/ArunaSignalRemoteEvent` **at call time** and
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

The recommended wiring lets the client app own the subscriber, mirroring the server app
owning the publisher — no plumbing module, disposed with the app:

```ts
import { createClientApp } from "aruna/client";
import { createSignalSubscriber } from "aruna/roblox";
import { signals } from "$aruna/signals";

const clientApp = createClientApp({
  signals,
  createSubscriber: createSignalSubscriber,
});

clientApp.subscriber?.on("combat.playerDamaged", (p) => updateHud(p)); // typed
```

Standalone, `createSignalSubscriber(signals)` (from `aruna/roblox`) is the turnkey
subscriber: it waits for the default signal remote and returns a typed subscriber.
`.on(id, handler)` is the subscribe API; it returns a disconnectable handle.

```ts
import { createSignalSubscriber } from "aruna/roblox";
import { signals } from "$aruna/signals";

const subscriber = createSignalSubscriber(signals);

const connection = subscriber.on("combat.playerDamaged", (payload) => {
  // payload typed: { amount: number; source: string; position: { x,y,z } }
  showDamage(payload.amount, payload.position);
});
connection.disconnect();

// teardown all handlers
subscriber.dispose();
```

> **Advanced:** `createRemoteSignalSubscriber(remote, signals)` is the lower-level
> overload for a RemoteEvent you supply yourself.

Payloads that fail validation on arrival are dropped rather than thrown — a malformed
push from a misbehaving peer won't crash the client.

## Unreliable signals

High-frequency, latest-value-wins channels (movement replication, VFX ticks) can opt out
of reliable ordered delivery:

```ts
export const playerMoved = defineSignal({
  id: "player.moved",
  unreliable: true, // routed over ArunaSignalUnreliableRemoteEvent
  payload: schema.object({ x: schema.f32(), y: schema.f32(), z: schema.f32() }),
});
```

When any signal in the registry declares `unreliable: true`, the turnkey publisher and
subscriber automatically create/wait for a dedicated
`ReplicatedStorage/ArunaSignalUnreliableRemoteEvent` and route those signals over it —
reliable signals are untouched, and no unreliable remote is created when nothing needs
it. Caveats: delivery and ordering are **not guaranteed** (never use it for state a
client must not miss), and Roblox caps unreliable payloads at roughly **900 bytes**.
The flag is compiler-discovered and recorded in the manifest.

### Payload size

Roblox drops an unreliable payload over its limit without an error on either side, so
the compiler checks it. It computes the largest encoding a payload schema allows — the
size of its `encodeBinary` frame — and records it as `maxEncodedBytes` in the manifest,
`aruna inspect signals`, and the contract snapshot:

- every number, boolean, literal, enum, and Roblox value type counts at its fixed width
  (`u8` is 1 byte, `number` 8, `vector3` 12, `cframe` 48)
- a string needs `.maxLength(n)` (or `.length(n)`), or `.maxChars(n)`, counted as 4n bytes;
  an array `.maxItems(n)`
- an optional or a union counts its largest branch
- a `schema.record(...)` is never bounded

| Code | When | Severity |
| --- | --- | --- |
| `aruna::510 unreliable-signal-payload-unbounded` | an unreliable signal's payload has no bound | warning |
| `aruna::511 unreliable-signal-payload-too-large` | its largest message is over 900 bytes | error |
| `aruna::513 unreliable-signal-payload-near-limit` | table encoding, and its size floor is over 75% of the limit | warning |

The limit applies to the whole message, and the remote carries `{ signalId, payload }`,
not the payload alone. So the compared size is the payload plus the signal id's bytes
plus a fixed 55-byte envelope allowance: the two key strings (`"signalId"` and
`"payload"`, 15 bytes) and 8 bytes for each of the table's five values. Roblox does not
document its remote encoding; 8 bytes covers a type tag and a length prefix with room to
spare, and erring high only means a warning comes a little early.

For a `wire: "binary"` signal the 4-byte frame header counts, and the size is exact. For
the default table encoding the binary size is a floor — Roblox adds a type tag and key per
value on top — so an error there is certain, while staying under it is not a guarantee.
That is what `aruna::513` is for: once the floor plus the envelope is past 75% of the
limit, the real size may well be over it, and the fix is `wire: "binary"`, whose size the
compiler and the publisher both know exactly. String lengths are counted in UTF-8 bytes,
as `.maxLength` is in both runtimes.

The compiler can only check a bounded schema. When it cannot (`aruna::510`), a binary
unreliable signal is still checked at runtime: the publisher measures each frame plus the
envelope before firing and throws instead of sending one Roblox would drop — `Unreliable
signal fx.burst carries 931 bytes, over Roblox's 900-byte unreliable limit; …`, in both
runtimes (`toBatched` rejects with it). A table-encoded payload has no size the runtime
can measure, so it is not checked.

## Binary wire

`wire: "binary"` sends a signal's payload as an `encodeBinary` buffer, laid out from the
payload schema: no field names or type tags, numbers at their declared width.

```ts
export const playerMoved = defineSignal({
  id: "player.moved",
  unreliable: true,
  wire: "binary", // 4 + 3 x 4 = 16 bytes per message
  payload: schema.object({ x: schema.f32(), y: schema.f32(), z: schema.f32() }),
});
```

The publisher validates the payload as always, then encodes it; the subscriber decodes it
before the schema check and the handlers, so handlers see the same value either way.
Every frame starts with a fingerprint of the schema's layout: a client holding a
different schema drops the message, exactly as it drops a payload that fails
validation, instead of misreading the bytes. The frame is byte-identical between the
Node and native runtimes.

`wire` must be the string literal `"binary"`, and the signal needs a payload schema the
codec can encode — no `schema.instance()` (`aruna::512 invalid-signal-wire` otherwise).
Changing a signal's wire is a breaking change in `aruna contract diff`.
