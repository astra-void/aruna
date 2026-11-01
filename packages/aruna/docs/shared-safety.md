# Shared safety

A **shared** module (`shared/**`, `schema.ts`, `model.ts`, `signals.ts`, `index.ts`, and
anything else your conventions put there) is replicated and runs on both sides: the
server requires it, and so does every client. Everything it loads at runtime has to load
on both sides too. Aruna checks that in two layers.

## The import boundary (always on)

Each import is checked on its own. A shared module that imports a server module is
`aruna::303 shared-imports-server`; one that imports a client module is
`aruna::302 shared-imports-client`. Client and server have their own rules
(`aruna::300`, `aruna::301`, `aruna::556`, `aruna::574`). These run whatever
`strict.sharedSafety` says.

### Type-only imports never count

An import TypeScript erases never loads its module, so it never crosses a boundary:

```ts
// src/shared/view.ts
import type { ServerSession } from "../server/session"; // erased: fine
import { type ServerSession } from "../server/session"; // erased: fine
import { Session } from "../server/session"; // fine if Session is only used as a type
export type { ServerSession } from "../server/session"; // erased: fine

import { serverSession } from "../server/session"; // read as a value: aruna::303
export { serverSession } from "../server/session"; // re-exports a value: aruna::303
export * from "../server/session"; // may re-export values: aruna::303
import "../server/session"; // runs the module: aruna::303
```

The compiler marks an import type-only when it is `import type` / `export type ... from`
/ `export type * from`, when every specifier is `type`, or when none of its bindings is
read as a value — named only in type annotations, `typeof` queries, `implements`, or an
interface's `extends`. That last rule is how TypeScript (and so roblox-ts) decides what to
elide. `aruna inspect graph --json` shows these edges with `"typeOnly": true`.

The match is by name and errs toward "runtime": a local variable that shadows an imported
name makes the import count as read. That can only produce an extra report, never hide
one. Domain boundaries (`aruna::304`) still apply to type-only imports, because they are
about coupling, not about what loads.

## `strict.sharedSafety` (default `true`)

### What a shared module reaches through other modules

```ts
// src/domains/combat/model.ts (shared)
import { profile } from "../economy/model";
// src/domains/economy/model.ts (shared)
import { store } from "./server/store"; // aruna::303 here
```

`economy/model.ts` gets `aruna::303` for its own import. But `combat/model.ts` loads
`economy/model.ts`, which loads the server store, so `combat/model.ts` cannot load on the
client either:

```
error aruna::306 shared-transitive-server-dependency
src/domains/combat/model.ts is shared, but loading it loads the server module
src/domains/economy/server/store.ts through src/domains/economy/model.ts, so it
cannot load on the client.

dependency chain:
  src/domains/combat/model.ts (shared)
  → src/domains/economy/model.ts (shared)
  → src/domains/economy/server/store.ts (server)

The import to fix is in src/domains/economy/model.ts. Move the runtime dependency
into a server module, import only the type it needs (`import type`), or pass the
value in from a server entry.
```

`aruna::307 shared-transitive-client-dependency` is the same for client code. Every
shared module upstream of the bad edge is reported once per side, with the shortest
chain, pointing at its own import that starts it. Unclassified modules are treated as
shared here, as they are by the boundary rules.

### Server-only services in shared code

```ts
// src/shared/save.ts
const DataStoreService = game.GetService("DataStoreService"); // aruna::308

export function load() {
  return game.GetService("MemoryStoreService"); // aruna::309 (warning)
}

export function guarded() {
  if (RunService.IsServer()) {
    return game.GetService("ServerStorage"); // fine
  }
}
```

The services checked are `DataStoreService`, `MemoryStoreService`, `MessagingService`,
`ServerScriptService`, and `ServerStorage` — each is empty on the client or refuses its
methods there. A service with real client uses (`HttpService` for JSON,
`TeleportService`, `MarketplaceService`) is not on the list. Both
`game.GetService("X")` / `FindService("X")` (on any receiver) and `game.X` are read.

- **`aruna::308 shared-server-service-at-load`** (error): the read runs as the module
  loads — module scope, or a static class field — so it runs on every client.
- **`aruna::309 shared-server-service-access`** (warning): the read is inside a function,
  with no guard. It runs on whichever side calls the function. These count as guards:
  the `if (X.IsServer())` branch, the `else` of `if (X.IsClient())`, `!X.IsClient()`,
  `X.IsServer() && ...`, `X.IsServer() ? ... : ...`, and everything after
  `if (X.IsClient()) return;` (or `throw`) in the same block.

### Turning it off

`strict: { sharedSafety: false }` turns off `aruna::306`–`aruna::309`. Each is also
ignorable on its own through `diagnostics.ignore`, by code or by name
(`"shared-server-service-access"`).

## What a static check cannot see

Passing these checks is evidence that a shared module loads on both sides, not proof. The
compiler reads source without running it, so it does not see:

- **Dynamic loads.** `import("./x")`, `require(...)`, and a `ModuleScript` reached through
  the Instance tree are not followed.
- **Imports it could not resolve**, and anything in a package (`node_modules`,
  `@rbxts/*`). An unresolved relative import is `aruna::105`; it is not analyzed further.
- **A service name it cannot read.** `game.GetService(name)` with a variable, a service
  stored on a table and read elsewhere, or one handed to shared code as an argument.
- **Guards it does not recognize.** A guard stored in a variable
  (`const isServer = RunService.IsServer()`), a helper function, or a check further up the
  call stack still reports `aruna::309`. Ignore it, or move the code.
- **What a guarded branch does.** A guard only silences the access under it; it is not
  checked that the branch is unreachable on the client.
- **Data.** Shared safety is about what code loads where. It says nothing about whether
  a value a shared module exports is safe to show a client; that is what server authority
  (actions, signals, resources) is for.

Server authority is enforced at runtime — input validation, rate limits, and the
server-owned state behind actions — not by these checks.
