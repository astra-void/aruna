# Testing

`aruna test` compiles your project **with its specs** and runs them under
[Lune](https://lune-org.github.io). Specs are TypeScript, live next to the code they
exercise, and drive real actions through the real dispatch path — validation, rate
limiting, middleware, sessions, signals — without a RemoteEvent, a Players service, or a
DataStore.

```bash
aruna test
```

```text
running specs under Lune

  ✓ shop.purchaseItem > prices the order and reports success
  ✓ shop.purchaseItem > refuses a non-positive quantity with a reason
  ✓ shop.purchaseItem > rejects input the schema does not accept
  ✓ shop.purchaseItem > enforces the action's rate limit

4 passed, 0 failed
```

## Why not vitest

Your actions are roblox-ts source. They compile to Luau and run against the vendored
native runtime — not against Node. A Node test runner would exercise a different runtime
than the one your game ships, which is exactly the class of bug a test is supposed to
catch. So `aruna test` compiles the project the way `aruna build` does, and runs the
compiled Luau under Lune.

That is also why the framework (`describe` / `it` / `expect`) ships in `aruna/testing`
rather than being supplied by a host runner: under Lune there is no host runner.

## Writing a spec

`aruna add domain <name>` scaffolds one for you — `actions.test.ts` next to the starter
action, already passing — so a new domain begins with a test to extend.

A spec is any file matching `**/*.test.ts(x)` or `**/*.spec.ts(x)`. Put it next to the
code it covers:

```text
src/domains/shop/
  actions.ts
  actions.test.ts     <- classified as a test, wherever it sits
  schema.ts
```

```ts
import { createTestPlayer, createTestServerApp, describe, expect, it } from "aruna/testing";
import { purchaseItem } from "./actions";

const actions = { "shop.purchaseItem": purchaseItem };

describe("shop.purchaseItem", () => {
  it("prices the order", async () => {
    const harness = createTestServerApp({ actions });
    const player = createTestPlayer({ name: "Ada" });

    const output = await harness.invoke(player, "shop.purchaseItem", {
      itemId: "sword",
      quantity: 2,
      currency: "coins",
    });

    expect(output.total).toBe(100);
    harness.dispose();
  });
});
```

A spec may import **anything** — client, server, and shared modules alike. Nothing may
import a spec: game code that did would not compile in the place, because the game build
never compiles specs. That import is `aruna::305 test-module-imported`.

## The harness

`createTestServerApp(options)` takes everything `createServerApp` does except
`transport`, `createPublisher`, and `players` — the harness owns those. It returns:

| Member | What it does |
| --- | --- |
| `invoke(player, actionId, input)` | Dispatches as that player, through validation, rate limiting, and middleware. Resolves with the action's output; rejects the way the wire does, except that a thrown error keeps its own message: the harness defaults `exposeInternalErrors` to `true` so a spec sees the real failure. Pass `exposeInternalErrors: false` to assert what a client would get. |
| `join(player)` / `leave(player)` | Drives the lifecycle: sessions are created and dropped, `onPlayerAdded`/`onPlayerRemoving` fire, an owned player store loads and releases. |
| `players()` | Who is currently "in the server". |
| `published()` | Every signal emit so far — `{ signalId, payload, player? }`, no player for a broadcast. |
| `takePublished()` | The emits so far, clearing the log. |
| `advance(ms)` | Steps the harness clock, which is how a spec crosses a rate-limit window. |
| `client(player)` | A client app whose transport dispatches into this server and whose subscriber receives that player's signals. |
| `app` | The real `ServerApp` underneath, for anything the harness does not wrap. |
| `dispose()` | Tears down the app and every client it handed out. |

`createTestPlayer({ name?, userId? })` returns a player double. It carries `Name` and
`UserId` — what the runtime actually reads, `UserId` being what the default rate-limit key
buckets on — and is typed as `Player` so it drops into your `Player`-typed actions without
a cast. Any other member of `Player` is absent by design: a spec that needs a real
character needs a real game.

The publisher the harness installs is the shipping one, over a recording remote. A payload
that would fail schema validation in production fails in the spec too:

```ts
const harness = createTestServerApp({ actions, signals });
await harness.invoke(player, "shop.buy", { item: "shield" });

expect(harness.published()).toEqual([
  { signalId: "shop.purchased", payload: { item: "shield" }, player },
]);
```

A client round trip, including the signal coming back:

```ts
const client = harness.client(player);
client.subscriber?.on("shop.purchased", (payload) => received.push(payload));
await client.invoke("shop.buy", { item: "rope" });
```

`client()` installs the module-global action invoker, so the generated
`$aruna/actions/client` stubs work inside a spec — which also means the most recently
created client is the one that global serves.

## Time

The harness freezes the clock the rate limiter reads, so a window elapses when the spec
says it does rather than in real time:

```ts
const harness = createTestServerApp({ actions });     // rateLimit: max 1 per 60s
await harness.invoke(player, "ping", undefined);      // ok
await expect(harness.invoke(player, "ping", undefined)).rejects.toThrow("rate limited");

harness.advance(60_000);
await harness.invoke(player, "ping", undefined);      // ok again — no waiting
```

Only the rate limiter reads this clock; `os.clock()`, `DateTime`, and store heartbeats are
untouched. Passing your own `nowMs` to `createTestServerApp` keeps that clock and makes
`advance()` an error, since the harness is then not the one holding it.

## Persistence in a spec

Stores need no special harness support: pair the store definition with an in-memory
backend. `createTestStoreBackend()` from `aruna/testing` is the memory backend plus what a
persistence spec needs:

```ts
import { createPlayerStore } from "aruna/server";
import { createTestStoreBackend, createTestServerApp } from "aruna/testing";

const backend = createTestStoreBackend();
backend.seed("player_7", { lvl: 12 }, { version: 1 });          // as an older build wrote it
backend.seed("player_8", { level: 3 }, { lock: { owner: "server-a" } }); // a live foreign lock
backend.seedRaw("player_9", "corrupt");                          // anything at all

const profiles = createPlayerStore(profile, { backend, owner: "server-b" });
const harness = createTestServerApp({ actions, playerStores: { profile: profiles } });
harness.join(player);

backend.failNext("update", 1, "403: API Services rejected"); // the next save fails (permanent)
backend.failAll("update");   // an outage, until backend.heal()
backend.hold("update");      // a request in flight, until backend.resume("update")
backend.record("player_7");  // what the key holds now: { kind: "envelope", version, value, lock }
backend.writes();            // writes that changed a key — 0 proves nothing was overwritten
```

A store retries a transient failure and waits out a held lock on its `scheduler`; pass
`retry: { attempts: 1 }` and `session: { acquireAttempts: 1 }` in a spec, or a scheduler
you step, so nothing waits on real time. `apps/roblox-runtime-test/src/test/persistence.spec.ts`
covers migrations, missing fields, invalid records, failed migrations, lock contention and
takeover, a leave mid-load, a failed save, shutdown, partial failure across stores, and a
throwing leave hook.

## Resources

`createTestServerApp({ resources })` runs the real resource host, and every
`harness.client(player)` has a real resource client as `client.resources`, wired through
the same admission the wire binding runs:

```ts
const harness = createTestServerApp({ actions, resources });
const player = createTestPlayer({ userId: 1 });
harness.join(player);
const subscription = harness.client(player).resources!.subscribe("quests.progress");
expect(subscription.get()).toEqual({ quest: "intro", step: 0 });

harness.app.resources!.invalidate("quests.progress", player);
```

Unbatched (the default), a snapshot arrives inside the call that produced it; with
`batching: true` it arrives on `step()`, in order with responses and signals.

## Multiplayer networks

`createTestNetwork` runs one real server app and a real client app per player, joined by
simulated links on a virtual clock. Nothing is mocked between them: the wire frames, the
action binding (admission, budget, validation, rate limits, middleware, idempotency, error
masking), signals, and resources are all the shipping code.

```ts
import { createTestNetwork } from "aruna/testing";

const network = createTestNetwork({ actions, resources, signals, players: [101, 202], latencyMs: 40 });
const alice = network.client(101);
const bob = network.client(202);

alice.resources.subscribe("economy.wallet", render);
const earned = alice.invoke("economy.earn", { amount: 3 });
network.advance(250); // frames, deliveries, and timeouts up to t + 250 ms
network.flush();      // step until nothing is in flight
expect(await earned).toBe(3);
```

| | |
| --- | --- |
| `network.client(id)` | The player's client: `invoke`, `resources`, `app` (with `app.subscriber`), `connected()`. |
| `network.join(id)` / `leave(id)` | A player joins with a fresh client / leaves cleanly. |
| `network.disconnect(id)` | The connection drops: frames in flight both ways are lost, the client's pending calls time out on the virtual clock, the server sees the player leave. |
| `network.reconnect(id)` | The same player joins again with a new client (Roblox has no in-session reconnect). |
| `network.advance(ms)` / `flush()` / `now()` | The virtual clock. One frame is 16 ms (`TEST_NETWORK_FRAME_MS`); each frame delivers what is due, flushes every side's outbox (Heartbeat), and fires due timeouts. |
| `network.link(id)` | Per-player faults (below) and `stats()` per direction. |
| `network.published()` | Every signal the server put on a link. |

Options: `latencyMs` (a number, or `{ up, down }`), `requestTimeoutMs` (virtual ms,
default 10000), `seed` (for loss rates), `clientMiddleware`, `retry` (a
`ClientRetryPolicy` every client uses; its backoff and `retryAfterMs` waits run on the
virtual clock), plus everything `createServerApp` takes except the transport, the
publisher, the players source, and the clock.

### Faults, and which guarantees they model

The links keep Roblox's guarantees apart, so a spec does not accidentally test against a
transport that cannot exist:

| Direction | Roblox guarantees | Faults |
| --- | --- | --- |
| `link.up` (client → server, RemoteEvent) | Ordered while connected. But a client can send anything. | `dropNext`, `duplicateNext`, `reorderNext`, `setLoss`, `setLatency`, and `inject(frame)` (a raw frame, as a hostile client would send). These model a broken or hostile client: what the server must survive. |
| `link.reliable` (server → client, RemoteEvent) | Ordered, never lost while connected. | `setLatency` and `hold()` / `release()` keep the order. `duplicateNext`, `reorderNext`, `dropNext` break the guarantee on purpose, to test a client's defenses; Roblox's transport does not do this. |
| `link.unreliable` (server → client, UnreliableRemoteEvent) | None: may drop or reorder. | `setLoss`, `dropNext`, `reorderNext`, `duplicateNext`, `setLatency`. Normal behavior here. |

A disconnect is the only way the reliable direction loses frames in a real game.

### What it is good for

`apps/roblox-runtime-test/src/test/network.spec.ts` is the reference: per-player isolation
of resource state, a forged subscription that names another player, per-player rate
limits, invalid payloads and malformed frames, duplicated calls with and without an
idempotency key, reordered calls, response latency past the request timeout, a lost
request, a disconnect in the middle of a call, a rejoin restoring a snapshot,
subscription cleanup on leave, reordered and duplicated snapshots, a held snapshot, lossy
unreliable signals next to reliable state, and seed determinism.

### Ordering guarantees a spec can rely on

- One player's calls are dispatched in the order the server receives them. Two calls in
  one frame arrive in the order they were made.
- A synchronous action's signals, resource snapshots, and response leave in the order
  they were produced; an async action's response leaves when it settles, so two async
  calls can be answered in either order.
- Nothing is ordered across players, or between the unreliable remote and anything else.

Not simulated: retry backoff in `withRetry` (it sleeps on real time), and the
DataStore — pass a store backend of your own (`createMemoryStoreBackend`) for that.

## The framework

`aruna/testing` exports `describe`, `it`, `itSkip`, `beforeEach`, `afterEach`, and
`expect`. Bodies may be synchronous, may return a promise, or may yield.

`beforeEach` hooks run outermost-suite first; `afterEach` runs innermost first and runs
even when the test failed, so a harness a test created is still disposed.

Matchers: `toBe`, `toEqual` (structural), `toBeDefined`, `toBeUndefined`, `toBeTruthy`,
`toBeFalsy`, `toContain`, `toHaveLength`, `toThrow`, and `expect(promise).rejects.toThrow`.
Every matcher negates through `.not`. `rejects.toThrow("rate limited")` reads the message of
whatever the promise rejected with — a string, or the runtime's `{ name, message }` table.
`toBeTruthy` / `toBeFalsy` follow Luau truthiness: only `undefined` and `false` are falsy, so
`""` and `0` are truthy. Test names join suites with `" > "`.

## What the game build does with specs

Nothing — that is the point.

- Specs are classified `test` by the compiler wherever they live, so a spec inside
  `server/` is a test, not server code.
- `aruna build` never stages them, so they cannot reach the place file. The vendored test
  framework is skipped for the same reason.
- Actions, signals, stores, and runtimes declared *inside* a spec are not discovered: a
  `defineAction` there is a fixture, not something your game ships. It never lands in the
  manifest, the generated registry, or the contract.
- `aruna test` stages them into their own partition, compiles, and runs — leaving the
  `out/` your game build owns untouched.

## Running

```bash
aruna test                    # every spec
aruna test --filter shop      # only specs whose path contains "shop"
```

`aruna test` runs the full build first, so the generated stubs and the vendored runtime
are current before anything compiles.

**Lune is required.** It is not an npm package. A `create-aruna-app` project pins it in
`rokit.toml`, so `rokit install` is enough; elsewhere, `rokit add lune-org/lune` (or see the
Lune docs). Without it `aruna test` stops and says
so rather than pretending the suite passed — so a CI job that runs it has to install Lune
too. If you would rather have CI skip the specs than fail on a machine without the Roblox
toolchain, probe for Lune in your own script and call `aruna test` only when it is there
(`apps/rbxts-harness/scripts/run-specs.ts` in this repo does exactly that).

**Dependencies that ship Luau load as they do in a game.** A directory with an
`init.luau` is a module (rbxtsc emits one for every `index.ts`), and a string require
(`require("./x")`, `"../x"`, `"@self/x"`) resolves against the same tree. The fake game
covers what a UI library touches when it loads (`ReflectionService`, `Enum` items, the
profiler markers), so a spec can drive Vide roots, sources, and effects; see
[ui.md](ui.md#testing).

## Conventions

The spec globs are conventions like any other, and can be extended:

```ts
export default defineConfig({
  conventions: {
    test: ["src/**/__tests__/**"],
  },
});
```

Test conventions are applied **before** the client/server/shared tiers rather than
alongside them — a spec sitting in `server/` would otherwise be an ambiguous match
(`aruna::203`) instead of the test it plainly is.
