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
to `Player`, giving you `ctx.player?: Player` for free:

```ts
import { defineAction } from "aruna/roblox";
// ctx.player is Player | undefined here
```

`ctx.player` is **optional at runtime** regardless of typing — tests dispatch actions
with no player (see in-memory invoker below). Guard it: `ctx.player?.UserId`.

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
  actions: ActionRegistry;
  transport?: ServerTransport;                      // owns the remote binding (recommended)
  defaultRateLimit?: { key: "player"; windowMs: number; max: number };
  rateLimiter?: ActionRateLimiter;                  // custom limiter instance
  rateLimitKey?: (actionId, ctx) => string;         // custom bucket key
  nowMs?: () => number;                             // time source (tests)
}
```

`robloxRemoteEvent(options?)` (from `aruna/roblox`) is the default transport: it ensures
`ReplicatedStorage/Aruna/Actions` exists and routes incoming requests through the registry
with validation + rate limiting. `robloxRemoteFunction(remote, options?)` does the same over
a RemoteFunction. Lower-level binders (`bindActions`, `bindRemoteEventActions`,
`bindRemoteFunctionActions`) remain exported if you wire your own remote — wrap one in an
inline `transport: ({ registry, dispatch }) => bindActions(registry, dispatch)` so the app
still owns the binding and `defaultRateLimit` reaches the wire.

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
e.g. `createActionInvoker({ createRequestId, requestTimeoutMs })`, a RemoteFunction
invoker, or an in-memory invoker in tests.

You can also call the low-level `invokeAction(actionId, input, options?)` from
`aruna/client` directly, but prefer the generated typed stubs.

## Rate limiting

Limits are always keyed per player. Resolution order: the action's own `rateLimit`, then
the app/config `defaultRateLimit`, then unlimited.

```ts
defineAction({ id: "shop.buy", rateLimit: { key: "player", windowMs: 1000, max: 5 } /* ... */ });
```

```ts
// aruna.config.ts — applies to every action without its own rateLimit
defineConfig({ actions: { defaultRateLimit: { key: "player", windowMs: 1000, max: 20 } } });
```

The default key resolver uses `ctx.player.UserId`; players that are missing collapse to a
shared `"anonymous"` bucket. Override with `rateLimitKey` if you need finer buckets. When
a limit is exceeded the dispatcher throws `ActionRateLimitError` (`retryAfterMs`,
`resetAtMs`, `max`, `windowMs`).

## Middleware & error observability

`createServerApp({ middleware, onError })` wraps every action on every dispatch path:

```ts
import { createServerApp, type ActionMiddleware } from "aruna/server";

const requireAdmin: ActionMiddleware<Player> = async (info, proceed) => {
  if (info.actionId.startsWith("admin.") && !isAdmin(info.ctx.player)) {
    throw new Error("not authorized");
  }
  return proceed(); // continue to the next layer / the action's run
};

createServerApp<Player>({
  actions,
  transport: robloxRemoteEvent(),
  middleware: [requireAdmin],
  onError: (error, info) => log.warn(`${info.actionId} failed`, error),
});
```

> roblox-ts reserves the identifier `next` for compiler-internal use, so name the
> second parameter something else (`proceed` above) in any middleware you write —
> `next` will fail to compile.

Middleware is applied **outermost-first** and runs **inside rate limiting and input
validation** — a throttled or malformed request never reaches it, and `info.input` is
already validated. Short-circuit by throwing (the client gets the error response);
observe or transform by awaiting `proceed()`. `onError` fires for errors raised from the
execution chain (middleware and `run`) before they propagate to the transport;
rate-limit and input-validation rejections are not routed through it.

## Fire-and-forget

Set `fireAndForget: true` for one-way actions (logging, telemetry) that don't need a
response. The client does not wait for an ack and `run`'s return value is discarded. Only
use it when you genuinely don't care whether/when the server finished.

## Testing without a transport

`createInMemoryActionInvoker(registry, ctx?)` from `aruna/client` calls actions directly
against a registry — no RemoteEvent — which is how unit tests exercise actions. This is
why `ctx.player` is optional.

```ts
import { createInMemoryActionInvoker } from "aruna/client";
const invoker = createInMemoryActionInvoker(actions);
```
