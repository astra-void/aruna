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
| `invoke(player, actionId, input)` | Dispatches as that player, through validation, rate limiting, and middleware. Resolves with the action's output; rejects the way the wire does. |
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

Stores need no special harness support: pair the store definition with the in-memory
backend the runtime already ships.

```ts
import { createPlayerStore, createMemoryStoreBackend } from "aruna/server";

const profiles = createPlayerStore(profile, { createBackend: createMemoryStoreBackend() });
const harness = createTestServerApp({ actions, playerStore: profiles });
harness.join(player); // loads the document, so ctx.store is populated
```

## The framework

`aruna/testing` exports `describe`, `it`, `itSkip`, `beforeEach`, `afterEach`, and
`expect`. Bodies may be synchronous, may return a promise, or may yield.

`beforeEach` hooks run outermost-suite first; `afterEach` runs innermost first and runs
even when the test failed, so a harness a test created is still disposed.

Matchers: `toBe`, `toEqual` (structural), `toBeDefined`, `toBeUndefined`, `toBeTruthy`,
`toBeFalsy`, `toContain`, `toHaveLength`, `toThrow`, and `expect(promise).rejects.toThrow`.
Every matcher negates through `.not`. Rejection messages are read through the same helper
in both runtimes, so `rejects.toThrow("rate limited")` works whether the rejection is an
`Error` or the native runtime's plain table.

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

**Lune is required.** It is not an npm package; install it with
`rokit add lune-org/lune` (or see the Lune docs). Without it `aruna test` stops and says
so rather than pretending the suite passed — so a CI job that runs it has to install Lune
too. If you would rather have CI skip the specs than fail on a machine without the Roblox
toolchain, probe for Lune in your own script and call `aruna test` only when it is there
(`apps/rbxts-harness/scripts/run-specs.ts` in this repo does exactly that).

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
