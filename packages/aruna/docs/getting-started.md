# Getting started

Aruna is a type-safe networking layer for [roblox-ts](https://roblox-ts.com). You
declare **actions** (client → server request/response) and **signals** (server → client
push) once in TypeScript with schemas. The `aruna build` compiler classifies your files,
generates typed stubs and a runtime, wires up tsconfig path aliases, and emits a
Rojo-buildable project so server code lands in `ServerScriptService` (never replicated).

## Project shape

A consumer project that uses Aruna looks roughly like this:

```
my-game/
  aruna.config.ts            # defineConfig({...})
  tsconfig.json              # gets `aruna/*` + `$aruna/*` path aliases written for you
  default.project.json       # Rojo layout (service-separated)
  src/
    server.ts                # createServerApp + bind
    client.tsx               # createClientApp + call actions
    domains/
      shop/
        actions.ts           # defineAction(...)  (server-classified)
        schema.ts            # schema.object(...) shared types
    shared/                  # code safe for both sides
    .aruna/                  # GENERATED — do not edit, safe to delete & rebuild
```

Files are classified into `client` / `server` / `shared` by path convention (default
globs: `**/client/**`, `**/server/**`, `**/shared/**`, plus a few well-known entry
filenames). See [architecture.md](./architecture.md).

## The build loop

```bash
aruna init     # one-time: scaffold aruna.config.ts, tsconfig.json, default.project.json
aruna build    # generate stubs + manifest, vendor the runtime, compile to Luau (rbxtsc)
```

Run `aruna build` again every time you add or change an action or signal. `aruna check`
type-checks and validates boundaries but does **not** regenerate stubs — your client
calls will reference stale contracts if you only `check`. See [cli.md](./cli.md).

## A minimal round-trip

**1. Define the schema** (`src/domains/shop/schema.ts`) — shared:

```ts
import { schema, type Infer } from "aruna/schema";

export const purchaseItemInputSchema = schema.object({
  itemId: schema.string(),
  quantity: schema.number(),
});

export type PurchaseItemInput = Infer<typeof purchaseItemInputSchema>;
```

**2. Define the action** (`src/domains/shop/actions.ts`) — server-classified:

```ts
import { defineAction } from "aruna/roblox"; // ctx.player is typed Player (use aruna/server for unknown)
import { schema } from "aruna/schema";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  rateLimit: { key: "player", windowMs: 1000, max: 5 },
  input: schema.object({
    itemId: schema.string(),
    quantity: schema.number(),
  }),
  output: schema.object({
    ok: schema.boolean(),
    total: schema.number(),
  }),
  run(ctx, input) {
    // input is typed: { itemId: string; quantity: number }
    return { ok: input.quantity > 0, total: input.quantity * 50 };
  },
});
```

**3. Register on the server** (`src/server.ts`):

```ts
import { createServerApp } from "aruna/server";
import { robloxRemoteEvent } from "aruna/roblox";
import { actions, defaultRateLimit } from "$aruna/actions/server"; // generated

export function startServerApp() {
  return createServerApp<Player>({
    actions,
    defaultRateLimit,
    transport: robloxRemoteEvent(), // app owns the binding
  });
}

startServerApp();
```

**4. Call from the client** (`src/client.tsx`):

```ts
import { createClientApp } from "aruna/client";
import { purchaseItem } from "$aruna/actions/client"; // generated typed stub

export function startClientApp() {
  const clientApp = createClientApp(); // defaults to the Roblox action transport

  // Typed call; returns Promise<{ ok: boolean; total: number }>
  void purchaseItem({ itemId: "sword", quantity: 1 });

  return clientApp;
}

startClientApp();
```

Argless `createClientApp()` builds the default Roblox transport
(`createActionInvoker()` from `aruna/roblox`), which waits for the
`ReplicatedStorage/Aruna/Actions` RemoteEvent that the server-side
`robloxRemoteEvent()` transport creates. That is the whole wire — you never touch a
raw RemoteEvent. Pass `createClientApp({ transport })` to customize it (request ids,
timeouts, a RemoteFunction invoker, or an in-memory invoker in tests).

Next: [actions.md](./actions.md), [signals.md](./signals.md), [schema.md](./schema.md).
