# Wire protocol v1

What travels over Aruna's RemoteEvents: action calls from client to server, their
responses back, and signals from server to client. One versioned frame shape carries all
three, and every item in a frame names its kind. The runtime is in
`packages/aruna/roblox/wire.ts` (frames, batching, and the two ends of the reliable
channel), `roblox.ts` (the default remotes), and `signal-runtime.ts` (the publisher and
subscriber); the compiler's size checks are in `crates/aruna_compiler/src/payload_size.rs`.

Before the first public release this can change freely
([stability.md](stability.md#before-the-first-public-release-now)); after it, a change
that an older peer cannot read is a new protocol version, never an edit to this one.
A draft for binary items (numeric ids, buffer payloads) is in
[rfcs/binary-wire.md](rfcs/binary-wire.md).

## Remotes

Both live in `ReplicatedStorage`, created by the server.

| Remote | Class | Client → server | Server → client |
| --- | --- | --- | --- |
| `ArunaRemoteEvent` (`REMOTE_NAME`) | `RemoteEvent` | call frames | response and signal frames: the reliable channel |
| `ArunaSignalUnreliableRemoteEvent` | `UnreliableRemoteEvent` | — | signal frames (`unreliable: true` signals); created only when the registry has one |

### One ordered reliable channel per player

Everything the server sends a player reliably — action responses, reliable signals, and
later resource patches — goes through **one outbox on one RemoteEvent**, flushed once per
frame. Roblox delivers the events of one RemoteEvent in order; it guarantees nothing
across two RemoteEvents, nor about the order two Heartbeat connections run in. With
responses and signals on separate remotes and separate outboxes, a signal published
inside an action's `run()` could reach the client after that action's response. On one
channel it cannot: the signal is queued while `run()` executes, the response when the
dispatch settles, and the client reads them in that order. This is the read-your-writes
guarantee a client can build on: whatever an action produced for the caller (a signal, a
patch) is handled before the caller's `await` resumes.

Both ends are shared, not per feature:

- **Server.** `ServerChannel` (`createServerChannel(remote, batchOptions)`) is the
  outbox. The default wiring keeps one per remote instance: `robloxRemoteEvent()` /
  `bindActions` queue responses and `createSignalPublisher` queues signals into the same
  one. `createRemoteEventChannel(batchOptions)` makes a separately batched channel over
  the default remote, for specs that step frames by hand; hand it to both
  `bindActions(registry, { channel })` and `createRemoteSignalPublisher(channel, ...)`.
  Two channels on one remote each keep their own order, not each other's.
- **Client.** `ClientChannel` (`createClientChannel(remote, name)`) is one connection to
  the remote that reads each frame and hands every item, in order, to the handlers for
  its kind. Handlers run synchronously while the frame is read, so a signal handler for
  an earlier item has returned before a later response settles its promise.
  `createActionInvoker` and `createSignalSubscriber` share the default remote's channel;
  `createRemoteActionInvoker(remote, channel)` and `createRemoteSignalSubscriber(channel,
  ...)` take one explicitly. Connecting each to the remote separately would bring the
  reordering back: Roblox does not order a remote's connections either.

**Calls stay on the same remote.** A RemoteEvent's two directions are independent
(`FireServer`/`OnServerEvent` and `FireClient`/`OnClientEvent`), so calls sharing the
remote cost nothing in ordering or throughput, and a separate call remote would buy
nothing: no ordering is promised between a client's calls and anything else. One remote
means one instance to create, wait for, and carry the contract-hash attribute, and the
frame grammar is the same in both directions — a future client → server kind (a resource
subscription, say) is a new kind value, not a new remote.

**Unreliable signals are not on the channel.** They keep their own
`UnreliableRemoteEvent`, unbatched, so they carry no ordering promise relative to
anything else, by design.

## Frame

Every fire carries exactly one argument, a frame: an array whose first element is the
protocol version and whose remaining elements are the items.

```lua
{ 1, item, item, ... }
```

| Index | Type | Meaning |
| --- | --- | --- |
| `[1]` | number | Protocol version, `1` (`WIRE_PROTOCOL_VERSION`). |
| `[2]` … `[n + 1]` | table | The frame's `n` items, `1 ≤ n ≤ 64` (`WIRE_MAX_FRAME_ITEMS`), in the order they were produced. On the reliable remote's server → client direction, responses and signals interleave in that order. |

Items are always tables, so a frame never has a hole and Roblox sends it as an array.
Every item field below is optional only where it says so; an absent optional field is
simply not in the table (Roblox drops a `nil` value anyway).

### Item kinds

Every item carries its kind in `t`, a small integer. One numbering covers both
directions, so a value never means two things, and a value is never reused for another
kind.

| `t` | Constant | Kind | Direction | Remote |
| ---: | --- | --- | --- | --- |
| `1` | `WIRE_ITEM_CALL` | call | client → server | `ArunaRemoteEvent` |
| `2` | `WIRE_ITEM_RESPONSE` | response | server → client | `ArunaRemoteEvent` |
| `3` | `WIRE_ITEM_SIGNAL` | signal | server → client | `ArunaRemoteEvent` (reliable), `ArunaSignalUnreliableRemoteEvent` (unreliable) |
| `4` | `WIRE_ITEM_RESOURCE_PATCH` | resource patch, **reserved** | server → client | `ArunaRemoteEvent` |

A number rather than a name: 8 bytes against 8 plus the name's length, on every item.
Kind 4 is reserved so resource patches join the reliable channel without renumbering:
nothing sends it yet. A client skips an item whose kind it has no handler for (and an
item with no numeric `t`); the server treats any item that is not a call as a malformed
call (below).

### Call (`t = 1`, client → server)

| Field | Type | Meaning |
| --- | --- | --- |
| `t` | `1` | Item kind. |
| `i` | string, ≤ 64 bytes | Request id, unique per pending call on this client. Echoed in the response. |
| `a` | string, ≤ 128 bytes | Action id. |
| `d` | any wire-safe value, optional | The action's input. |
| `k` | string, ≤ 64 bytes, optional | Idempotency key: every attempt of one call carries the same key, and the server runs the call once per key ([actions.md](../packages/aruna/docs/actions.md)). Anything else in `k` is ignored. |

A fire-and-forget call is an ordinary call: the server knows from the action's
declaration that it sends no response.

### Response (`t = 2`, server → client)

| Field | Type | Meaning |
| --- | --- | --- |
| `t` | `2` | Item kind. |
| `i` | string | The request id of the call this answers. |
| `r` | table | The dispatch result, below. |

| `r` field | Type | Meaning |
| --- | --- | --- |
| `ok` | boolean | Whether the action succeeded. |
| `output` | any, optional | The action's output, when `ok`. |
| `error` | string, optional | The failure's message, when not `ok`. |
| `errorName` | string, optional | `ActionValidationError`, `ActionRateLimitError`, `ActionNotFoundError`, `ActionSerializationError`, `ActionInternalError`, or an `actionError` name. |
| `retryAfterMs`, `resetAtMs` | number, optional | On a rate-limit refusal. |
| `errorId` | string, optional | On `ActionInternalError`: the id the server's `onError` got. |
| `errorData` | any wire-safe value, optional | On an error the action declares with `data`: the data, checked against the declared schema ([declared errors](../packages/aruna/docs/actions.md#declared-errors)). |

### Signal (`t = 3`, server → client)

| Field | Type | Meaning |
| --- | --- | --- |
| `t` | `3` | Item kind. |
| `s` | string | Signal id. |
| `d` | any, optional | The payload: the value itself, or an `encodeBinary` buffer for a `wire: "binary"` signal. |

## Batching

Each side queues the items it produces and fires them together **once per frame, at
`RunService.Heartbeat`**, on both client and server. Heartbeat runs after the frame's
input handlers, `RenderStepped`/`PreRender`, `Stepped`/`PreSimulation` and physics, and
before the engine sends the frame's network traffic, so everything game code produced that
frame leaves together with no added latency: the packet would not have left any earlier.
An item produced inside a Heartbeat handler that runs after the flush goes out the next
frame (about 16 ms later).

- **Client.** An invoke queues its call; the flush fires one frame per 64 calls.
  Timeouts start at the invoke, so they include the wait for the flush.
- **Server, the reliable channel.** A response is queued for its player when its
  dispatch settles; `to` and `toMany` queue a signal per player, `toAll` once for
  everyone — all into the one server channel, in the order they happen. A signal
  published inside `run()` is therefore always queued before that action's response.
  The flush keeps every player's order across kinds: a player's items are merged across
  the frame, and a broadcast closes the per-player run before it (and the other way
  round), so a player never reads a broadcast, a targeted signal, and a response out of
  the order they were produced. Several actions dispatched in one frame keep their order
  too: each one's signals, then its response, then the next.
- **Unreliable signals are never batched.** Each goes out at once, alone in its frame.
  Batching them would make a frame's size depend on what else was published that frame,
  which neither the compiler nor the publisher can check against the 900-byte limit, and
  one dropped packet would lose every signal in it. Alone, its size is one signal's, which
  the compiler checks (`aruna::510`/`511`/`513`) and the publisher measures exactly for a
  binary payload.

`batching: false` (on `createActionInvoker` / `createRemoteActionInvoker` for calls, and
on a server channel, `createServerChannel` / `createRemoteEventChannel`, for everything
the server sends reliably) fires every item in its own frame as it is produced. The
receiver cannot tell the difference: a batched and an unbatched side produce the same
results in the same order.

The test harness (`createTestServerApp`) is unbatched by default, so `published()` sees a
signal without waiting a frame and a client's invoke dispatches in-process. With
`batching: true` it runs the wire as a game does: a manual frame scheduler holds every
client's calls and the server channel until `step()`, a client's calls travel the real
action binding, and its responses come back through the server channel with the signals,
so a spec can assert the order a client reads them in. A step sends the clients' calls
first and then the server channel, so an action that settles at once is answered in the
step that sends its call.

## Receiving

A frame is checked in this order, and a check that fails drops the frame **whole**,
before any item in it is read:

1. it is a table whose `[1]` is present (else `malformed-frame`);
2. `[1]` is `1` (else `unknown-protocol-version`);
3. it holds 1 to 64 items (`#frame - 1`; else `malformed-frame` for none,
   `oversize-batch` for more).

A client reads the reliable remote through one `ClientChannel`, so this check runs once
per frame, not once per reader.

| Side | A dropped frame |
| --- | --- |
| Server | Charged **one** request from the player's budget and reported through `onAbuse`: `malformed-envelope`, `unknown-protocol-version`, or `oversize-batch`. A frame from a player who already left is dropped without a report. |
| Client | Dropped, and reported to `onProtocolError` (an option of `createActionInvoker` and `createRemoteSignalSubscriber`). The default warns once per remote and reason, in Studio only: a client always runs its own server's build, so a mismatch is a development problem. |

Then each item, in order. On the server, every item is charged **one request** from the
player's budget before anything else in it is read (`requestBudget`: a burst and a refill
rate), exactly as a call in its own frame would be: an item whose `t` is not `1`, or a
call with a bad `i` or `a`, is charged and reported as `malformed-envelope`; a call past
the budget is dropped and reported as `budget-exhausted`; a call whose `a` names no action
is charged, dropped, and reported as `unknown-action`. None of them gets a response, and
the rest of the frame is still read. The in-flight cap, the action's own `rateLimit`,
validation, middleware, and idempotency then apply per call as they always do; a call the
action's `rateLimit` admits is given its request back
([actions.md](../packages/aruna/docs/actions.md#the-request-budget-in-front-of-dispatch)).

## Size accounting

Roblox does not document how it encodes a remote's arguments. Aruna's checks assume each
value costs a type tag plus a length or count, and allow **8 bytes per value** for that,
plus the bytes of every string (keys included). A value is anything Roblox encodes: a
table, a number, a string, a boolean, a buffer. Array indices are not values; a table's
string keys are. Erring high only means a size warning comes a little early.

| Part | Values | Key bytes | Bytes |
| --- | ---: | ---: | --- |
| Frame: the array, the version | 2 | — | 16 |
| Kind tag, in every item: key `t` and its number | 2 | 1 | 17 |
| Signal item: the table, keys `t`, `s`, `d`, the kind, the id, the payload | 7 | 3 | 59 + id bytes + payload bytes |
| Call item: the table, keys `t`, `i`, `a`, `d`, the kind, the two ids, the input (+ key `k` and its value) | 9 (11) | 4 (5) | 76 + both ids' bytes + input bytes (+ 17 + key bytes) |
| Response item: the table, keys `t`, `i`, `r`, the kind, the id, the result table (+ its fields) | 7 | 3 | 59 + id bytes + result bytes |

The kind tag costs every item 17 bytes; the item rows include it.

**An unreliable signal** is always one item in one frame:

```
size = payload bytes + signal id bytes + 75
```

75 is `SIGNAL_FRAME_OVERHEAD_BYTES` in the runtime and `WIRE_SIGNAL_FRAME_OVERHEAD_BYTES`
in the compiler: nine values (the frame, the version, the item, keys `t`, `s` and `d`, the
kind, the id, the payload) × 8 + the three one-byte keys. A binary payload's bytes are its `encodeBinary` frame, 4-byte header included,
and its size is exact; a table payload's are the binary layout's size as a floor, since
the table encoding adds a tag and a key per value.

- The compiler compares this size against Roblox's 900-byte unreliable limit:
  `aruna::511` (error) over it, `aruna::513` (warning) past 75% of it for a table
  payload, `aruna::510` (warning) when the schema leaves the payload unbounded.
- The publisher checks a binary unreliable payload against the same total before firing
  and throws instead of sending one Roblox would drop. A table payload has no size the
  runtime can measure, so it is not checked at runtime.

A reliable frame has no Roblox size limit to check against; its size only matters as
bandwidth, and batching saves the 16-byte frame overhead on every item after the first —
across kinds, now that responses and signals for a player share a frame.
