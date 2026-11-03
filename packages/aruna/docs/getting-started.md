# Getting started

Aruna is a type-safe networking layer for [roblox-ts](https://roblox-ts.com). You
declare **actions** (client → server request/response) and **signals** (server → client
push) once in TypeScript with schemas. The `aruna build` compiler classifies your files,
generates typed stubs and a runtime, wires up tsconfig path aliases, and emits a
Rojo-buildable project so server code lands in `ServerScriptService` (never replicated).

## Supported platforms

The compiler core is a native binary, published as one `@arunajs/compiler-<target>`
package per target. npm installs the one that matches your machine. Every release builds
all eight. Before publishing, each binary is loaded on a runner with the same OS, CPU and
libc and called into, so a binary that can't run blocks the release.

| Target | Loaded on | Full test suite runs on |
| --- | --- | --- |
| `darwin-arm64` | macOS 14, Apple silicon | maintainer machines |
| `darwin-x64` | macOS 15, Intel | — |
| `linux-x64-gnu` | Ubuntu, x64 | CI (every push) |
| `linux-arm64-gnu` | Ubuntu 24.04, arm64 | — |
| `linux-x64-musl` | Alpine (`node:22-alpine`), x64 | — |
| `linux-arm64-musl` | Alpine (`node:22-alpine`), arm64 | — |
| `win32-x64-msvc` | Windows, x64 | CI (every push) |
| `win32-arm64-msvc` | Windows 11, arm64 | — |

"Loaded on" means the binary loads in Node 22 there and answers a call into the
compiler. A "—" means the whole CLI and test suite haven't run on that target yet. Other
platforms (32-bit Windows, FreeBSD, …) get the [not available](./troubleshooting.md)
error. There is no TypeScript fallback.

**Toolchain.** Node 22 is the only version checked. `create-aruna-app` pins the rest:
- roblox-ts 3.0.0 with TypeScript 5.5.3. `aruna doctor` warns when these two drift
  apart.
- Rojo 7.7.0 and Lune 0.10.0, through `rokit.toml`.

**Roblox Studio:** not yet checked. Every runtime check runs the compiled Luau under
Lune.

## Project shape

A consumer project that uses Aruna looks roughly like this:

```
my-game/
  aruna.config.ts            # defineConfig({...})
  tsconfig.json              # kept correct for you, Next.js-style (aliases, roblox-ts contract)
  default.project.json       # Rojo layout (service-separated)
  src/
    server.ts                # createServerApp + bind
    client.tsx               # createClientApp + call actions
    domains/
      shop/
        actions.ts           # defineAction(...)  (server-classified)
        schema.ts            # schema.object(...) shared types
      grab/                  # the same domain, once it outgrows one file per concern
        model.ts
        schema/              # folder form of schema.ts
          buy.ts
        server/              # domain-private: any number of files
          actions.ts
          runtime.ts
        client/              # domain-private
          controller.ts
    shared/                  # code safe for both sides
    .aruna/                  # GENERATED — do not edit, safe to delete & rebuild
```

Files are classified into `client` / `server` / `shared` by path convention (default
globs: `**/client/**`, `**/server/**`, `**/shared/**`, plus a few well-known entry
filenames). Every file-name convention also covers its folder form — `actions.ts` or
`actions/`, `ui.tsx` or `ui/` — and definitions are found by their `define*` call, not
by file name, so a concern can be split across as many files as you like.

Across domains, a domain's `client/` and `server/` subtrees are private: other domains
import its root modules, or only its `index.ts` once it has one. See
[architecture.md](./architecture.md).

## The build loop

```bash
aruna init     # one-time: scaffold aruna.config.ts and default.project.json, set up tsconfig.json
aruna build    # generate stubs + manifest, vendor the runtime, compile to Luau (rbxtsc)
```

Run `aruna build` again every time you add or change an action or signal. `aruna check`
type-checks and validates boundaries but does **not** regenerate stubs — your client
calls will reference stale contracts if you only `check`. See [cli.md](./cli.md).

You never wire `tsconfig.json` up by hand: like `next dev`, every `aruna build` (and
`dev`, `test`, `init`) checks it first, forces what roblox-ts and Aruna need, adds
defaults only where you left a key unset, and tells you what it changed — comments and
formatting kept. See [tsconfig.json](./cli.md#tsconfigjson).

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
`ReplicatedStorage/ArunaRemoteEvent` that the server-side
`robloxRemoteEvent()` transport creates. That is the whole wire — you never touch a
raw RemoteEvent. Pass `createClientApp({ transport })` to customize it (request ids,
timeouts).

Next: [actions.md](./actions.md), [signals.md](./signals.md), [resources.md](./resources.md), [stores.md](./stores.md), [schema.md](./schema.md), [testing.md](./testing.md), [shared-safety.md](./shared-safety.md), [observability.md](./observability.md).
If something does not build or load: [troubleshooting.md](./troubleshooting.md).
Before going live: [production.md](./production.md).
