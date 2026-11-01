# UI bindings (`aruna/ui`)

`aruna/ui` puts resources and actions into a component: a resource's value, status, and
error as something a component reads, and a call's pending, success, and error state as
something it renders. It ships a renderer-agnostic core and two thin adapters, for
`@rbxts/react` and for Vide. The design is in
[docs/rfcs/ui-bindings.md](../../../docs/rfcs/ui-bindings.md).

Aruna never imports a renderer. The runtime is vendored into your project and compiled
whole, so an `@rbxts/react` import inside it would fail to resolve in every project
without React. You hand the renderer to the adapter once:

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

Both need the client app's resource client, as the generated resource bindings do:
`createClientApp({ resources: true })`.

## Reading a resource

A reader of a resource sees a `ResourceView`:

| Field | Meaning |
| --- | --- |
| `value` | The value to show: the newest snapshot with pending optimistic updates applied. `undefined` before the first snapshot. |
| `serverValue` | The newest snapshot alone. |
| `status` | `"loading"`, `"ready"`, or `"error"`. An error keeps the last value. |
| `error` | The error name (`ResourceLoadError`, `ResourceForbiddenError`) while `status` is `"error"`. |
| `pending` | Whether `value` has optimistic updates applied. |
| `revision` | The revision of the newest snapshot applied. |

Every reader of a resource on a client shares one subscription. When the last reader
goes, it is kept until the current resumption cycle ends, so a screen that goes away
while the next one appears never drops the value or resubscribes. Pass `keepAliveMs` to
either factory to keep it longer:

```ts
export const { useResource, useAction } = createReactBindings(React, { keepAliveMs: 5000 });
```

### React

```tsx
import { questProgress } from "$aruna/resources/client";
import { useResource } from "app/ui";

export function QuestPanel() {
  const quest = useResource(questProgress);
  if (quest.value === undefined) {
    return quest.status === "error" ? <ErrorRow name={quest.error} /> : <Spinner />;
  }
  return <QuestList progress={quest.value} />;
}
```

`useResource` returns the current view as one immutable object and re-renders when it is
replaced. Rendering holds nothing; the subscription is taken in an effect.

### Vide

```tsx
import { Show } from "@rbxts/vide";
import { questProgress } from "$aruna/resources/client";
import { resourceState } from "app/ui";

export function QuestPanel() {
  const quest = resourceState(questProgress);
  return (
    <Show when={quest.value} fallback={() => <StatusRow status={quest.status} error={quest.error} />}>
      {(progress) => <QuestList progress={progress} />}
    </Show>
  );
}
```

`resourceState` returns the same fields as accessors (`quest.value()`, `quest.status()`).
A Vide component runs once, so branch with `Show` rather than returning early, and pass
accessors as props rather than their current values. Each field is its own source and is
written only when it changed, so an error, which changes the status and keeps the value,
re-runs nothing that reads `value`.

- **It needs a stable scope**: a component body, a `Show` or `Switch` branch, or a
  `root`. It registers its release with `cleanup`, which Vide refuses outside a scope
  ("cannot cleanup outside a stable or reactive scope"); nothing is subscribed when it
  does. For a store that lives as long as the game, wrap it in a `root` you never
  destroy:

  ```ts
  import { root } from "@rbxts/vide";
  import { wallet } from "$aruna/resources/client";
  import { resourceState } from "app/ui";

  const [, walletState] = root(() => resourceState(wallet));
  export { walletState };
  ```

- **Not inside `effect` or `derive`.** Vide runs a reactive node's cleanups before each
  re-run, so a state created there is released and created again on every run.

## Invoking an action

A call's state is an `ActionState`:

| Field | Meaning |
| --- | --- |
| `status` | `"idle"`, `"pending"`, `"success"`, or `"error"`, for the latest call. |
| `data` | The latest call's output, while `status` is `"success"`. |
| `error` | The latest call's rejection, while `status` is `"error"`. `isActionError(error, stub, name)` narrows it. |
| `invoke(input, options?)` | Starts a call. A rejection goes to `error` and `onError`, never to an unhandled promise. |
| `invokeAsync(input, options?)` | Starts a call and returns its promise, which rejects. |
| `reset()` | Back to `"idle"`; a call still running no longer writes the state. |

`invoke` takes what the stub takes: an inputless action's input stays optional.

Options: `exclusive` ignores `invoke` while a call is pending (`invokeAsync` returns the
pending call's promise), so a second click does not buy twice; `onSuccess(data, input)`
and `onError(reason, input)` run for every call that settles while the component is
alive, not only the latest.

- **The latest call wins.** An earlier call that settles after a later one started does
  not overwrite the state.
- **When the component goes, the call is not cancelled.** It writes no state and runs no
  callback. Cancelling would only stop the client waiting, not the server running, and
  it would hide a purchase that happened.
- **No retry of its own.** `createClientApp({ retry })` applies as to any call.

### React

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

### Vide

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

**Call `invoke` from event handlers, never from `effect` or `derive`.** Vide re-runs those
whenever something they read changes, and its strict mode runs every update twice. Strict
mode is on by default outside `-O2` builds, so in Studio: an `invoke` in an effect sends
the call twice there. `exclusive` only drops repeats while a call is pending.

## Per-call options on generated stubs

Every generated stub takes an optional second argument, `ActionInvokeOptions`: a cancel
token or an idempotency key for one call.

```ts
await purchaseItem({ itemId: "sword" }, { idempotencyKey: clickId });
```

What the action declares wins: an idempotent action's stub still passes
`idempotent: true`, and a fire-and-forget action stays one-way, whatever the call passes.

## Other renderers

The adapters are built on three functions any renderer can use:

- `observeResource(binding, options?)` holds the shared subscription until `release()`;
  `current()` is the view, `onChange(listener)` hears every change.
- `peekResource(binding)` is the view a reader would start from, holding nothing, for a
  renderer that must not subscribe while it renders.
- `observeAction(stub, options?)` is one component's call state, with `invoke`,
  `invokeAsync`, `reset`, `onChange`, and `dispose`.

## Testing

`aruna test` loads Vide the way a game does, so a spec can create roots, sources, and
effects and drive them with `createTestServerApp`. Vide's strict mode is on there too.
react-lua is not loaded under Lune; test a React component's logic through the core
functions above, or with a stand-in that implements the three hooks the adapter calls
(`useState`, `useEffect`, `useMemo`).

## Optimistic updates

Show what a call will do before the server answers, and let the server's own snapshot
take over when it arrives:

```tsx
const purchase = useAction(purchaseItem, {
  exclusive: true,
  optimistic(input, update) {
    update(wallet, (w) => ({ ...w, coins: w.coins - priceOf(input.itemId) }));
  },
});
```

Vide's `actionState` takes the same option. Outside a component, call
`invokeOptimistic(purchaseItem, input, (update) => { ... }, options?)` from
`aruna/client`.

- **The snapshot is never edited.** An update is a function re-run over every new
  snapshot until the one that contains its call arrives, so a change the server pushes
  meanwhile still shows through. Updates must be pure, and must not change their argument.
- **Rollback is removal.** The server tags the call's invalidations with its idempotency
  key, and the first snapshot loaded after them names the call: its updates leave in the
  step that applies that snapshot. Never earlier, so the old value never flashes back;
  never later, so no update applies twice.
- An update also leaves when the call's response says the call did not invalidate that
  resource, when the call fails with no response (a timeout, a cancellation), when the
  subscription ends, or after `settleTimeoutMs` (10 seconds,
  `invokeOptimistic(..., { settleTimeoutMs })`) if its snapshot never comes.
- **Failure needs no signal.** An action that returns `{ ok: false }` and invalidates
  nothing settles at its response, showing the unchanged value.
- **Invalidate where you write.** The server sees the `invalidate`, not the write. Keep the
  two in the same synchronous step, or another load can read the change before it is
  announced and show it with the update still on top.
- An update of a resource the client is not subscribed to is ignored. Two calls with one
  idempotency key are one call, and its updates apply once.
- A plain `subscribe` never sees an update; `subscribe(listener, { optimistic: true })`
  does, and `subscription.pending()` says whether one applies.

The protocol is in [docs/rfcs/ui-bindings.md](../../../docs/rfcs/ui-bindings.md#optimistic-updates).
