# RFC: UI bindings and optimistic updates (`aruna/ui`)

Status: **draft** (2026-11). Phases 1 and 2 are implemented: reading, invoking, and stub
options in `aruna/ui`, and optimistic updates (`invokeOptimistic`, the adapters'
`optimistic` option, the `o`, `k`, and `p` fields). Still open: the metrics and the starter
template (see [Rollout](#rollout)). Where the implemented part and this text
disagree, that is a bug in one of them, as for [resources.md](resources.md). It builds on
resources and on wire protocol v1 (docs/wire-protocol.md), and changes each only by adding
optional fields.

## Why

Resources and actions stop at a callback. A client reads
`questProgress.subscribe((value) => ...)` and calls `await purchaseItem(input)`, and every
screen that shows server state writes the same glue around them:

- subscribe when a component starts, mirror the value into its state, disconnect when it ends;
- track `loading` / `ready` / `error` by hand: a listener hears values and `onError` hears
  errors, but nothing reports the status itself;
- flash back to loading when one screen unmounts as the next mounts: the last local
  listener leaving ends the wire subscription and forgets the value, so the next screen
  subscribes from scratch and waits for a fresh snapshot;
- keep a pending flag per button, ignore a result that lands after the component is gone,
  and stop a double click from buying twice;
- edit what is displayed before the server answers, and undo it by hand when it fails.

The last item is where the bugs are, because a client cannot tell which snapshot is the
first to contain its call. A wallet resource holds 100 coins; a purchase costs 30 and is
shown as 70 at once:

| Rule | The ordering that breaks it | What the player sees |
| --- | --- | --- |
| drop the edit when the response arrives | the `load` is async, so its snapshot follows the response | 70, **100**, 70 |
| keep the edit until the next snapshot | the snapshot came first: a synchronous `load` queues it before the response, and a replacing item keeps an earlier item's place | 70, **40**, 70 |

Both orderings are part of the resources contract: read-your-writes is promised for a
synchronous `load` only, and a replacing state item may overtake a response. This RFC adds
the one piece of information that settles it, a mark on the snapshot that first contains a
call, and the bindings that make the common cases one line.

## Position

[init-spec](../init-spec.md) lists "React / Vide / Fusion bindings for resource hooks"
under Tier 3 (optional adapters) and UI renderers under Tier 4 (do not own). This RFC keeps
renderers out, since Aruna never imports one, but makes the bindings first-party: without
them, resources and actions stop short of the screen. init-spec's optimistic sketch
(`useAction(equipItem, { optimistic, onReject })`) waited for "basic resources and
invalidation"; they exist now. Its "Roblox-native server component" (§18), a server-shaped,
privilege-aware view-model, is what a player-scoped resource with `authorize` already is.
This RFC is the client half that puts one in a component.

## Goals

- Read a resource in a component in one line, with its status and error, and no flash when
  screens swap.
- Invoke an action from a component with pending and error state, nothing applied after
  the component is gone, and opt-in protection against a double submit.
- Opt-in optimistic updates that never apply twice and never flash back. They settle on what
  the server actually holds, not on how an action reports failure, and the server stays
  authoritative.
- One renderer-agnostic core, and thin adapters that each follow their renderer's model:
  React re-renders from immutable views, and Vide reads fine-grained accessors inside
  scopes. Any other renderer can use the core directly.

Not goals:

- A UI framework, component library, router, or general client store.
- Client writes to resources. An optimistic update is display-only: it is never sent, never
  part of a snapshot, and never raises a revision floor.
- Data fetching during render.
- Optimistic signals. A signal is an event, not state.

## Layers

| Layer | Subpath | Adds |
| --- | --- | --- |
| Client runtime | `aruna/client` | an `options` parameter on generated stubs; pending updates in the resource client; `invokeOptimistic` |
| Binding core | `aruna/ui` | `observeResource`, `peekResource`, `observeAction`; one retained subscription per resource |
| Adapters | `aruna/ui` | `createReactBindings`, `createVideBindings` |

### Renderers are injected

`aruna build` vendors every `.ts` file of the runtime into
`<generatedDir>/shared/runtime/`, which the project's tsconfig `include` covers. A runtime
module that imported `@rbxts/react` would fail to resolve in every project without React.
The adapters take the renderer as an argument instead. They are typed structurally against
the few functions they call (`useState`, `useEffect`, and `useMemo` for React; `source`,
`cleanup`, and `batch` for Vide), and a type test pins those types to the real
declarations:

```ts
// src/app/ui.ts — React
import React from "@rbxts/react";
import { createReactBindings } from "aruna/ui";

export const { useResource, useAction } = createReactBindings(React);
```

```ts
// src/app/ui.ts — Vide
import { batch, cleanup, source } from "@rbxts/vide";
import { createVideBindings } from "aruna/ui";

export const { resourceState, actionState } = createVideBindings({ source, cleanup, batch });
```

This costs one file per project. There is no build-time detection, no coupling to a
renderer's version, and the core runs under Lune without a renderer.

## Reading a resource

Whatever the renderer, a reader of a resource gets a `ResourceView`:

| Field | Meaning |
| --- | --- |
| `value` | The value to show: the newest snapshot with pending optimistic updates applied. `undefined` before the first snapshot. |
| `serverValue` | The newest snapshot alone. |
| `status` | `"loading"`, `"ready"`, or `"error"`, as `ResourceSubscription.status()`. An error keeps the last value. |
| `error` | The error name while `status` is `"error"`. |
| `pending` | Whether `value` has optimistic updates applied. |
| `revision` | The revision of the newest snapshot applied. |

- **One subscription per resource, retained.** Every reader of a resource on a client
  shares one `ResourceSubscription` through the core. When the last reader goes, the core
  keeps the subscription until the current resumption cycle ends (`task.defer`), or for
  `keepAliveMs` if the bindings were created with one. So a screen that goes away while the
  next one appears (a React remount, or a Vide `Show` or `Switch` swapping branches) never
  drops the value, and never sends an unsubscribe and a subscribe in the same frame.
- **A late reader sees the error.** A reader that arrives after an error item starts with
  `status: "error"`, read from the subscription. It does not wait for the next error item.
- **It needs the installed client**, as the generated bindings do:
  `createClientApp({ resources: true })`. Without one it throws the bindings' error.

React and Vide hand these fields out the way each renderer expects.

### React: `useResource`

```tsx
import { questProgress } from "$aruna/resources/client";
import { useResource } from "app/ui";

export function QuestPanel() {
  const quest = useResource(questProgress);
  if (quest.value === undefined) {
    return quest.status === "error" ? <ErrorRow name={quest.error} /> : <Spinner />;
  }
  return <QuestList progress={quest.value} dimmed={quest.pending} />;
}
```

`useResource(binding)` returns the current `ResourceView` as one immutable object, and
re-renders when it is replaced. Views change identity on every change, so nothing is lost
between render and subscribe: the hook renders `current()`, subscribes in an effect, and
re-renders if `current()` is no longer the view it rendered.

### Vide: `resourceState`

```tsx
import { Show } from "@rbxts/vide";
import { questProgress } from "$aruna/resources/client";
import { resourceState } from "app/ui";

export function QuestPanel() {
  const quest = resourceState(questProgress);
  return (
    <Show when={quest.value} fallback={() => <StatusRow status={quest.status} error={quest.error} />}>
      {(progress) => <QuestList progress={progress} dimmed={quest.pending} />}
    </Show>
  );
}
```

`resourceState(binding)` returns the same fields as accessors: `quest.value()`,
`quest.status()`, and so on. A Vide component runs once, so a field read as a plain value
when the component is created would never change. That is why the example branches with
`Show` instead of returning early, and passes accessors (`quest.pending`) as props, not
their current values.

- **It needs a stable scope:** a component body, a `Show` or `Switch` branch, or a `root`.
  It subscribes when called and registers the release with `cleanup`, and Vide's `cleanup`
  throws outside any scope ("cannot cleanup outside a stable or reactive scope"). A
  module-level store wraps it in a `root` that is never destroyed, which keeps the
  subscription for the app's lifetime:

  ```ts
  import { root } from "@rbxts/vide";
  import { wallet } from "$aruna/resources/client";
  import { resourceState } from "app/ui";

  const [, walletState] = root(() => resourceState(wallet));
  export { walletState };
  ```

- **No render-to-subscribe gap.** It starts from the core's current view, which the shared
  subscription keeps live, so there is nothing to re-check.
- **Not inside `effect` or `derive`.** Vide runs a reactive node's cleanups before each
  re-run, so a state created there is released and re-created on every run. Retention keeps
  the wire quiet, but the work is wasted.
- **One source per field, written in one `batch`.** A dependent re-runs only when a field it
  reads changes: an error item updates `status`, `error`, and `revision` and leaves `value`
  alone. Fields that change together are written inside one `batch`, so an effect that
  reads several of them never sees them half-updated.
- **Only changed fields are written.** Vide's setter skips an unchanged primitive, but it
  treats a mutable table as changed even when the same reference is written back. So the
  adapter writes a field only when it changed (by reference, for tables), and a status
  change never re-runs what reads `value`.

The Vide behaviour cited here is checked against the source and declarations of
`@rbxts/vide` 0.6.1 (`graph.luau`, `source.luau`, `cleanup.luau`, `batch.luau`,
`flags.luau`, `index.d.ts`), and the specs in `apps/roblox-runtime-test` run against that
package. Recheck it against the version a project pins.

## Invoking an action

Whatever the renderer, a call's state is an `ActionState`:

| Field | Meaning |
| --- | --- |
| `status` | `"idle"`, `"pending"`, `"success"`, or `"error"`, for the latest call. |
| `data` | The latest call's output, while `status` is `"success"`. |
| `error` | The latest call's rejection, while `status` is `"error"`. `isActionError(error, stub, name)` narrows it to a declared error. |
| `invoke(input)` | Starts a call and returns nothing. A rejection goes to `error` and `onError`, never to an unhandled promise. |
| `invokeAsync(input)` | Starts a call and returns its promise, which can reject. |
| `reset()` | Returns to `"idle"`. |

React hands out `status`, `data`, and `error` as values and re-renders when they change;
Vide hands them out as accessors (`purchase.status()`). The methods are plain functions in
both. The options are `exclusive`, `onSuccess(data, input)`, `onError(error, input)`, and
`optimistic` (below).

- **The latest call wins.** State follows the most recently started call. An earlier call
  that settles later does not overwrite it, though its own promise and callbacks still
  settle.
- **`exclusive: true`** ignores `invoke` while a call is pending (`invokeAsync` returns the
  pending call's promise), so a second click does not buy twice.
- **The end of a component cancels nothing.** A call that settles after its component
  unmounted (React) or its scope was destroyed (Vide) writes no state and runs no
  callback, and it is not cancelled. Cancelling would only stop the client waiting, not the server running, and it
  would hide a purchase that happened.
- **No retry of its own.** `createClientApp({ retry })` applies, as it does to any call.

### React: `useAction`

```tsx
import { purchaseItem } from "$aruna/actions/client";
import { isActionError } from "aruna/client";
import { useAction } from "app/ui";

export function BuyButton(props: { itemId: string }) {
  const purchase = useAction(purchaseItem, { exclusive: true });
  const soldOut = isActionError(purchase.error, purchaseItem, "OutOfStock");
  return (
    <textbutton
      Text={purchase.status === "pending" ? "..." : soldOut ? "Sold out" : "Buy"}
      Event={{ Activated: () => purchase.invoke({ itemId: props.itemId }) }}
    />
  );
}
```

### Vide: `actionState`

```tsx
import { purchaseItem } from "$aruna/actions/client";
import { isActionError } from "aruna/client";
import { actionState } from "app/ui";

export function BuyButton(props: { itemId: string }) {
  const purchase = actionState(purchaseItem, { exclusive: true });
  const label = () => {
    if (purchase.status() === "pending") {
      return "...";
    }
    return isActionError(purchase.error(), purchaseItem, "OutOfStock") ? "Sold out" : "Buy";
  };
  return <textbutton Text={label} Activated={() => purchase.invoke({ itemId: props.itemId })} />;
}
```

`Text={label}` stays live because `label` reads accessors. Events are function props
(`Activated`), not an `Event` table.

- **It needs a stable scope**, like `resourceState`: it registers `cleanup`, so nothing is
  written once the scope is gone.
- **Invoke from event handlers, not from `effect` or `derive`.** Vide re-runs a reactive
  node whenever something it reads changes, and its strict mode runs every update twice,
  so a call made there can go out more than once. Strict mode is on by default outside
  `-O2` builds (Vide checks whether its own functions get inlined), so in Studio a call
  from an effect goes out twice by default. `exclusive` only drops repeats while a call is
  pending.

### Stub options

Generated stubs take no options today (`(input) => invokeAction(id, input)`). So a cancel
token or an idempotency key, the documented fix for a double-clicked button, cannot reach
the call without bypassing the stub. Stubs gain an optional second parameter, merged with
what the stub already passes (`fireAndForget`, `idempotent`):

```ts
export const purchaseItem: ActionStub<PurchaseItemInput, PurchaseItemOutput, PurchaseItemErrors> = (input, options) => {
  return invokeAction("shop.purchaseItem", input, options) as Promise<PurchaseItemOutput>;
};
```

`ActionStub` gains `options?: ActionInvokeOptions` after the input. The optimistic path
needs this to mark its calls.

## Optimistic updates

```tsx
const purchase = useAction(purchaseItem, {
  exclusive: true,
  optimistic(input, update) {
    update(wallet, (w) => ({ ...w, coins: w.coins - priceOf(input.itemId) }));
    update(inventory, (inv) => ({ ...inv, items: [...inv.items, input.itemId] }));
  },
});
```

In Vide, `actionState` takes the same `optimistic` option, and every `resourceState` of
the resource shows the update in `value()`. Outside a component, use
`invokeOptimistic(stub, input, (update) => { ... }, options?)` from `aruna/client`, which
both adapters are built on. Either way the call is marked optimistic
and carries an idempotency key: the caller's own, or a fresh one.

### What a reader sees

For each resource, the resource client keeps the newest snapshot (as today) and a list of
pending updates, each tagged with the call that made it. A reader sees the snapshot with
every pending update applied, oldest call first.

- **The snapshot is never edited.** An update is a function that is re-run against every
  new snapshot. A change the server pushes while the call is pending (a quest reward,
  another player's trade) shows through, with the update still on top.
- **Edge cases.** An update made before the resource has a value waits for the first
  snapshot. An update that throws is skipped, with a `warn` in Studio, and the others still
  apply. Updates must be pure, because they run on every recompute.
- **Display only.** Updates are never sent and never raise the revision floor. A plain
  `subscribe` never sees them; `subscribe(listener, { optimistic: true })` does, and the
  core uses that.
- **Rollback is removal.** An update leaves when the snapshot it predicts arrives, or when
  that snapshot can no longer arrive (below). Nothing was written, so nothing has to be
  restored, and init-spec's `onReject` refetch is unnecessary.

### Settling: the snapshot that contains a call

An update must leave in the same step that applies the first snapshot containing its call.
Leaving earlier causes the "100" flash; leaving later causes the "40" one. The server knows
which snapshot that is: one from a load of the key that **started** after the call's
`invalidate`, the same rule revisions rest on. The server says so on the item.

**Tags (server).** When an optimistic call first invalidates a key the caller is subscribed
to, the server records a tag `(k, caller)` on that key, where `k` is the call's
idempotency key. A load takes the tags recorded before it starts. The tag is recorded
before the load that the `invalidate` itself starts: a synchronous `load` finishes inside
`invalidate`, so a tag recorded afterwards would miss its own item and wait for the
timeout. When its item is sent,
those tags are delivered and dropped. An item that is not sent (overtaken, or nobody left
to tell) delivers nothing, and the next load delivers the tags instead, since it also
started after them. The dirty follow-up needs no special case: an `invalidate` during a
load records its tag after that load started, so the running load's item goes out without
the tag and the follow-up carries it.

**Wire.** Three optional fields. A reader that does not know them ignores them, so the
protocol version stays 1.

| Item | Field | Meaning |
| --- | --- | --- |
| call, `t = 1` | `o` | `1`: this call has optimistic updates, so tag its invalidations. It is honoured only together with `k`; anything else in `o` is ignored. |
| state, `t = 4` | `k` | The idempotency keys of **this recipient's** calls whose tags this item delivers. Sent only when non-empty. Error items carry it too. |
| response, `t = 2` | `p` | The ids of resources this call tagged for the caller whose delivering item has not been queued yet. Sent only when non-empty. |

A global resource's item is shared by every subscriber; a recipient with tags gets a copy
that carries `k`. When a batched channel replaces a queued state item, the replacement
carries the union of both items' `k`, because the replaced item's tags were delivered when
it was queued.

**Client.** An update made by call `c` on resource `r` leaves at the first of these events:

| Event | Why |
| --- | --- |
| a state item for `r` whose `k` holds `c`, whether it is applied or dropped as stale | It is the first item that contains the call, so the update leaves in the step that handles it. (Items of one key arrive in revision order, so the stale case is defensive.) |
| `c`'s response, with `r` not in `p` | Either the delivering item already came, or the call did not invalidate `r` for this client and nothing will. |
| `c` rejects without a response: timeout, cancellation, version mismatch, transport | Nothing will confirm the update. |
| the subscription to `r` ends | Nothing is left to show the update on. |
| `settleTimeoutMs` passes after the response (after the call, for a fire-and-forget action); default 10 s | A load that never settles must not pin an update forever. The resources RFC sets no load timeout. |

The invoker hands a response's `p`, together with the key it sent, to the app's resource
client before it settles the call's promise. So an update never outlives the step that
settles it.

### What this guarantees

- **Convergence.** Every update leaves, at the latest on the timeout, and only snapshots
  write what the client holds. A reader always ends on the server's value.
- **No double application** (given the precondition below). The item that first contains a
  call removes that call's updates in the same step that applies it.
- **No flash back.** While a call's delivering item is still on its way, its update stays.
- **Failure needs no signal.** An action that returns `{ ok: false }` and invalidates
  nothing settles at its response and shows the unchanged value. An action that throws
  after invalidating settles on the snapshot of what it actually did.

The wallet example, settled:

- **Synchronous `load`.** The item `{ d: 70, k: [c] }` arrives first. Applying it removes
  the update in the same step, so the display goes from 70 to 70. The response then has
  nothing left to do.
- **Async `load`.** The response `{ p: ["wallet"] }` arrives first, and the update stays
  (still 70). The item then removes the update as it applies, again 70 to 70.

**Precondition: invalidate where you write.** The server sees the `invalidate`, not the
write. If a yield separates the write from the `invalidate`, another load (a resync, or
another call's invalidation) can read the change without the tag. That load's item then
shows the change with the update still on top, until the delivering item arrives. An action
that invalidates in the same synchronous step as its write has no such window, and that is
how `ctx.resources.invalidate` is meant to be used. A call that invalidates one resource
several times, yielding in between, settles on the first invalidation. After that, the
reader follows the server's intermediate values, and never shows the update applied twice.

### Cost

- Calls without `o` cost nothing, including an app's retried calls, which carry `k`
  already. So do optimistic calls that invalidate nothing.
- An optimistic call adds `o` to its call item, its key (at most 64 bytes) to one state
  item per resource it invalidates, and resource ids to its response, the last only while a
  delivering item is still on its way.
- Server: one tag per pair of call and invalidated key the caller is subscribed to. Tags
  are bounded by the 32 dispatches a player may have in flight and are dropped with the
  player.
- Client: one function per pending update; a recompute runs each pending update once.

## Edge cases

| Situation | Behaviour |
| --- | --- |
| an update for a resource the client is not subscribed to | Ignored, with a `warn` in Studio: nothing would show it. |
| the call is retried | Every attempt carries the same key, so the server runs the call once and tags once. |
| two optimistic calls with one key (a double click that reuses a key) | One logical call: the server runs it once, and the client applies its updates once. The second call adds none. |
| two calls update one resource | Applied oldest first. Each leaves on its own item, so the second stays on top of a snapshot that contains only the first. |
| the delivering load fails | The error item carries `k`, and the update leaves. The reader sees the last snapshot with `status: "error"`. |
| the subscription is refused (`ResourceForbiddenError`) | Nothing is tagged, because the caller is not subscribed. Updates leave at the response. |
| a fire-and-forget action | There is no response, so its updates leave only on a delivering item or the timeout. |
| a custom `ClientTransport` | It does not hand `p` to the resource client, so updates leave only on delivering items, rejections, or the timeout. `createTestNetwork` does hand `p`, as the default transport does. |
| the player leaves, or the client app is disposed | Everything goes with the subscriptions. |

## Compiler and tooling

- `aruna/ui` is a new runtime subpath, added everywhere a subpath is registered:
  `ARUNA_RUNTIME_MODULES` (the tsconfig alias), the vendoring anchors, `package.json`
  `exports`, the native declarations, an API report (`api/aruna-ui.d.ts`), and the subpath
  table in [stability.md](../stability.md). Like `aruna/client` it is vendored runtime, so
  no boundary rule changes.
- Codegen: stubs take `options`, and the goldens change.
- No new diagnostics. A later diagnostic could flag an `optimistic` update of a resource
  the action never invalidates, since such an update always settles at the response.
- Metrics: count optimistic updates settled by item, by response, by rejection, and by
  timeout. A rising timeout count points at a hanging `load`.

## Testing

- The core under Lune with a fake channel: recomputes, retention, stable view identity,
  latest call wins, `exclusive`, callbacks.
- `createTestNetwork`, with one spec per ordering, each failing without its rule:
  - the item before the response (synchronous load);
  - the response first (async load on the virtual clock);
  - a replaced item carrying the union of `k`;
  - the dirty follow-up;
  - a failed delivering load;
  - a rejection with no response (timeout on the virtual clock);
  - a retried call;
  - unsubscribe while pending;
  - the settle timeout;
  - a global resource where only the caller gets `k`.
- Vide: specs against the real `@rbxts/vide` under Lune. From the npm package its
  `lib.luau` cannot run outside Roblox (it requires a `test/mock` the package does not
  ship), so Vide loads under the `aruna test` fake game, as it would in a game. That
  needed the loader to learn `init.luau` modules and string requires, and the fakes to
  cover `ReflectionService`, any `Enum` item, and the profiler markers. The specs cover
  the scope rules, skipped unchanged fields, a scope swap inside the retention window, a
  module-level `root` store, and the double call that `invoke` makes from a strict-mode
  effect (documented, not prevented).
- React: a fake renderer that implements the structural interface, covering the
  render/subscribe re-check, unless react-lua turns out to run under Lune.
- In `apps/rbxts-harness`, a type test that both factories accept the real packages'
  declarations.

## Alternatives considered

- **Import the renderer in the runtime.** It fails to resolve in every project without
  that renderer.
- **Vendor the adapter only when its renderer is installed.** This breaks whole-runtime
  vendoring and its integrity check. An editor would also see a missing module between
  installing the renderer and the next build.
- **Generate `$aruna/ui/react` when `@rbxts/react` is installed**, the way
  `node_modules.project.json` follows `node_modules/`. It removes the setup line, but the
  generated code then has to track a renderer's API. It could come later, on top of
  injection.
- **Drop updates at the response.** This gives the "100" flash on every async load.
- **Keep updates until the next snapshot.** This gives the "40" double application
  whenever the snapshot comes first.
- **A revision watermark in the response** (keep the update until the floor passes it).
  This is right for late items. But an item that arrived before the response is still shown
  with the update on, which is the "40" case for as long as `run` keeps yielding after its
  `invalidate`.
- **Hold the response until its loads are queued.** This is the shape of a Next.js action
  response that carries the revalidated data. It fixes late items, but it ties every
  action's latency to its slowest `load`, and it still applies an update twice when `run`
  yields after a synchronous invalidate.
- **Write the cached value and restore it on failure**, as data-fetching libraries do. A
  push that lands while the call is pending is either lost or resurrected by the restore.
  The rebase model has nothing to restore.

## Rollout

1. **No wire change.** Done (2026-11), except the starter template: stub options;
   `aruna/ui` with the core and retention; both adapters (Vide's specs run against the
   real Vide under Lune, React's against a stand-in); `packages/aruna/docs/ui.md`. Still
   open: an opt-in UI template for the starter.
2. **Optimistic updates.** Done (2026-11), except the metrics: server tags; the `o`, `k`,
   and `p` fields; pending updates in the resource client;
   `subscribe(listener, { optimistic: true })` and `ResourceSubscription.pending()`;
   `invokeOptimistic`; the adapters' `optimistic` option. The resources RFC and the wire
   protocol were updated with it. The specs in `optimistic.spec.ts` cover every ordering
   listed under Testing; moving the tag capture from a load's start to its end fails two
   of them with exactly the flash this RFC opens with (`[100, 70, 50, 70, 50]`). Still
   open: the settle counters.
3. **Later.** The generated adapter module; typed declared errors on `ActionState`; a
   devtools panel that reads the core; resource patches. Patches leave the model unchanged:
   updates apply to the patched value.

## Open questions

- Vide naming: `resourceState` / `actionState`, or names closer to Vide's own.
- Whether `resourceState` should also work outside a scope, handing back a `release`, so a
  module-level store needs no `root`.
- Whether the resource client should freeze the snapshots it hands out. Vide compares
  frozen tables by reference, so writing an unchanged one back would be skipped for free,
  and an update that mutates its argument would fail loudly instead of corrupting the
  snapshot.
- The `keepAliveMs` default: the resumption cycle, or seconds for tab-like screens.
- `settleTimeoutMs`: a fixed default, or follow `requestTimeoutMs`.
- Whether `o` is worth its bytes, or every call that carries `k` should be tagged.
- Whether `exclusive` should be the default.
- Whether react-lua runs under Lune well enough to test the React adapter against the real
  renderer, or only against the fake.
- The starter contract ([create-app-plan.md](../create-app-plan.md)) keeps every UI
  framework out of the starter. An opt-in template flag keeps that true; this needs
  confirming.
