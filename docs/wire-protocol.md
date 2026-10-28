# Wire protocol v1

What travels over Aruna's RemoteEvents: action calls from client to server, their
responses back, and signals from server to client. One versioned frame shape carries all
three. The runtime is in `packages/aruna/roblox/wire.ts` (frames and batching),
`roblox.ts` (the action remote), and `signal-runtime.ts` (the signal remotes); the
compiler's size checks are in `crates/aruna_compiler/src/payload_size.rs`.

Before the first public release this can change freely
([stability.md](stability.md#before-the-first-public-release-now)); after it, a change
that an older peer cannot read is a new protocol version, never an edit to this one.

## Remotes

All three live in `ReplicatedStorage`, created by the server.

| Remote | Class | Client → server | Server → client |
| --- | --- | --- | --- |
| `ArunaActionRemoteEvent` | `RemoteEvent` | call frames | response frames |
| `ArunaSignalRemoteEvent` | `RemoteEvent` | — | signal frames (reliable signals) |
| `ArunaSignalUnreliableRemoteEvent` | `UnreliableRemoteEvent` | — | signal frames (`unreliable: true` signals); created only when the registry has one |

Which remote and direction a frame arrives on decides what its items are; the frame says
nothing about it.

## Frame

Every fire carries exactly one argument, a frame: an array whose first element is the
protocol version and whose remaining elements are the items.

```lua
{ 1, item, item, ... }
```

| Index | Type | Meaning |
| --- | --- | --- |
| `[1]` | number | Protocol version, `1` (`WIRE_PROTOCOL_VERSION`). |
| `[2]` … `[n + 1]` | table | The frame's `n` items, `1 ≤ n ≤ 64` (`WIRE_MAX_FRAME_ITEMS`), in the order they were produced. |

Items are always tables, so a frame never has a hole and Roblox sends it as an array.
Every item field below is optional only where it says so; an absent optional field is
simply not in the table (Roblox drops a `nil` value anyway).

### Call (client → server, action remote)

| Field | Type | Meaning |
| --- | --- | --- |
| `i` | string, ≤ 64 bytes | Request id, unique per pending call on this client. Echoed in the response. |
| `a` | string, ≤ 128 bytes | Action id. |
| `d` | any wire-safe value, optional | The action's input. |
| `k` | string, ≤ 64 bytes, optional | Idempotency key: every attempt of one call carries the same key, and the server runs the call once per key ([actions.md](../packages/aruna/docs/actions.md)). Anything else in `k` is ignored. |

A fire-and-forget call is an ordinary call: the server knows from the action's
declaration that it sends no response.

### Response (server → client, action remote)

| Field | Type | Meaning |
| --- | --- | --- |
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

### Signal (server → client, signal remotes)

| Field | Type | Meaning |
| --- | --- | --- |
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
- **Server, responses.** A response is queued per player when its dispatch settles; the
  flush fires each player's responses in one frame.
- **Server, reliable signals.** `to`, `toMany`, and `toAll` queue per player, or for
  everyone. The flush keeps every player's order: a player's items are merged across the
  frame, and a broadcast closes the per-player run before it (and the other way round), so
  a player never sees a broadcast and a targeted signal out of the order they were
  published.
- **Unreliable signals are never batched.** Each goes out at once, alone in its frame.
  Batching them would make a frame's size depend on what else was published that frame,
  which neither the compiler nor the publisher can check against the 900-byte limit, and
  one dropped packet would lose every signal in it. Alone, its size is one signal's, which
  the compiler checks (`aruna::510`/`511`/`513`) and the publisher measures exactly for a
  binary payload.

`batching: false` (on `createActionInvoker`, `robloxRemoteEvent`/`bindActions`,
`createSignalPublisher`/`createRemoteSignalPublisher`) fires every item in its own frame
as it is produced. The receiver cannot tell the difference: a batched and an unbatched
side produce the same results. The test harness (`createTestServerApp`) publishes
unbatched, so `published()` sees a signal without waiting a frame.

## Receiving

A frame is checked in this order, and a check that fails drops the frame **whole**,
before any item in it is read:

1. it is a table whose `[1]` is present (else `malformed-frame`);
2. `[1]` is `1` (else `unknown-protocol-version`);
3. it holds 1 to 64 items (`#frame - 1`; else `malformed-frame` for none,
   `oversize-batch` for more).

| Side | A dropped frame |
| --- | --- |
| Server | Charged **one** request from the player's budget and reported through `onAbuse`: `malformed-envelope`, `unknown-protocol-version`, or `oversize-batch`. A frame from a player who already left is dropped without a report. |
| Client | Dropped, and reported to `onProtocolError` (an option of `createActionInvoker` and `createRemoteSignalSubscriber`). The default warns once per remote and reason, in Studio only: a client always runs its own server's build, so a mismatch is a development problem. |

Then each item, in order. On the server, every call is charged **one request** from the
player's budget before anything else in it is read (`requestBudget`: a burst and a refill
rate), exactly as a call in its own frame would be: a call with a bad `i` or `a` is charged
and reported as `malformed-envelope`, and a call past the budget is dropped and reported as
`budget-exhausted`. Neither gets a response, and the rest of the frame is still read. The
in-flight cap, the action's own `rateLimit`, validation, middleware, and idempotency then
apply per call as they always do.

## Size accounting

Roblox does not document how it encodes a remote's arguments. Aruna's checks assume each
value costs a type tag plus a length or count, and allow **8 bytes per value** for that,
plus the bytes of every string (keys included). A value is anything Roblox encodes: a
table, a number, a string, a boolean, a buffer. Array indices are not values; a table's
string keys are. Erring high only means a size warning comes a little early.

| Part | Values | Key bytes | Bytes |
| --- | ---: | ---: | --- |
| Frame: the array, the version | 2 | — | 16 |
| Signal item: the table, keys `s` and `d`, the id, the payload | 5 | 2 | 42 + id bytes + payload bytes |
| Call item: the table, keys `i`, `a`, `d`, the two ids, the input (+ key `k` and its value) | 7 (9) | 3 (4) | 59 + both ids' bytes + input bytes (+ 17 + key bytes) |
| Response item: the table, keys `i` and `r`, the id, the result table (+ its fields) | 5 | 2 | 42 + id bytes + result bytes |

**An unreliable signal** is always one item in one frame:

```
size = payload bytes + signal id bytes + 58
```

58 is `SIGNAL_FRAME_OVERHEAD_BYTES` in the runtime and `WIRE_SIGNAL_FRAME_OVERHEAD_BYTES`
in the compiler: seven values (the frame, the version, the item, keys `s` and `d`, the id,
the payload) × 8 + the two one-byte keys. A binary payload's bytes are its `encodeBinary`
frame, 4-byte header included, and its size is exact; a table payload's are the binary
layout's size as a floor, since the table encoding adds a tag and a key per value.

- The compiler compares this size against Roblox's 900-byte unreliable limit:
  `aruna::511` (error) over it, `aruna::513` (warning) past 75% of it for a table
  payload, `aruna::510` (warning) when the schema leaves the payload unbounded.
- The publisher checks a binary unreliable payload against the same total before firing
  and throws instead of sending one Roblox would drop. A table payload has no size the
  runtime can measure, so it is not checked at runtime.

A reliable frame has no Roblox size limit to check against; its size only matters as
bandwidth, and batching saves the 16-byte frame overhead on every item after the first.
