# Actions

An **action** is a client → server request/response RPC. You define it once with
`defineAction`; the compiler generates a server registry and a typed client call
function.

## `defineAction`

`defineAction` is an identity helper — it returns the definition unchanged but pins the
literal types so the compiler and generated stubs can read them.

```ts
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",          // unique, dotted by convention
  rateLimit: { key: "player", windowMs: 1000, max: 5 },  // optional, per-action
  fireAndForget: false,             // optional; see below
  input: schema.object({ itemId: schema.string(), quantity: schema.number() }),
  output: schema.object({ ok: schema.boolean(), total: schema.number() }),
  run(ctx, input) {
    // ctx: { player?: TPlayer }, input: inferred from `input` schema
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
  run(ctx: { player?: TPlayer }, input: InferInput): InferOutput | Promise<InferOutput>;
};
```

`input` and `output` are both optional. Omit `input` for a no-argument action; omit
`output` for an action that returns nothing meaningful. `run` may be async.

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
discovered action) and `defaultRateLimit` (if your config sets one). Pass them to
`createServerApp`, then `bind` a transport.

```ts
import { createServerApp } from "aruna/server";
import { bindActions } from "aruna/roblox";
import { actions, defaultRateLimit } from "$aruna/actions/server";

const serverApp = createServerApp<Player>({ actions, defaultRateLimit });
const binding = serverApp.bind((registry) => bindActions(registry));
// binding.dispose() tears down the RemoteEvent handler (idempotent)
```

`createServerApp` options:

```ts
{
  actions: ActionRegistry;
  defaultRateLimit?: { key: "player"; windowMs: number; max: number };
  rateLimiter?: ActionRateLimiter;                  // custom limiter instance
  rateLimitKey?: (actionId, ctx) => string;         // custom bucket key
  nowMs?: () => number;                             // time source (tests)
}
```

`bindActions(registry, options?)` (from `aruna/roblox`) ensures
`ReplicatedStorage/Aruna/Actions` exists and routes incoming requests through the
registry with validation + rate limiting. Lower-level transports
(`bindRemoteEventActions`, `bindRemoteFunctionActions`) are also exported if you need to
supply your own RemoteEvent/RemoteFunction.

## Client calls

The generated `$aruna/actions/client` module exports one async function per action,
named after the export, with the action id and serialization baked in:

```ts
import { createClientApp } from "aruna/client";
import { createActionInvoker } from "aruna/roblox";
import { purchaseItem } from "$aruna/actions/client";

createClientApp({ invoker: createActionInvoker() });

const result = await purchaseItem({ itemId: "sword", quantity: 1 });
// result: { ok: boolean; total: number }
```

`createClientApp({ invoker })` installs the invoker process-wide so the generated stubs
can find it; call its `.dispose()` to clear it. `createActionInvoker(options?)` builds the
default RemoteEvent invoker; useful options: `createRequestId`, `requestTimeoutMs`.

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
