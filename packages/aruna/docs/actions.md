# Actions

An **action** is a client → server request/response RPC. You define it once with
`defineAction`; the compiler generates a server registry and a typed client call
function.

## `defineAction`

`defineAction` is an identity helper — it returns the definition unchanged but pins the
literal types so the compiler and generated stubs can read them.

Import `defineAction` from **`aruna/roblox`** so `ctx.player` is typed as `Player` out of
the box (see [`ctx.player` typing](#ctxplayer-typing) — `aruna/server` exposes the same
helper but defaults `TPlayer` to `unknown`):

```ts
import { defineAction } from "aruna/roblox";
import { schema } from "aruna/schema";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",          // unique, dotted by convention
  rateLimit: { key: "player", windowMs: 1000, max: 5 },  // optional, per-action
  fireAndForget: false,             // optional; see below
  idempotent: false,                // optional; see "Retries and idempotency"
  input: schema.object({ itemId: schema.string(), quantity: schema.number() }),
  output: schema.object({ ok: schema.boolean(), total: schema.number() }),
  run(ctx, input) {
    // ctx: { player?: Player }, input: inferred from `input` schema
    return { ok: input.quantity > 0, total: input.quantity * 50 };
  },
});
```

Definition shape:

```ts
type ActionDefinition<TInput, TOutput, TPlayer> = {
  readonly id: string;
  readonly rateLimit?: { key: "player"; windowMs: number; max: number };
  readonly fireAndForget?: boolean;
  readonly idempotent?: boolean;
  readonly input?: Schema;
  readonly output?: Schema;
  run(
    ctx: { player?: TPlayer; publisher?: SignalPublisher },
    input: InferInput,
  ): InferOutput | Promise<InferOutput>;
};
```

`input` and `output` are both optional. Omit `input` for a no-argument action; omit
`output` for an action that returns nothing meaningful. `run` may be async.

### Publishing signals from an action

When `createServerApp` owns a publisher (`{ signals, createPublisher }`), it is injected as
`ctx.publisher`, so an action can push server → client signals from inside `run` without a
plumbing module. For a non-optional, registry-typed `ctx.publisher`, bind your `defineAction`
with `createActionDefiner<Signals, Player>()`. See
[Publishing from inside an action](./signals.md#publishing-from-inside-an-action).

### `ctx.player` typing

With `defineAction` from `aruna/server`, `TPlayer` defaults to `unknown`, so `ctx.player`
is `unknown`. Import `defineAction` from **`aruna/roblox`** instead and `TPlayer` defaults
to `Player`, giving you `ctx.player: Player` for free:

```ts
import { defineAction } from "aruna/roblox";
// ctx.player is Player here
```

`ctx.player` is **always present**: every wire dispatch carries the calling player, and
in-process dispatches (`app.dispatch`, tests) supply one in the context they pass.

## Server registration

The generated `$aruna/actions/server` module exports `actions` (the registry of every
discovered action) and `defaultRateLimit` (if your config sets one). Pass them — together
with a `transport` — to `createServerApp`. The app **owns** the binding, so every dispatch
option (including `defaultRateLimit`) reaches the wire.

```ts
import { createServerApp } from "aruna/server";
import { robloxRemoteEvent } from "aruna/roblox";
import { actions, defaultRateLimit } from "$aruna/actions/server";

const serverApp = createServerApp<Player>({
  actions,
  defaultRateLimit,
  transport: robloxRemoteEvent(),
});
// serverApp.dispose() tears down the RemoteEvent handler (idempotent)
```

`createServerApp` options:

```ts
{
  actions: ActionMap;
  transport?: ServerTransport;                      // owns the remote binding (recommended)
  defaultRateLimit?: { key: "player" | "global"; windowMs: number; max: number };
  signals?: SignalMap;                              // + createPublisher: app-owned publisher
  middleware?: ActionMiddleware[];
  onError?: (err, info) => void;                    // see below
  exposeInternalErrors?: boolean;                   // default false; see "Errors the client sees"
  onPlayerRemoving?: (player) => void;              // per-player cleanup; app owns the connection
}
```

`robloxRemoteEvent()` (from `aruna/roblox`) is the default (and only) transport: it
ensures the flat `ReplicatedStorage/ArunaActionRemoteEvent` exists and routes incoming
requests through the registry with validation + rate limiting. `bindActions(registry)`
remains exported if you bind outside an app, but prefer the app-owned transport so
`defaultRateLimit` and the publisher reach the wire.

## Client calls

The generated `$aruna/actions/client` module exports one async function per action,
named after the export, with the action id and serialization baked in:

```ts
import { createClientApp } from "aruna/client";
import { purchaseItem } from "$aruna/actions/client";

createClientApp(); // defaults to the Roblox action transport

const result = await purchaseItem({ itemId: "sword", quantity: 1 });
// result: { ok: boolean; total: number }
```

`createClientApp(options?)` installs its transport process-wide so the generated stubs
can find it; call its `.dispose()` to clear it. The default transport is
`createActionInvoker()` (from `aruna/roblox`), the RemoteEvent invoker paired with the
server's `robloxRemoteEvent()`. Pass `createClientApp({ transport })` to customize it —
e.g. `createActionInvoker({ createRequestId, requestTimeoutMs })`.

Every request has a **10-second timeout by default** (a dropped response — disconnect,
server crash mid-dispatch — rejects instead of hanging forever). Tune it with
`createClientApp({ requestTimeoutMs })`; pass `0` to wait forever.

You can also call the low-level `invokeAction(actionId, input, options?)` from
`aruna/client` directly, but prefer the generated typed stubs.

## Rate limiting

Limits are keyed per player (`key: "player"`, the default) or server-wide
(`key: "global"` — one shared bucket for every caller, useful for actions that hit an
expensive shared resource). Resolution order: the action's own `rateLimit`, then the
app/config `defaultRateLimit`, then unlimited.

```ts
defineAction({ id: "shop.buy", rateLimit: { key: "player", windowMs: 1000, max: 5 } /* ... */ });
defineAction({ id: "world.regen", rateLimit: { key: "global", windowMs: 60_000, max: 1 } /* ... */ });
```

```ts
// aruna.config.ts — applies to every action without its own rateLimit
defineConfig({ actions: { defaultRateLimit: { key: "player", windowMs: 1000, max: 20 } } });
```

The default key resolver uses `ctx.player.UserId`; players that are missing collapse to a
shared `"anonymous"` bucket. Override with `rateLimitKey` if you need finer buckets. When
a limit is exceeded the dispatcher throws `ActionRateLimitError` (`retryAfterMs`,
`resetAtMs`, `max`, `windowMs`).

**Failures are typed across the wire.** A rejected invoke carries a structured error:
`err.message` plus `err.name` (`"ActionRateLimitError"`, `"ActionValidationError"`,
`"ActionSerializationError"`, `"ActionNotFoundError"`, `"ActionTimeoutError"`,
`"ActionInternalError"`, or a name your action chose). Rate-limit rejections also carry
`err.retryAfterMs` / `err.resetAtMs`, so clients can back off precisely instead of
string-matching messages.

### The request budget in front of dispatch

A per-action `rateLimit` counts only calls that passed validation — invalid input does
not use up a player's quota. That leaves the checking itself unpriced, so the server app
puts per-player limits in front of every action, before the payload is read:

| Limit | Default | Over it |
| --- | --- | --- |
| Envelope budget: a token bucket charged for **every** envelope, valid or not | 60 burst, 30 per second | dropped, no response |
| Request id a string of at most 64 characters, action id at most 128 | — | dropped, no response |
| Dispatches running at once | 32 | `ActionRateLimitError` (`retryAfterMs: 100`) |
| Values in the input, however shallow (the wire-safety walk) | 2048 | `ActionSerializationError` |

Each dispatch then runs in the order that keeps a hostile payload cheap: wire safety,
then `.default(...)` filling, then validation, then the per-action rate limit. An action's
own output and a signal payload are server-authored, so they are not held to the
2048-value limit.

```ts
createServerApp({
  actions,
  transport: robloxRemoteEvent(),
  requestBudget: { burst: 60, perSecond: 30, maxInFlight: 32 },
  onAbuse: (player, { reason }) => {
    // "budget-exhausted" | "malformed-envelope" | "too-many-in-flight"
    warn(`${player.Name}: ${reason}`);
  },
});
```

A player's budget and in-flight count are dropped when they leave. The budget is charged
by the transport, so `app.dispatch` in-process (and the test harness's `invoke`) is not;
the in-flight cap applies to every dispatch.

## Errors the client sees

An error reaches the client with its own `name` and `message` only when it is public.
Public means one of the framework's own failures about the request listed above, or an
error your action throws through `actionError`. An action's *output* failing its schema
or not being wire-safe is a server bug, not a client error: middleware and `onError` see
the real `ActionValidationError` / `ActionSerializationError`, and the client gets
`ActionInternalError` with an `errorId` (unless `exposeInternalErrors` is set).

```ts
import { actionError, defineAction } from "aruna/server";

export const buy = defineAction({
  id: "shop.buy",
  run(ctx, input) {
    if (stock(input.itemId) === 0) {
      throw actionError("OutOfStock", "Item is sold out"); // err.name === "OutOfStock"
    }
    // ...
  },
});
```

Anything else is masked: a bug, a failed lookup, `throw new Error(...)`, even a plain
`{ name, message }` table. The client gets
`{ name: "ActionInternalError", message: "internal error", errorId }`. A Luau runtime
error names the server script and line it came from
(`ServerScriptService.domains.shop.actions:42: attempt to index nil`), and that is not
the client's to see. `onError` gets the original error and the same `errorId`, so a
player's bug report can be matched to the server log:

```ts
createServerApp({
  actions,
  onError: (err, info) => warn(`[${info.errorId ?? "-"}] ${info.actionId}`, err),
});
```

`createServerApp({ exposeInternalErrors: true })` sends a masked error's own name and
message instead, which is useful while developing. `createTestServerApp` turns it on by
default so a spec sees the real failure. `app.dispatch` follows the same rule.

## Middleware & error observability

`createServerApp({ middleware, onError })` wraps every action on every dispatch path:

```ts
import { actionError, createServerApp, type ActionMiddleware } from "aruna/server";

const requireAdmin: ActionMiddleware<Player> = async (info, proceed) => {
  if (info.actionId.startsWith("admin.") && !isAdmin(info.ctx.player)) {
    throw actionError("NotAuthorized", "not authorized");
  }
  return proceed(); // continue to the next layer / the action's run
};

createServerApp<Player>({
  actions,
  transport: robloxRemoteEvent(),
  middleware: [requireAdmin],
  onError: (err, info) => log.warn(`${info.actionId} failed for ${info.player}`, err),
});
```

`onError` receives `(err, { actionId, player, errorId })`: the original error, the
failing action's id, the calling player (when the dispatch had one), and, for an error
that is not public, the `errorId` the client was sent.

> roblox-ts reserves the identifiers `next` and `error` for compiler-internal use, so
> name parameters something else (`proceed` and `err` above) in any middleware or error
> handler you write — `next` and `error` will fail to compile.

Middleware is applied **outermost-first** and runs **inside rate limiting and input
validation** — a throttled or malformed request never reaches it, and `info.input` is
already validated. Short-circuit by throwing (the client gets the error response, masked
unless it is an `actionError`);
observe or transform by awaiting `proceed()`. `onError` fires for errors raised from the
execution chain (middleware, `run`, and output validation) before they propagate to the transport;
rate-limit and input-validation rejections are not routed through it.

## Fire-and-forget

Set `fireAndForget: true` for one-way actions (logging, telemetry) that don't need a
response. The client does not wait for an ack and `run`'s return value is discarded. Only
use it when you genuinely don't care whether/when the server finished.

## Retries and idempotency

`createClientApp({ retry: { maxRetries } })` retries a failed call. By default it retries
a rate-limit rejection — the server refused the call without running it — and never a
validation, serialization, or cancellation error.

A **timeout** is retried only for an action declared `idempotent: true`. A timeout does
not mean the server did not run the action: a purchase may have committed and only the
response was late, and sending it again would charge twice. Declare `idempotent: true`
only when running the action twice has the same effect as running it once (setting a
value, claiming something the action itself checks was not claimed yet). It must be a
boolean literal (`aruna::569` otherwise): the compiler records it in the manifest, and
the generated client stub passes `{ idempotent: true }`. A `retryOn` you supply replaces
the default rule entirely.

Retried or not, every attempt of one call carries the same **idempotency key**, and the
server runs a call once per key. A duplicate that arrives while the first attempt is
still running waits for it; one that arrives later gets the remembered result. The
server keeps a player's keys for 20 seconds (twice the default request timeout), at most
64 per player, and drops them when the player leaves. A call refused before it ran
(rate limited, invalid input) is not remembered, so its retry can still run. The key is
the 4th argument of the action RemoteEvent; anything other than a string of at most 64
characters is ignored. To de-duplicate across calls yourself (a double-clicked buy
button), pass your own: `invokeAction(id, input, { idempotencyKey })`, or
`app.dispatch(id, ctx, input, { idempotencyKey })` in-process.

Dropping `idempotent` from an action is a breaking change in `aruna contract diff`: a
client built against the old contract still retries the action's timeouts.

## Testing without a transport

`createServerApp` exposes `dispatch(actionId, ctx, input)` — the same validated,
rate-limited, middleware-wrapped path the wire uses, callable in-process with no
RemoteEvent. Supply the context (including a `player`) yourself:

```ts
const app = createServerApp({ actions });
const result = await app.dispatch("shop.purchaseItem", { player: fakePlayer }, { itemId: "sword" });
```

To execute compiled roblox-ts action modules outside Studio, run them under **Lune**
with the loader/fakes harness from `apps/roblox-runtime-test` — see its README for the
consumer adoption pattern. roblox-ts action code does not load under Node (Luau globals,
extensionless imports), so Node-side unit tests of real action modules are not the
supported path.
