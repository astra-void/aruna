# Observability

Two views of an app's traffic, kept apart on purpose:

- **Static** — `aruna inspect network` (and `inspect actions|signals|resources`) reads the
  contract: what may cross the wire, how often, and how large at most. Nothing there is a
  measurement.
- **Runtime** — `createNetworkMetrics()` counts what did cross it, in the running server
  (or client), opt-in and bounded.

## `aruna inspect network`

```
aruna inspect network

  static policy from the contract — not measured traffic (use createNetworkMetrics() at runtime)

  request budget per player: 60 burst, 30/s, 32 in flight (runtime default; createServerApp({ requestBudget }) overrides)

  combat.cast  request-response
    rate limit: 8 per 1000ms by player (tokenBucket, declared)
    input: bounded
    declared errors: CastRefused
  combat.spellCast  signal, reliable, table
    estimated max payload: unbounded
  quests.progress  resource, player scope, snapshots on the reliable channel
```

Per action: delivery (request-response or fire-and-forget), idempotency, the rate limit
and whether it is the action's own or `actions.defaultRateLimit`, whether its input is
bounded (`aruna::514`), and its declared errors. Per signal: the remote, the encoding, and
the largest payload its schema allows — exact for `wire: "binary"`, a floor for the table
encoding, which adds a tag and a key per value. `--json` prints the same as data, with
`"kind": "static"`.

## `createNetworkMetrics()`

```ts
import { createNetworkMetrics, formatNetworkReport } from "aruna/server";

const metrics = createNetworkMetrics(); // { samples: 256, maxKeys: 256 }
const app = createServerApp<Player>({ actions, resources, transport: robloxRemoteEvent(), metrics });

// later — a dev command, a debug panel, a periodic log:
print(formatNetworkReport(metrics.report()));
metrics.reset();
```

```
Aruna Network Diagnostics
  window: 62.0s; sizes are estimates, not measured traffic

Action: combat.cast
  Requests:       1250 (1250 from clients, 20.2/s)
  Rejected:       14
    ActionRateLimitError: 11
    CastRefused: 3
  Server time: P50 0.4ms, P95 3.2ms, max 9.1ms over 256
  Checks before run: P50 0.1ms, P95 0.2ms, max 0.6ms over 256
  Client round trip: no samples

Resource: quests.progress
  Subscribers:    6
  Snapshots:      18 (18 sent)
  Invalidations:  7
  Resyncs:        1
  Load errors:    0
  Est. bytes:     4.1 KB
```

(Illustrative values.) What each number is:

| Metric | Source | Meaning |
| --- | --- | --- |
| Requests, rejected, rejections by error name | every settled dispatch | Calls from clients and in-process. Names only. |
| Server time | dispatch start → settle | Validation, middleware, `run`, output checks. **Server time, not a round trip.** |
| Checks before run | dispatch start → just before `run` | Wire safety, defaults, schema validation, rate limit: the serialization-side cost. |
| Client round trip | `metrics.clientMiddleware()` on a client app | Invoke → settle as the client saw it: frame queueing, transport, and server time together. |
| Signal items, resource snapshots/invalidations/resyncs/load errors/subscribers | the publisher's frames, the resource host | Counts. Subscribers is the live count. |
| Refused before dispatch | `onAbuse` | Envelopes dropped before any action ran (malformed, over budget, unknown action or resource). |
| Est. bytes, frames, items | frames this runtime built | Aruna's [size accounting](../../../docs/wire-protocol.md#size-accounting): 8 bytes a value plus string bytes. **An estimate**: Roblox does not document its encoding. A broadcast counts once. |

Percentiles are nearest-rank over the last `samples` values; the text report leaves P95
out below 20 samples rather than print a number that means nothing.

On a client:

```ts
const metrics = createNetworkMetrics();
createClientApp({ resources: true, middleware: [metrics.clientMiddleware()] });
```

### What it costs

- **Off by default.** Without `metrics` (and without `onReject`), dispatch reads no clock
  for observability and building a frame costs one nil check.
- **Bounded.** Each latency series is a ring of `samples` values; each map stops at
  `maxKeys` ids, the rest counted under `"(other)"`. Ids come from your registries, so in
  practice nothing reaches the cap.
- **No payloads.** It keeps ids, error names, counts, durations, and sizes — never an
  input, output, message, or value.
- **Measured overhead** (Lune, Apple M-series, 3000 in-process dispatches of a validated
  action, `apps/roblox-runtime-test/src/test/metrics.spec.ts`): 117 ms off, 152 ms on —
  about 12 µs per dispatch. The spec fails if metrics ever cost more than 3x.

One collector observes the frames of the Luau VM it is attached in (a server, or a
client); attaching a second replaces the first.

## `onReject`

```ts
createServerApp({
  actions,
  onReject: ({ actionId, player, kind, errorName, fromClient, durationMs }) => {
    if (kind === "validation" && fromClient) analytics.count("bad-input", actionId);
  },
});
```

Called for every dispatch that did not succeed, after it settled: `kind` is
`"validation"`, `"rate-limit"`, `"serialization"`, `"not-found"`, `"declared"` (an error
the action declares), `"public"` (another `actionError`), or `"internal"`. It carries
names, never the input or the error's message, and changes nothing about what the client
is sent. `onError` still receives the thrown value of a failing `run`, and envelopes
dropped before dispatch go to `onAbuse`.
