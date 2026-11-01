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
  readonly rateLimit?: {
    key: "player" | "global" | ((info) => string);
    windowMs: number;
    max: number;
    strategy?: "fixedWindow" | "tokenBucket"; // default "fixedWindow"
  };
  readonly fireAndForget?: boolean;
  readonly idempotent?: boolean;
  readonly input?: Schema;
  readonly output?: Schema;
  // The failures a client can tell apart; see "Declared errors".
  readonly errors?: { readonly [name: string]: { readonly data?: Schema } };
  run(
    // `fail` is there only when the action declares `errors`.
    ctx: { player?: TPlayer; publisher?: SignalPublisher; fail?: ActionFail },
    input: InferInput,
  ): InferOutput | Promise<InferOutput>;
};
```

`input` and `output` are both optional. Omit `input` for a no-argument action; omit
`output` for an action that returns nothing meaningful. `run` may be async.

### Inputless actions

The generated stub of an action with no `input` schema — or an input that accepts
`undefined`, `schema.optional(...)` — takes its input as an optional parameter, so it is
called with no argument:

```ts
// src/domains/lobby/actions.ts
export const ready = defineAction({ id: "lobby.ready", run: (ctx) => markReady(ctx.player) });

// client
import { ready } from "$aruna/actions/client";
await ready();          // the stub is (input?: ReadyInput) => Promise<ReadyOutput>
await ready(undefined); // the same call; earlier stubs required this form
```

Both forms send a call item with no `d` field (an omitted input is `nil` in Luau), and
the server runs the action with `input === undefined`. An action whose input schema is
required keeps a required parameter: `purchaseItem()` is a type error, and a call that
reaches the server without the input is refused with `ActionValidationError`.
`ActionStub<TInput, TOutput, TErrors>` follows the same rule, so a stub with declared
errors and no input is called as `stub()` too.

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
ensures the flat `ReplicatedStorage/ArunaRemoteEvent` exists and routes incoming
requests through the registry with validation + rate limiting. Responses go back through
the same per-player channel as signals, so anything an action published reaches the
client before its response ([wire protocol](../../../docs/wire-protocol.md#one-ordered-reliable-channel-per-player)). `bindActions(registry)`
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

`key: "player"` buckets by `ctx.player.UserId`. For finer buckets, pass a function:
`` key: (info) => `target:${(info.input as { targetId: string }).targetId}` ``
throttles per target, and every call that returns the same string shares one bucket.
When a limit is exceeded the dispatcher refuses the call with `ActionRateLimitError`,
carrying `retryAfterMs` and `resetAtMs`.

### Fixed window or token bucket

`strategy` decides how calls are counted. Both allow `max` calls per `windowMs`
sustained; they differ in the bursts they let through.

| `strategy` | Counts | A burst | `retryAfterMs` on a refusal |
| --- | --- | --- | --- |
| `"fixedWindow"` (default) | calls since the current window began | up to 2 × `max` across a window boundary: `max` at the end of one window, `max` at the start of the next | until the window resets |
| `"tokenBucket"` | tokens: the bucket holds `max`, a call takes one, and `max` come back evenly over `windowMs` | never more than `max` | until the next token arrives |

```ts
// At most 10 shots at once, then 10 a second.
defineAction({ id: "combat.fire", rateLimit: { key: "player", windowMs: 1000, max: 10, strategy: "tokenBucket" } /* ... */ });
```

A client that keeps to `max` calls in any `windowMs` is admitted by either one, so
`aruna contract diff` reports a strategy change as info. `actions.defaultRateLimit`
takes `strategy` too.

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
| Envelope budget: a token bucket charged for **every** envelope before it is read | 60 burst, 30 per second | dropped, no response |
| Request id a string of at most 64 characters, action id at most 128 | — | dropped, no response |
| The action exists | — | dropped, no response |
| Dispatches running at once | 32 | `ActionRateLimitError` (`retryAfterMs: 100`) |
| Values in the input, however shallow (the wire-safety walk) | 2048 | `ActionSerializationError` |

**A call its action's own rate limit admits gets its token back.** That limit already
prices the call, and charging it twice would let the budget throttle an action below the
rate it declares: a fire-and-forget input declared at `max: 60` a second would otherwise
run into the budget's 30. What the budget is left pricing is the work that leads nowhere
— malformed envelopes, unknown actions, invalid input, calls refused by a rate limit or
the in-flight cap — and every call to an action with no rate limit at all (neither its
own nor `defaultRateLimit`).

**A call to an unknown action is not answered.** A client always runs its own server's
build, so only a forged id gets there, and an `ActionNotFoundError` would tell the sender
which ids exist; a caller sees its request time out instead. In-process dispatch
(`app.dispatch`, the test harness) still rejects with `ActionNotFoundError`.

Each dispatch then runs in the order that keeps a hostile payload cheap: wire safety,
then `.default(...)` filling, then validation, then the per-action rate limit. An action's
own output and a signal payload are server-authored, so they are not held to the
2048-value limit.

`onAbuse` hears about each of these, with the action id where there is one and a running
count per player and reason since they joined, so the decision to kick is the game's:

```ts
createServerApp({
  actions,
  transport: robloxRemoteEvent(),
  requestBudget: { burst: 60, perSecond: 30, maxInFlight: 32 },
  onAbuse: (player, { reason, actionId, count }) => {
    warn(`${player.Name}: ${reason} ${actionId ?? ""} (#${count})`);
    // A real client never sends these; a rate limit, on the other hand, can be
    // hit by someone mashing a button.
    if ((reason === "malformed-envelope" || reason === "unknown-action") && count >= 5) {
      player.Kick("Unexpected network traffic");
    }
  },
});
```

| `reason` | What happened | Answered? |
| --- | --- | --- |
| `malformed-envelope` | an item that is not a call, or a call with bad ids; also a frame that is not one | no |
| `unknown-protocol-version`, `oversize-batch` | a frame dropped whole ([wire protocol](../../../docs/wire-protocol.md#receiving)) | no |
| `budget-exhausted` | the envelope budget was empty | no |
| `unknown-action` | the action id names no action | no |
| `too-many-in-flight` | the player was at the in-flight cap | `ActionRateLimitError` |
| `invalid-input` | the input failed wire safety or its schema | `ActionSerializationError` / `ActionValidationError` |
| `rate-limited` | the action's rate limit refused it | `ActionRateLimitError` |

`RequestAbuseReason`, `RequestAbuseInfo`, `RequestAbuseHandler`, and `RequestBudgetOptions`
are exported from `aruna/server` for a handler typed on its own.

A player's budget, in-flight count, and report counts are dropped when they leave, and for
30 seconds after (or until they join again) an envelope that still arrives from them is
dropped rather than starting that state over.

Both limits are for a client's envelopes, so only the transport applies them. `app.dispatch`
in-process (and the test harness's `invoke` and `client`) is trusted server code: it is
never charged to the budget nor refused for having too many calls running. Validation, the
per-action rate limit, middleware, and idempotency apply to it as on the wire.

### Bounding input

The wire walk caps how many values an input holds, not how long a string in it is, and
an array or record is validated entry by entry up to that cap. A declared bound is where
the server refuses an oversized payload itself, before your code sees it:

```ts
input: schema.object({
  name: schema.string().maxChars(20),
  tags: schema.array(schema.string().maxLength(32)).maxItems(8),
  scores: schema.record(schema.u16()).maxEntries(16),
}),
```

The compiler reports an action whose input leaves a string, array, or record without an
upper bound as `aruna::514 unbounded-action-input`, listing every such path
(`input.tags[]`). A bound computed at runtime counts as one. It is a warning by default;
`strict.unboundedInput` makes it an `"error"` or turns it `"off"`, and
`diagnostics.ignore` drops it project-wide. Outputs and signal payloads are
server-authored and not checked.

## Errors the client sees

An error reaches the client with its own `name` and `message` only when it is public.
Public means one of the framework's own failures about the request listed above, an
error your action throws through `actionError`, or one it declared and threw with
`ctx.fail` ([declared errors](#declared-errors)). An action's *output* failing its schema
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

### Declared errors

`actionError` reaches the client, but nothing tells the client which names to expect or
what comes with them. Declare the failures a client should be able to tell apart in the
action's `errors`, and throw them with `ctx.fail`:

```ts
export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: schema.object({ itemId: schema.string().maxLength(64) }),
  errors: {
    OutOfStock: { data: schema.object({ itemId: schema.string(), restockIn: schema.u16() }) },
    NotEnoughCoins: {},
  },
  run(ctx, input) {
    if (stock(input.itemId) === 0) {
      throw ctx.fail("OutOfStock", { itemId: input.itemId, restockIn: 30 });
    }
    if (!canAfford(ctx.player, input.itemId)) {
      throw ctx.fail("NotEnoughCoins");
    }
    // ...
  },
});
```

`ctx.fail` exists only on an action that declares `errors`, takes only a declared name,
and checks the data against that error's schema at compile time (none for an error
declared without `data`). It throws; write `throw ctx.fail(...)` (or `return`) so the code
after it is known to be unreachable. The client receives the error's `name` as both
`name` and `message`, and its data as `data`.

The server checks every error of a declared name against its declaration before it goes
out, whether `ctx.fail` threw it or middleware threw an `actionError` of that name: the
data must be wire-safe and pass the declared schema, an error declared without data must
carry none, and `ctx.fail` may not name an undeclared error. A mismatch is a server bug,
so it is handled like a failing output: `onError` gets an `ActionValidationError` that
says what did not match (an `ActionSerializationError` when the data is not wire-safe),
and the client gets `ActionInternalError` with the `errorId`.
An `actionError` of a name the action does not declare still goes out as before,
untyped.

The generated client stub carries the declared errors in its type, and `isActionError`
(from `aruna/client`) narrows a rejection to one of them:

```ts
import { isActionError } from "aruna/client";
import { purchaseItem } from "$aruna/actions/client";

purchaseItem({ itemId }).catch((err: unknown) => {
  if (isActionError(err, purchaseItem, "OutOfStock")) {
    showRestockTimer(err.data.restockIn); // err.data: { itemId: string; restockIn: number }
  } else if (isActionError(err, purchaseItem, "NotEnoughCoins")) {
    openCoinShop();
  }
});
```

The check is by name. Pass the stub the rejection came from: another action may declare
the same name with other data.

`errors` must be an object literal of error names, each an object literal with an
optional `data` schema (`aruna::584 invalid-action-errors` otherwise, as is a name that is
not an identifier, one of Aruna's own error names, or `errors` on a `fireAndForget` action,
which sends no response). A `data` schema the compiler cannot read is
`aruna::585 action-error-data-schema-invalid`. The manifest, `aruna inspect actions`, and
the contract snapshot list each action's errors, and the contract hash covers them.

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
the call's `k` field on the wire ([wire protocol](../../../docs/wire-protocol.md));
anything other than a string of at most 64 characters is ignored. To de-duplicate across calls yourself (a double-clicked buy
button), pass your own: `invokeAction(id, input, { idempotencyKey })`, or
`app.dispatch(id, ctx, input, { idempotencyKey })` in-process.

Dropping `idempotent` from an action is a breaking change in `aruna contract diff`: a
client built against the old contract still retries the action's timeouts.

## Contract changes

`aruna contract diff` compares the contract snapshot of two builds and sorts every change
by what it does to a client built against the older one. Input travels client → server
and output server → client, so the same edit can mean opposite things on each side:

| Change | Input | Output |
| --- | --- | --- |
| A field added | **breaking** if required, non-breaking if optional | non-breaking |
| A field removed | info (unknown input fields are ignored) | **breaking** |
| A field's type changed | **breaking** | **breaking** |
| A bound tightened: `maxLength` lowered, `min` raised, `.int()` or a `.refine()` added, a bound added where there was none | **breaking** — an old client may send what the server now refuses | non-breaking |
| A bound loosened: the reverse | non-breaking | **breaking** — an old client may receive what it was promised it would not |
| A `.refine()` predicate or a computed bound changed (seen, not judged) | warning | warning |
| The rate limit's throughput lowered / raised | **breaking** / non-breaking | |
| The rate limit's `strategy` changed | info | |
| `idempotent` dropped / added | **breaking** / non-breaking | |
| A declared error added | | non-breaking — an old client reads it as any other failure |
| A declared error removed | | info — an old client's handling of it goes unused |
| An error's `data` changed | | as an output: a field removed or retyped is **breaking**, one added non-breaking; data appearing is non-breaking, data dropped **breaking** |

A signal payload follows the output column. The bounds come from what the compiler
records for each schema ([Schema](./schema.md#what-the-compiler-records)); a change to a
bound inside a union member is reported as the union changing. A version 1 snapshot,
written before bounds were recorded, is still read, but no bounds are compared against
it: the diff says so in an info entry, and `aruna contract update` writes the current
format.

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
