# RFC: binary items on the wire

**Status:** draft. Not scheduled: transport changes are outside the current release's cut
line. This document records the design and what has to be measured before it is built.

## Summary

Let an action or a signal opt into `wire: "binary"`, and send its items as buffers: the
call, the response, or the signal encoded with the schema-driven binary codec Aruna
already has, addressed by a numeric index instead of a string id, inside the existing
frame grammar. Protocol version 2 is version 1 plus buffer items and a contract
fingerprint per frame.

## What a call costs today

Everything travels as Lua tables ([wire protocol v1](../wire-protocol.md)): string action
ids, string request ids, and the payload as a table. Using the size model in
[wire-protocol.md](../wire-protocol.md#size-accounting) (8 bytes per value Roblox encodes,
plus every string's bytes, keys included) for three shapes:

| Shape | Today: per item in a batch / alone in a frame | Proposed: per item / alone | Ratio |
| --- | ---: | ---: | ---: |
| Call `shop.purchaseItem`, request id `aruna-42`, input `{ itemId: "sword", quantity: 2 }` | 152 / 168 B | 24 / 48 B | 6.3× / 3.5× |
| The same call with a medium input (an 18-character item id, three tags, a coupon, two flags) | 315 / 331 B | 80 / 104 B | 3.9× / 3.2× |
| Its response `{ ok = true, output = { ok = true } }` | 125 / 141 B | 13 / 37 B | 9.6× / 3.8× |
| Unreliable signal `combat.aim`, payload `{ yaw: f32, pitch: f32, seq: u32 }`, table payload (never batched) | 144 B | 47 B | 3.1× |
| The same signal with today's `wire: "binary"` payload | 101 B | 47 B | 2.1× |

"Proposed" counts a buffer item as one value plus its bytes: a kind byte, a u16 index, a
u16 request sequence where there is one, and the payload without the codec's 4-byte
fingerprint. A frame adds its array, its version, and a contract fingerprint (24 bytes).
The model errs high on purpose (Roblox does not document its remote encoding), so the
ratios are what to verify, not the bytes. Batching is where most of the gain is: alone in
its frame, an item still pays for the frame.

For an unreliable signal the frame is most of the cost: 75 bytes of fixed overhead
(`SIGNAL_FRAME_OVERHEAD_BYTES`) against the 900-byte limit, plus the signal id's bytes,
whatever the payload's encoding.

## What already exists

- **The codec** (`packages/aruna/roblox/binary.ts`): schema-driven `encodeBinary` /
  `decodeBinary`, byte-identical across runtimes, with width hints (`u8`..`i32`, `f32`) and
  the Roblox value types. Every frame it writes starts with a u32 schema fingerprint.
- **Binary signals**: `wire: "binary"` on `defineSignal` sends the payload as a buffer
  (`aruna::512` refuses a schema the codec cannot encode), and the compiler records
  `maxEncodedBytes`.
- **The contract hash** (`compute_contract_hash` in `crates/aruna_compiler/src/codegen.rs`):
  FNV-1a over every action's and signal's wire-relevant layout, emitted into both generated
  modules. A server can advertise it on the remote and a client can compare
  (`expectedContractHash`); today both are opt-in, and the generated entries wire neither.
- **The frame grammar**: `{ 1, item, item, ... }`, at most 64 items, with every item
  carrying its kind in `t`.

## Proposal

### Opt in per action and per signal

`wire: "binary"` on `defineAction`, as on `defineSignal`. Per definition rather than per
project, so each one is a measured choice and a schema the codec cannot encode stays on
tables. The compiler applies the signal rule to actions: an input, output, or declared
error's data that the codec cannot encode (`schema.instance()`, a missing schema, a
`.default()` the codec does not support yet) is an error.

### Numeric indices

The compiler numbers the binary actions and signals in manifest order (sorted by id), each
kind from 0, and emits the table into both generated modules.

**Stable indices are not needed for correctness.** A client always runs the build of the
server it joined ([stability.md](../stability.md#before-the-first-public-release-now)), so
indices only have to agree inside one server, and a deterministic numbering per build
does that. Adding an action renumbers the ones after it, which costs nothing on the wire;
it only means logs and analytics should record the action id, not the index.

**But a mismatch is worse than with strings.** A string id that names no action is
dropped; an index from another build may name a different action whose input happens to
decode. So a binary item is read only under a verified contract (next section).

Considered and set aside:

- *Hash-derived indices* (a truncated hash of the id): stable across builds, but they need
  collision handling at compile time, cost more bits, and still need the contract check.
  They buy debuggability, not safety.
- *A committed index lock file*: stable and compact, but one more artifact to keep in sync
  in review, for the same non-safety benefit.

### Frames: protocol version 2

Version 2 keeps the version 1 grammar and adds two things:

```lua
{ 2, contractFingerprint, item, item, ... }
```

- `[2]` is a u32 fingerprint of the contract hash. The receiver reads buffer items only
  when it matches its own; on a mismatch it drops the frame whole and reports it
  (`unknown-protocol-version`'s sibling, say `contract-mismatch`). That makes every frame
  self-validating with no session state, and it is why the codec's per-payload
  fingerprint can go: one u32 per frame (up to 64 items) instead of one per payload.
- An item may be a **buffer** instead of a table. Its first byte is the item kind, the same
  numbering as `t`. Table items stay exactly as in version 1, so one frame can mix binary
  actions with table ones, and batching, ordering, and the one reliable channel are
  unchanged.

| Kind | Buffer layout after the kind byte |
| --- | --- |
| call | u16 action index, u16 request sequence, payload (the input, encoded without the fingerprint header) |
| response | u16 request sequence, u8 status, then: the output (status `ok`); or a u16 error index, and for a declared error its data (status `error`); or a u32 `retryAfterMs` (rate limited); or a u32 `errorId` (internal) |
| signal | u16 signal index, payload |

A fire-and-forget call is an ordinary call whose sequence is never answered. The request
sequence replaces the string request id: a client wraps a u16 per remote, and since a
player has at most `maxInFlight` (32) calls pending, a wrapped sequence cannot collide
with a live one. Error indices cover the framework's own errors and the action's declared
`errors`; an undeclared `actionError` name falls back to a table response.

The server keeps reading version 1 frames, so a table-only client keeps working, and the
budget, the in-flight cap, rate limits, validation, and `onAbuse` apply per item exactly
as now. A buffer item that fails to decode is charged and reported as
`malformed-envelope`.

### Making the handshake the default

Binary items need both sides to know they share a contract, so a project with any binary
definition gets the handshake wired by codegen: the generated server entry passes
`contractHash` to the transport, and the generated client entry passes
`expectedContractHash` to the invoker. A client whose hash does not match sends version 1
frames only (and reports the mismatch through `onVersionMismatch`, as today).

### What stays a table

- A definition without `wire: "binary"`.
- A response whose error has no index (an undeclared `actionError`), and an
  `exposeInternalErrors` response, which carries arbitrary names and messages.
- Everything a client sends before the contract is verified.

## Safety

- The decoder runs on client bytes before validation, so it has to be bounded the way the
  wire-safety walk is: a length or count prefix larger than the bytes left, or than the
  schema's `maxLength` / `maxItems` / `maxEntries`, fails at once, and decoding stops at
  the same 2048-value budget. With the bounds the compiler now records (`aruna::514` asks
  for them), an oversized buffer is refused before anything is allocated for it.
- Decoding yields only schema-shaped plain data, so the wire-safety walk is not needed for
  a binary input, but finite-number and constraint checks are: `validate` still runs.
- A floating-point payload can decode to NaN or ±inf from raw bits; `validate`'s finite
  check covers it, as it does for a table input today.

## Measurements

Preliminary, under Lune on a desktop machine (interpreted Luau, 100,000 iterations each).
Lune is not Roblox, so these say which way the trade goes, not how far:

| Payload | Binary bytes (with today's 4-byte header) | `encodeBinary` | `decodeBinary` | Today's receive check (`isWireSafe` + `validate`) |
| --- | ---: | ---: | ---: | ---: |
| small call | 15 | 7.3 µs | 7.1 µs | 4.7 µs |
| medium call | 71 | 21.5 µs | 21.5 µs | 16.9 µs |
| aim update | 16 | 9.1 µs | 9.2 µs | 5.8 µs |

On the server a binary call costs a Luau decode plus `validate`, against today's walk plus
`validate`, so Luau time per call goes **up**, by roughly 1.5–2.5× here. What it saves is
bandwidth, and the engine's own deserialization of a table (one buffer value instead of
one value per field), which Lune cannot show. Whether that nets out depends on numbers
only a live server has:

1. **Bytes per item.** A test place that fires each shape at a fixed rate (say 1,000 per
   second for 30 seconds) as a table and as a buffer, reading `Stats.DataSendKbps` /
   `DataReceiveKbps` on both ends. That replaces the 8-bytes-per-value guess with real
   numbers, for this RFC and for the compiler's size checks.
2. **Server CPU.** `os.clock()` around the receive path for each shape on a live server,
   with and without `--!native`; native code generation changes the decode-to-walk ratio.
3. **The unreliable limit.** Sweep buffer sizes across 850–950 bytes on an
   `UnreliableRemoteEvent` and record where delivery stops, to confirm that the 900 bytes
   apply to the whole serialized frame, as `aruna::511` assumes.

Build it if (1) shows the ratios above and (2) shows the CPU cost affordable at the call
rates games actually run. Unreliable signals are the likely first target either way: they
are where a fixed frame cost meets a hard size limit.

## Codec changes this would want

Separate decisions, listed because they compound with this one:

- **Variable-length prefixes.** Strings, arrays, records, enum indices, and union indices
  all use a u32 prefix today; a LEB128 varint saves 3 bytes on each in the common case.
  This changes the existing binary-signal format.
- **A headerless encode.** `encodeBinary` always writes the fingerprint; items under a
  verified contract need a variant without it.
- **`.default()` schemas**, which the codec does not encode yet.

## Not in scope

Compression, delta encoding against a previous value, and a binary store format are
separate questions. The store envelope has its own versioning
([persisted format v1](../../packages/aruna/docs/stores.md#persisted-format-v1)).

## Open questions

- A project-wide `wire: "binary"` default with a per-definition opt-out, once the
  measurements are in?
- Is a u16 index enough? 65,536 actions per project is generous; a varint would make the
  common case one byte.
- Should the contract fingerprint ride in every reliable frame, or once per session
  through a hello item? Per frame keeps the receiver stateless; per session saves 8 bytes
  a frame.
