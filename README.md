# aruna

Aruna is a compiler-first Roblox framework for server-authoritative games.

The model is intentionally closer to Svelte-style compile-time transforms than to a heavy OOP framework. Classes are allowed. Services are not the framework model. Actions are.

Aruna owns boundaries, actions, generated output, and diagnostics. Users own domain taxonomy.
Aruna complements roblox-ts and TypeScript; it does not replace them.
Its product value comes from compiler-discovered server actions, server-owned [resources](#resources-server-owned-state-clients-observe), an inspectable contract with per-action policy metadata (serialization, rate limits, declared errors), and boundary-aware diagnostics, not from a typed remote wrapper alone.

> **Upgrading?** See [docs/migration-2026-11.md](docs/migration-2026-11.md) for this round's
> changes (resources, shared safety, multi-store, the test network, metrics, incremental
> builds) and what, if anything, to change.

## Recommended Layout v0

This is the recommended project shape for starters, examples, docs, and MVP fixtures:

```text
src/
  client.tsx
  server.ts

  app/
    bootstrap.ts
    providers.ts

  domains/
    shop/
      actions.ts
      schema.ts
      model.ts
      ui.tsx

    inventory/
      actions.ts
      schema.ts
      model.ts
      ui.tsx

    combat/
      model.ts
      runtime.ts

    waves/
      actions.ts
      schema.ts
      model.ts
      runtime.ts

  shared/
    constants.ts
    ids.ts
    result.ts

  .aruna/
    manifest.json
    server/
      actions.server.generated.ts
    shared/
      actions.client.generated.ts
      runtime/           # the vendored native runtime
```

A domain outgrows one file per concern quickly. Every concern also has a folder
form, and a domain can carry its own `client/` and `server/` partitions:

```text
src/
  domains/
    grab/
      model.ts
      schema.ts
      signals.ts

      server/            # domain-private: any number of files
        actions.ts
        runtime.ts

      client/            # domain-private
        controller.ts
        esp.ts
        state.ts

    shop/
      index.ts           # optional barrel: narrows the public surface to this file
      model/             # folder form of model.ts
        item.ts
        receipt.ts
      schema/
        buy.ts
      ui/
        panel.tsx
        shelf.tsx
      store.ts
      server/
        actions.ts

  client/
    main.client.ts
    ui/

  shared/
    i18n/
```

Both shapes are the same layout to the compiler. Actions, signals, stores, and
runtimes are discovered by their definition call, not by file name, so splitting
`actions.ts` into `server/actions.ts` + `server/pickup.ts` needs no config.

Policy notes:

- `src/client.tsx` and `src/server.ts` are the harness runtime entry files.
- The harness source stays spec-shaped; emitted output is partitioned separately for `rbxtsc`.
- `domains/` is a recommended organization pattern, not a boundary kind. It is the
  unit of the domain-to-domain public API boundary — see [Domain boundaries](#domain-boundaries).
- `shared/` is reserved for cross-domain shared-safe code.
- `.aruna/` is generated output and can be deleted and regenerated safely.
- Do not require every client-only or server-only module to use `.client.ts` or `.server.ts`.
- Reserve `.client` and `.server` suffixes for explicit runtime entry hints, not broad folder conventions.

## Configuration

Aruna is still pre-public, so the config surface is being shaped around the intended public API now.
Use `defineConfig()` and the nested config shape directly.

Every section is optional. A project on the Recommended Layout needs no config at all:

```ts
import { defineConfig } from "aruna";

export default defineConfig({});
```

The full surface, with each field set to its default:

```ts
import { defineConfig } from "aruna";

export default defineConfig({
  root: "src",
  compiler: {
    generatedDir: "src/.aruna",
    manifest: "src/.aruna/manifest.json",
    preserveGeneratedComments: true,
  },
  actions: {
    defaultRateLimit: {
      key: "player",
      windowMs: 1000,
      max: 20,
    },
  },
  // Extends the built-in set — list only what the defaults do not cover.
  conventions: {
    shared: ["src/domains/**/policy.ts"],
  },
  // Also extends: `src/domains/*` is always a domain root.
  domains: {
    roots: ["src/features/*"],
  },
  strict: {
    sharedSafety: true,
    rawRemoteUsage: "warning",
    unresolvedImports: "warning",
    domainBoundary: "warning",
  },
  diagnostics: {
    ignore: [],
  },
});
```

- `compiler.generatedDir` controls where generated files are written.
- `compiler.manifest` accepts a manifest path string or `{ output }`.
- `actions.defaultRateLimit` uses `key`, `windowMs`, `max`, and an optional `strategy` (`"fixedWindow"`, the default, or `"tokenBucket"`).
- `conventions.client`, `conventions.server`, `conventions.shared`, and `conventions.test` are arrays of glob strings.
- `domains.roots` are globs matching a domain *directory* (`src/domains/*` matches
  `src/domains/shop`), and `strict.domainBoundary` sets the severity of a
  cross-domain private import.
- `strict` sets how loudly each check reports. The severities are `"off"`, `"warning"`,
  and `"error"`; an error fails `aruna check` and `aruna build`.
  - `strict.unresolvedImports` (default `"warning"`): the severity of `aruna::105
    unresolved-import`, an import Aruna could not resolve. `"off"` stops reporting it.
  - `strict.rawRemoteUsage` (default `"warning"`): the severity of `aruna::507
    raw-remote-usage`, reported for `new Instance("RemoteEvent" | "RemoteFunction" |
    "UnreliableRemoteEvent")` and for any access to `FireServer`, `FireClient`,
    `FireAllClients`, `InvokeServer`, `OnServerEvent`, `OnClientEvent`, or
    `OnServerInvoke`. The check is by name, so a type of your own with a `FireServer`
    member is reported too. Specs and the generated dir (the vendored runtime included)
    are never checked.
  - `strict.domainBoundary` (default `"warning"`): the severity of `aruna::304
    cross-domain-private-import`. See [Domain boundaries](#domain-boundaries).
  - `strict.unboundedInput` (default `"warning"`): the severity of `aruna::514
    unbounded-action-input`, an action input with a string, array, or record that has no
    upper bound. See [Bounding input](packages/aruna/docs/actions.md#bounding-input).
  - `strict.sharedSafety` (default `true`): what a shared module may reach at runtime,
    beyond its own imports (which `aruna::302`/`aruna::303` check either way). A shared
    module that loads server or client code through other shared modules is
    `aruna::306`/`aruna::307`, with the dependency chain; a server-only service
    (`DataStoreService`, `ServerStorage`, ...) read from shared code is `aruna::308` at
    module load and `aruna::309` (a warning) inside a function with no
    `RunService.IsServer()` guard. Type-only imports are erased from the Luau and never
    count. `false` turns these four off. See
    [shared safety](packages/aruna/docs/shared-safety.md), including what a static check
    cannot see.
- `diagnostics.ignore` lists diagnostic codes (`"aruna::507"`) or names
  (`"raw-remote-usage"`) to drop from every report, project-wide.
- The legacy flat `generatedDir` / `manifest.output` config shape is no longer supported.
- `domains/` remains recommended, not required.

### Conventions

The built-in set is the Recommended Layout:

| kind | globs |
| --- | --- |
| client | `**/client/**`, `**/ui.tsx` |
| server | `**/server/**`, `**/actions.ts`, `**/runtime.ts` |
| shared | `**/shared/**`, `<root>/app/**`, `**/schema.ts`, `**/model.ts`, `**/signals.ts`, `**/index.ts` |
| test | `**/*.test.ts(x)`, `**/*.spec.ts(x)` |

- Your globs **extend** this set rather than replacing it, so adding one pattern
  costs one line. `conventions: { defaults: false, ... }` opts out and makes your
  globs the whole set.
- Your globs also **outrank** the built-ins: when both match a file, yours decides.
  A default can therefore never reclassify a path you pinned by hand.
- Every file-name glob also covers its **folder form**: `**/actions.ts` classifies
  `**/actions/**`, `**/ui.tsx` classifies `**/ui/**`, and your own
  `src/domains/**/policy.ts` classifies `src/domains/**/policy/**`. Splitting a
  concern into a folder is never a config change.
- Matches are ranked in three tiers — directory glob (`**/server/**`), then the
  derived concern folder (`**/actions/**`), then file name (`**/actions.ts`) — and
  the highest tier that matches decides. So `src/server/model.ts` stays server,
  `src/shared/actions/util.ts` stays shared, and `domains/shop/ui/schema.ts` is
  client UI rather than a shared schema. Only a cross-kind tie *within* one tier
  is ambiguous (`aruna::203`).
- `**/signals.ts` is shared for a structural reason: the generated signal registry
  lives in the shared partition and imports every definition from the file that
  declared it, so a signal declared in a server-classified file cannot resolve on
  the client.
- `**/index.ts` is shared because a barrel is a surface other modules import
  through — a domain's `index.ts` is exactly its cross-domain public API. A barrel
  inside a partition folder keeps that folder's kind.
- **Test conventions are applied before the other three**, not alongside them: a
  spec sits next to the code it exercises, so `src/domains/shop/server/pricing.test.ts`
  matches `**/server/**` too and would otherwise be an ambiguous match
  (`aruna::203`) instead of the test it plainly is. A spec may import client,
  server, and shared modules alike; nothing may import a spec (`aruna::305`),
  because the game build never compiles one.

### Domain boundaries

Client/server/shared is one axis; domain-to-domain is the other. A **domain** is
one directory below `domains/` (`domains.roots` adds more), and its public API is:

| the domain has | other domains may import |
| --- | --- |
| no `index.ts` | every module at the domain root and its concern folders — `model.ts`, `schema/`, `store.ts`, ... |
| `index.ts` | that file, and nothing else |

A domain's `client/` and `server/` subtrees are always private. Reaching past the
public surface reports `aruna::304 cross-domain-private-import`:

```text
warning aruna::304 cross-domain-private-import
  src/domains/shop/server/actions.ts imports src/domains/inventory/server/ledger.ts,
  which is private to the inventory domain.
```

- Only domain-to-domain edges are checked. App-shell code (`src/client/**`,
  `<root>/app/**`, the entry files) legitimately boots a domain's own client and
  server modules, and imports inside one domain are never restricted.
- `strict.domainBoundary` is `"warning"` by default; `"error"` makes it a build
  failure, `"off"` disables the rule.
- Adding an `index.ts` to a domain is the opt-in to the strict form: the barrel
  becomes the only thing other domains can see.

## Quickstart flow

1. Config:

   ```ts
   import { defineConfig } from "aruna";

   export default defineConfig({
     actions: {
       defaultRateLimit: {
         key: "player",
         windowMs: 1000,
         max: 20,
       },
     },
   });
   ```

2. Action:

   ```ts
   import { defineAction } from "aruna/roblox"; // ctx.player typed Player; aruna/server defaults it to unknown
   import { schema } from "aruna/schema";

   export const purchaseItem = defineAction({
     id: "shop.purchaseItem",
     rateLimit: { key: "player", windowMs: 1000, max: 5 },
     input: schema.object({ itemId: schema.string() }),
     output: schema.object({ ok: schema.boolean() }),
     run(ctx, input) {
       return { ok: true };
     },
   });
   ```

3. Generated imports:

   ```ts
   import { purchaseItem } from "$aruna/actions/client";
   import { actions } from "$aruna/actions/server";
   ```

4. Commands:

   ```bash
   aruna build    # sets up tsconfig.json, then generates the stubs and compiles to Luau
   aruna check
   aruna inspect actions
   aruna inspect contract --json
   aruna contract diff --project apps/rbxts-harness --baseline contract.snapshot.json
   ```

## Phase 1 scope

- Phase 1.1 is release engineering and hardening, not new framework features.
- project config loading from `aruna.config.ts`
- Rust-owned compiler core in `crates/aruna_compiler` and N-API binding in `crates/aruna_napi`
- TypeScript CLI and package wrappers
- source discovery, entry classification, module classification, import graph construction, action discovery, boundary validation, diagnostics, and manifest generation in Rust
- OXC-based TS/TSX import parsing in the Rust core (replaces the earlier SWC parser path)
- deterministic compiler output
- `aruna check` (also flags layout desync: tsconfig aliases pointing at a path the current layout does not emit, or a tsconfig still extending the retired generated fragment, `aruna::111`)
- `aruna inspect`
- running `aruna` with no subcommand aliases to `aruna check`
- `aruna build` prunes artifacts a previous build emitted and this one does not (tracked in `.aruna-build.json`, confined to `generatedDir`)
- fixture-based tests without Roblox Studio
- `packages/compiler` loads the Rust native compiler
- no TypeScript analyzer fallback

## Native compiler preflight

Phase 1 requires the Rust native compiler. Build it before running the CLI or the test suite:

```bash
pnpm build:native
```

Phase 1 prepares native packages through generated `.npm/` staging directories.

Raw Cargo artifacts are written under `target/**` and may be named `libaruna_napi.dylib`, `libaruna_napi.so`, `aruna_napi.dll`, or `aruna_napi.node` depending on platform and profile.

`pnpm build:native` builds and stages the current host native package only. It always produces `.npm/compiler-<target>/compiler.<target>.node` and `.npm/compiler-<target>/package.json` when the Rust build succeeds. If `packages/compiler/dist` is missing, wrapper staging is skipped with a clear message instead of failing the native build.

`pnpm --filter @arunajs/compiler verify:native` checks the staged native package for the current host target and fails if the `.npm/compiler-<target>/` artifact is missing or malformed.

The wrapper package under `.npm/compiler/` is reserved for release packaging or for runs after the TypeScript build has produced `packages/compiler/dist`.

`pnpm release:prepare` is the release orchestrator entrypoint:

```bash
pnpm release:prepare --mode local
pnpm release:pack --mode local
pnpm release:publish --mode local --dry-run

pnpm release:prepare --mode cross --targets linux-x64-gnu --zig auto
pnpm release:prepare --mode cross --targets linux-x64-gnu --zig always
pnpm release:prepare --mode cross --targets linux-x64-gnu --zig never
pnpm release:prepare --mode cross --targets linux-x64-gnu --allow-missing-tools

pnpm release:pack --mode cross --targets linux-x64-gnu --zig auto
```

Local mode builds the current host target only and uses `cargo` by default. Cross mode evaluates each requested target independently:

- `--zig auto` uses `cargo` for the host target and `cargo zigbuild` for Linux cross targets when `cargo-zigbuild` and `zig` are available.
- `--zig always` requires `cargo-zigbuild` for Linux cross targets.
- `--zig never` never calls `cargo zigbuild` and fails for targets that need it.
- Missing `cargo-zigbuild` or `zig` fails by default.
- `--allow-missing-tools` skips requested cross targets when the required tools are unavailable.

Skipped targets are not staged, are not added to `.npm/compiler/package.json` `optionalDependencies`, and never produce fake platform packages.

Full mode is reserved for CI/public release validation and builds every target that the current host can actually stage with the selected tools.
Unsupported cross targets are not faked or substituted.

Staged native artifacts use target-qualified names such as `compiler.darwin-arm64.node` and are copied from the real Rust output only.

Packages are staged under `.npm/`, then packed and published from `.npm/` rather than `packages/*`.
The generated `.npm/` output is ignored by git and can be regenerated at any time.

Aruna never fakes platform support by renaming a binary built for another target or by staging placeholder packages for skipped targets.

Packaging automation is TypeScript-based and executed with `tsx`.

Common CLI checks:

```bash
pnpm aruna check --project fixtures/valid-client-imports-shared/input
pnpm aruna check --project fixtures/invalid-client-imports-server/input
pnpm aruna inspect actions --project fixtures/action-rate-limit/input
pnpm aruna inspect actions --project fixtures/action-rate-limit/input --json
pnpm aruna inspect contract --project fixtures/action-rate-limit/input --json
pnpm aruna contract diff --project fixtures/action-rate-limit/input --baseline fixtures/action-rate-limit/expected/contract.snapshot.json
pnpm aruna inspect modules --project fixtures/feature-local-layout/input
pnpm aruna inspect graph --project fixtures/invalid-client-imports-server/input
pnpm aruna check --json --project fixtures/invalid-client-imports-server/input
pnpm aruna check --no-color --project fixtures/invalid-client-imports-server/input
pnpm aruna build --project fixtures/action-generated-output/input
pnpm aruna doctor --project apps/rbxts-harness
pnpm aruna doctor --fix --project apps/rbxts-harness
```

`packages/compiler` loads the native Rust compiler directly. There is no TypeScript analyzer fallback in Phase 1.

Future Linux cross-compiles use real `cargo zigbuild --target x86_64-unknown-linux-gnu`, `cargo zigbuild --target aarch64-unknown-linux-gnu`, `cargo zigbuild --target x86_64-unknown-linux-musl`, and `cargo zigbuild --target aarch64-unknown-linux-musl` builds instead of staged fake packages.

## Generated action foundation

- server action discovery exists in Rust
- action manifest records now include basic schema metadata when `input` or `output` is declared
- `aruna inspect actions` lists client-callable actions, input/output schema summaries, serialization policy metadata, rate-limit metadata, whether the action is `idempotent`, the errors it declares, and basic authority notes
- `aruna inspect contract` emits a deterministic JSON snapshot of the contract surface: actions (ids, source paths, generated export names, schema metadata and summaries, serialization policy, rate limits, `idempotent`, declared errors, authority notes, and warnings), signals, and stores
- `aruna contract diff` compares two contract snapshots, or a snapshot file against the current project (with no arguments, the committed `aruna.contract.json`), and reports breaking, warning, non-breaking, and info-level changes
- `aruna contract update` writes the committed snapshot (refusing a store change saved records cannot survive; `--check` for CI); while one exists, `aruna check` and `aruna build` fail on a store change that saved records cannot survive (`aruna::578`)
- generated action files are snapshot-tested in the fixture suite
- application code should import generated actions through `$aruna/actions/client` and `$aruna/actions/server`
- `aruna build` writes deterministic `src/.aruna/shared/actions.client.generated.ts` and `src/.aruna/server/actions.server.generated.ts`
- generated client stubs are typed from schema metadata where the metadata is supported
- generated client stubs now connect to a minimal action runtime contract
- `createServerApp(...).dispatch` is the in-process action path for tests (the `aruna/testing` harness wraps it)
- thin client/server app bootstrap helpers at `aruna/client` and `aruna/server` wire the runtime invoker and server action registry
- the bootstrap helpers are functional, disposable, and intentionally do not scan modules or register services
- Roblox-facing default action remote helpers bind to the flat `ReplicatedStorage/ArunaRemoteEvent` (matching the native runtime; the RemoteFunction transport was removed — the RemoteEvent request/response transport is the transport)
- there is one runtime: the roblox-ts-native one at `packages/aruna/roblox/`, which games compile from their vendored copy; `packages/aruna/src` is the CLI and the root `aruna` entry
- the runtime subpaths are type-only: each ships the native runtime's declarations, so a project sees the same types with or without the doctor aliases
- `@rbxts/types` and `@rbxts/compiler-types` are used at typecheck time for Roblox-facing runtime types
- runtime schema validation now runs on action input and output at dispatch time
- runtime serialization policy now runs on action input and output at dispatch time using the default `plain-data-v1` boundary
- action input/output rejects function, class-instance, cyclic, non-finite (NaN, ±inf, also inside Roblox value types), and other non-plain values; an `Instance` (a `Player` included) is accepted only where the schema declares `schema.instance()`, so an action without an input schema rejects one
- client input is checked for wire safety before anything else reads it, and the walk stops at 2048 values as well as at depth 32
- action rate limiting runs per action and player/key before `run()`, as a fixed window (the default) or a token bucket (`strategy: "tokenBucket"`)
- invalid input and serialization failures do not consume per-action quota; every envelope is charged to a per-player request budget (60 burst, 30 per second) before it is read, and given back once the action's own rate limit admits it, so the budget prices the work that leads nowhere and calls to an action with no rate limit; a player's wire dispatches in flight are capped (32; in-process `app.dispatch` is exempt), a call to an unknown action is dropped unanswered, and `onAbuse` reports each refusal with a per-player count, so malformed payloads are not free
- the default client retry retries a timeout only for an action declared `idempotent: true`, and every attempt of a call carries one idempotency key, so the server runs it once
- an action declares the failures a client can tell apart in `errors` and throws them with `ctx.fail(name, data)`; the server checks the data against the declared schema (a mismatch is masked as an internal error), the contract records them, and the generated client stub is typed with them so `isActionError(err, stub, name)` narrows `err.data` (see [docs/actions.md](packages/aruna/docs/actions.md#declared-errors))
- manifest action records now include serialization policy metadata and optional `rateLimit` metadata
- the contract snapshot foundation is implemented through `aruna inspect contract`; `aruna contract diff` is the compatibility gate for contract snapshots, and the committed snapshot gates stores in `check` and `build`
- the schema helpers cover strings, numbers (with `u8`..`i32`/`f32` width hints), booleans, literals, arrays, objects, optionals, records, tuples, enums, unions, discriminated unions, `.default(...)`, constraint chains and `refine`, and the Roblox value types (`vector3`, `vector2`, `color3`, `cframe`, `udim`, `udim2`, `dateTime`, `brickColor`, `instance`); see [docs/schema.md](packages/aruna/docs/schema.md)
- the schema DSL has TypeScript inference for all of them
- the generated files are safe to delete and regenerate
- structural runtime remoting exists only as a foundation; default Roblox action remote binding exists; this is not production Studio validation

## Signals (server → client push)

`defineSignal` is the push counterpart to `defineAction`. An action is a client → server request/response; a signal is a server → client message that clients subscribe to. A signal declares an `id` and an optional `payload` schema — there is no `run` and no response.

```ts
import { defineSignal } from "aruna/server";
import { schema } from "aruna/schema";

export const damaged = defineSignal({
  id: "combat.damaged",
  payload: schema.object({ amount: schema.number(), source: schema.string() }),
});
```

Server — publish to one player, several players, or everyone via the turnkey publisher
(it ensures the default `ReplicatedStorage/ArunaRemoteEvent` at call time):

```ts
import { createSignalPublisher } from "aruna/roblox";

const signals = { "combat.damaged": damaged };
const publisher = createSignalPublisher(signals);

publisher.to(player, "combat.damaged", { amount: 12, source: "trap" });
publisher.toMany(players, "combat.damaged", { amount: 5, source: "fall" });
publisher.toAll("combat.damaged", { amount: 3, source: "lava" });
```

Client — subscribe with `.on()`; it returns a disconnectable handle:

```ts
import { createSignalSubscriber } from "aruna/roblox";

const subscriber = createSignalSubscriber(signals);

const connection = subscriber.on("combat.damaged", (payload) => {
  updateHud(payload);
});
connection.disconnect();
```

- Payloads are validated against the `plain-data-v1` serialization boundary and the declared schema on publish (the server throws on a violation) and dropped on schema mismatch on delivery (the client never invokes a handler with a malformed payload).
- Both runtimes ship turnkey default-transport helpers `createSignalPublisher(signals)` / `createSignalSubscriber(signals)` over the same RemoteEvent as actions: responses and reliable signals for a player travel one ordered channel, so a signal published inside an action reaches the client before that action's response. They ensure / wait for the remote on call, so no hand-written boot-order plumbing is needed; `createServerApp({ signals, createPublisher })` can own the publisher so the remote is created at boot.
- An app-owned publisher is injected into every action's `ctx`, so an action's `run` can publish signals directly (`ctx.publisher?.toAll(...)`). Bind a `defineAction` with `createActionDefiner<Signals, Player>()` for a non-optional, registry-checked `ctx.publisher` — no plumbing module. See [docs/signals.md](packages/aruna/docs/signals.md#publishing-from-inside-an-action).
- Signals are compiler-discovered: `defineSignal` exports are recorded in the manifest (`manifest.signals`), listed by `aruna inspect signals`, and included in the contract snapshot from `aruna inspect contract`. Contract `diff` gates signal changes too: a removed signal or a removed/retyped payload field is breaking, an added signal or payload field is non-breaking (output compatibility rules — payloads travel server → client).
- `wire: "binary"` sends a signal's payload as an `encodeBinary` frame (see [Binary serialization](#binary-serialization)). The compiler records the largest encoding a payload allows (`maxEncodedBytes`) and checks unreliable signals against Roblox's 900-byte limit: an unbounded payload warns (`aruna::510`), one that can exceed it fails the build (`aruna::511`).

## Resources (server-owned state clients observe)

A **resource** replaces the snapshot action + update signal + merge handler every
server-authoritative game writes per piece of displayed state. The server declares how it
reads the state and says when it changed; every subscribed client converges on the newest
value, and never ends up on an older one than it already had.

```ts
// src/domains/quests/resources.ts (server code)
export const questProgress = defineResource({
  id: "quests.progress",
  schema: questProgressSchema,
  load: (ctx) => quests.snapshot(ctx.player.UserId),
});

// server: createServerApp({ actions, resources, transport: robloxRemoteEvent() })
// in an action, after changing the state:
ctx.resources?.invalidate(questProgress);

// client: createClientApp({ resources: true })
import { questProgress } from "$aruna/resources/client";
questProgress.subscribe((value) => updateQuestUI(value));
```

- Snapshots carry a per-server revision taken when their load starts; neither end goes
  backwards, so a slow snapshot can never overwrite a newer push. The subscription is
  registered before the first snapshot is loaded, so no change in between is missed.
- `scope: "player"` (default) loads per player and only ever sends a player their own
  value — the client sends a resource id and nothing else. `scope: "global"` loads once
  per change for everyone. `authorize: (ctx) => boolean` refuses a subscription.
- An invalidation inside an action with a synchronous `load` arrives before the action's
  response. Bursts are coalesced to one load in flight and one snapshot per frame.
- Compiler-discovered (`aruna::586`–`590`), listed by `aruna inspect resources`, in the
  contract snapshot, hash, and `contract diff`. Generated: `$aruna/resources/server` and
  `$aruna/resources/client`.

See [docs/resources.md](packages/aruna/docs/resources.md) and the protocol in
[docs/rfcs/resources.md](docs/rfcs/resources.md).

## UI bindings (`aruna/ui`)

Resources and actions in a component, for `@rbxts/react` and Vide. The renderer is
passed in, because Aruna never imports one:

```ts
// React
export const { useResource, useAction } = createReactBindings(React);
// Vide
export const { resourceState, actionState } = createVideBindings({ source, cleanup, batch });
```

- `useResource(questProgress)` / `resourceState(questProgress)` read a resource's value,
  status, and error. Every reader shares one subscription, kept across a screen swap.
- `useAction(purchaseItem, { exclusive: true })` / `actionState(...)` give a call's
  pending, success, and error state. The latest call wins; a component that goes away
  writes nothing and cancels nothing.
- `optimistic(input, update)` on `useAction` / `actionState` (or `invokeOptimistic` from
  `aruna/client`) shows what a call will do until the server's snapshot contains it. The
  update leaves in the step that applies that snapshot, so the old value never flashes
  back and nothing applies twice.
- Generated stubs take per-call options: `purchaseItem(input, { idempotencyKey })`.

See [docs/ui.md](packages/aruna/docs/ui.md) and the RFC in
[docs/rfcs/ui-bindings.md](docs/rfcs/ui-bindings.md).

## Stores (DataStore persistence)

A **store** is Aruna's safe front end to `DataStoreService`: declare the record shape once,
and the runtime owns validation, retries, request budget, versioning, and — for player save
files — the session lock. Stores are server-only and have no client binding; a client that
imports one is `aruna::574`.

```ts
import { definePlayerStore, createPlayerStore, createServerApp } from "aruna/server";
import { robloxDataStore, robloxRemoteEvent } from "aruna/roblox";
import { schema } from "aruna/schema";

export const profile = definePlayerStore({
  id: "player.profile",
  version: 2,
  schema: schema.object({ coins: schema.u32() }),
  defaultValue: () => ({ coins: 0 }),
  migrate: (stored, fromVersion) => (fromVersion === 1 ? upgradeFromV1(stored) : undefined),
});

const profiles = createPlayerStore(profile, { createBackend: robloxDataStore() });

const app = createServerApp({ actions, transport: robloxRemoteEvent(), playerStore: profiles });
```

- **Nothing throws.** Every operation resolves with a `StoreResult<T>` carrying a typed
  `StoreError` (`StoreUnavailableError`, `StoreThrottledError`, `StoreValidationError`,
  `StoreLockedError`, ...) and whether a retry could plausibly succeed.
- **No blind overwrite.** A read that fails — request error, corrupt payload, schema
  mismatch, failed migration — yields an error, never a value. Only a genuinely absent key
  resolves to `defaultValue`, so a failed load can never be saved over a real record.
- **Bounded retries and budget awareness.** Transient failures retry with capped
  exponential backoff and jitter; a missing API grant is not retried at all; an exhausted
  `GetRequestBudgetForRequestType` waits instead of spending the request.
- **Session locking.** A player store claims its lock inside the same `UpdateAsync` that
  reads the record. A live lock held elsewhere refuses the load; a stale one (heartbeat
  older than `lockTtlMs`) is taken over; a server that lost its lock refuses to write. The
  heartbeat doubles as the autosave, and `createServerApp` flushes everything on
  `BindToClose`.
- **Versioned payloads.** Every write carries a version, so an older record is handed to
  `migrate` rather than silently reinterpreted. A record from a *newer* version — an old
  server still running after an update — is refused (`StoreVersionAheadError`), never
  migrated or written back.
- **Compatibility gate.** With a committed contract snapshot, `aruna check` / `aruna build`
  fail on a store change that records already saved cannot survive: a new required field
  without `.default()`, a narrowed type, a version bump without `migrate`.
- **App-owned lifecycle.** `createServerApp({ playerStore })` loads on join, releases on
  leave, and injects the open document into every action as `ctx.store` — optional by
  design, because a document that has not loaded must not be replaced by a default.
- **Compiler-discovered.** `defineStore` / `definePlayerStore` exports are recorded in the
  manifest (`manifest.stores`), classified as `serverStore` modules, and listed by
  `aruna inspect stores`.

See [docs/stores.md](packages/aruna/docs/stores.md).

## Testing (`aruna test`)

Specs are TypeScript, live next to the code they exercise, and run against the runtime
that ships. `aruna test` compiles the project *with* its specs and runs them under
[Lune](https://lune-org.github.io) — a Node test runner would exercise a different
runtime than the game does, which is the class of bug a test is meant to catch.

```ts
import { createTestPlayer, createTestServerApp, describe, expect, it } from "aruna/testing";
import { purchaseItem } from "./actions";

describe("shop.purchaseItem", () => {
  it("prices the order", async () => {
    const harness = createTestServerApp({ actions: { "shop.purchaseItem": purchaseItem } });
    const output = await harness.invoke(createTestPlayer(), "shop.purchaseItem", {
      itemId: "sword",
      quantity: 2,
      currency: "coins",
    });

    expect(output.total).toBe(100);
    harness.dispose();
  });
});
```

- **The real dispatch path.** `harness.invoke` goes through input validation, rate
  limiting, middleware, sessions, and output validation — no RemoteEvent, Players
  service, or DataStore required. The signal publisher is the shipping one over a
  recording remote, so `harness.published()` records what the wire would have carried and
  an invalid payload fails in the spec exactly as it would in production.
- **The whole lifecycle.** `harness.join(player)` / `leave(player)` create and drop
  sessions, fire `onPlayerAdded` / `onPlayerRemoving`, and load and release an owned
  player store. `harness.client(player)` gives a client app wired to this server, so a
  spec can exercise a generated client stub and the signal that comes back.
- **Specs never reach the place.** They are classified `test` wherever they live, the
  game build never stages them (nor the test framework), and an action defined inside a
  spec is a fixture: it does not enter the manifest, the generated registry, or the
  contract. Game code importing a spec is `aruna::305`.
- **The framework ships with it.** `describe` / `it` / `beforeEach` / `afterEach` /
  `expect` come from `aruna/testing`, because under Lune there is no host runner to
  supply them.

Lune is not an npm package — install it with `rokit add lune-org/lune`.
See [docs/testing.md](packages/aruna/docs/testing.md).

## Domain runtimes (server work that starts at boot)

Actions are pull: a client asks, the server answers. A domain's `runtime.ts` is
push — a heartbeat, a `PlayerAdded` connection, a round loop. Aruna classified
those files as server-only but never started them, so projects hand-wrote a
bootstrap Script listing every `start*()` in a carefully chosen order.

`defineRuntime` makes that a declaration, and the boot order an input to the
build rather than a comment:

```ts
// src/domains/score/runtime.ts
export const scoreRuntime = defineRuntime({
  id: "score",
  start() {
    Players.PlayerAdded.Connect(createStatsFolder);
  },
});

// src/domains/emote/runtime.ts
export const emoteRuntime = defineRuntime({
  id: "emote",
  // Registers carry hooks on the grab runtime, so it has to exist first.
  after: ["grab"],
  start() { ... },
});
```

- **The order is resolved, not written.** `after` edges are topologically sorted
  (ties broken by id, so the emitted sequence is stable), and the result is
  recorded in `manifest.runtimes` and emitted into the generated server entry.
- **Bad order is a build error, not a Studio surprise.** An `after` naming no
  runtime, a self-edge and a cycle are all `aruna::582`; a duplicate id is
  `aruna::581`; a runtime with no `start` is `aruna::580`. `aruna check` reports
  them without writing anything.
- **No boot race.** The starts run inside the generated entry, after the app is
  constructed — a hand-written bootstrap Script raced it, because Roblox does not
  order Scripts against each other.
- **`id` and every `after` entry must be static string literals**, like action and
  signal ids: the build resolves the order without executing your code.

Requires `entries: "generated"` — the generated server entry is what runs them.

## Binary serialization

`encodeBinary` / `decodeBinary` pack a schema-conforming value into a tightly packed Luau `buffer`, using the schema as the layout. Because both sides share the schema, no field names or type tags travel on the wire — only a 4-byte frame header plus the payload bytes. The header is a u32 **schema fingerprint** (`schemaFingerprint(schema)`): decoding is positional, so a peer holding a different schema version would silently mis-read the bytes — the fingerprint check turns that into an immediate typed error instead.

```ts
import { decodeBinary, encodeBinary, schema } from "aruna/schema";

const hit = schema.object({ amount: schema.number(), source: schema.string() });

const bytes = encodeBinary(hit, { amount: 12, source: "trap" });
const value = decodeBinary(hit, bytes); // { amount: 12, source: "trap" }
```

- The codec runs in-game, from `aruna/schema`. (It used to be exported from the root `aruna` entry as a Node implementation over `Uint8Array`; that was removed with the Node runtime.)
- Layout: frame = u32 schema fingerprint + payload; string = u32 length + UTF-8; number = the declared numeric width; boolean = u8; literal = 0 bytes; array = u32 count + items; object = fields in sorted key order; optional = u8 present flag + inner; enum = u32 index; union = u32 member index + member.
- **Numeric width hints** pick a packed encoding per number. `schema.number()` is a full-width `f64`; `schema.f32()`, `schema.u8()`, `schema.u16()`, `schema.u32()`, `schema.i8()`, `schema.i16()`, and `schema.i32()` pack to their declared byte width and (for integer formats) validate the value is a whole number in range. A `{ hp: u16, team: u8 }` element costs 3 payload bytes instead of 16. Widths flow through the compiler into action/signal schema metadata (`numericFormat`) and the contract summary.

  ```ts
  const hit = schema.object({ amount: schema.u16(), crit: schema.boolean() });
  buffer.len(encodeBinary(hit, { amount: 1200, crit: true })); // 7 bytes (4-byte frame header + 3 payload bytes)
  ```

- Encoding assumes the value already matches the schema (the action and signal boundaries validate first); a mismatch throws rather than emitting a corrupt buffer.
- Signals use it on the wire with `defineSignal({ wire: "binary" })`: the publisher sends the frame, the subscriber decodes it, and a frame with another schema's fingerprint is dropped like a schema mismatch. See [docs/signals.md](packages/aruna/docs/signals.md#binary-wire).

## Spec Cutline

Serialization boundary, fixed-window rate limits, the pre-dispatch request budget, the contract snapshot, contract diff (with the store compatibility gate), and package-consumption validation are all implemented. The binary signal wire puts the existing codec on the existing signal transport rather than adding a transport. The cutline stays on stabilization, not new transports or a policy/capability system:

1. Stabilize current compiler, action, runtime, and package-consumption behavior. (Ongoing.)
2. Done: runtime execution tests for the roblox-ts-native runtime. CI compiles it and runs it under Lune (`apps/roblox-runtime-test`): hand-written Luau specs, the dispatch conformance table (`apps/roblox-runtime-test/conformance/`), and TypeScript specs run through the same runner `aruna test` ships.
3. Refine thin authority inspection without adding a full policy/capability system.
4. Done: the starter contract. `create-aruna-app` scaffolds the starter (since 0.2.0); [docs/create-app-plan.md](docs/create-app-plan.md) is its plan.
5. Done: resources and invalidation ([docs/rfcs/resources.md](docs/rfcs/resources.md)).

## Package consumption validation

`apps/package-consumption-harness` simulates a project outside the monorepo source layout consuming Aruna as a package.
It imports `defineConfig` from the root package for config only, and uses the runtime-safe public subpaths `aruna/server`, `aruna/client`, `aruna/roblox`, and `aruna/schema` for Roblox-facing code.
It validates `aruna doctor --fix`, `aruna check`, `aruna build`, `aruna inspect actions`, `aruna inspect contract --json`, and `aruna contract diff` against that package-style layout.
It is not `create-aruna-app` output.

Package consumption uses a vendored-runtime model rather than direct `node_modules` imports of Roblox-facing code:

- The roblox-ts-native runtime lives at `packages/aruna/roblox/` and ships in the package via `files`; its declarations (`dist/native/`) are what the `aruna/*` subpaths resolve to.
- `aruna build` vendors that native runtime into the consumer as project source under `src/.aruna/shared/runtime/`.
- `aruna build` (like `aruna doctor --fix`) writes the `aruna/*` → vendored-runtime tsconfig path aliases into `tsconfig.json`.
- `default.project.json` maps the full `out` tree, so `rbxtsc` compiles the whole consumer — including the vendored runtime — to Luau without the "modules directly under node_modules" rejection.

`pnpm verify:package-consumption` builds local tarballs and installs the packed Aruna dependency graph without contacting the npm registry for `aruna`, `@arunajs/core`, or `@arunajs/compiler`.
The packed package-style tarball smoke runs `doctor --fix` and `build`, generates `src/.aruna` action files and the vendored runtime, passes TypeScript, and compiles to Luau with `rbxtsc`. This is package-layout and rbxtsc compile validation, not production Studio validation.

See [docs/package-consumption.md](docs/package-consumption.md) for the final package-consumption model and remaining follow-ups.

Do not move to `defineResource` until the Spec Cutline above is done.

### Generated action imports

Application code should import generated action APIs through Aruna virtual modules:

```ts
import { purchaseItem } from "$aruna/actions/client";
import { actions } from "$aruna/actions/server";
```

Do not import the physical `../.aruna/*.generated` files directly in app code.
Aruna owns the physical files under `src/.aruna/`.
`aruna check` resolves these virtual modules without writing files.
`aruna build` writes the physical generated files used by TypeScript and roblox-ts tooling,
and the tsconfig path aliases that point at them (see below).

### Generated project wiring

Anything that must stay in step with codegen or with what is installed is kept in step
by Aruna, rather than copied into a file you then have to maintain.

`tsconfig.json` is maintained the way Next.js maintains it: `aruna init`, `aruna build`,
`aruna dev`, and `aruna test` read it before compiling, force what roblox-ts and Aruna
cannot work without (the `target`/`module`/`noLib` contract, the `@rbxts` type root,
every `$aruna/*` and `aruna/*` path alias, the include that reaches the dot-prefixed
generated dir), add sensible defaults only where a key is unset, and print what they
changed. The edit is in place — comments, formatting, and every other key survive — and
the aliases are written relative to the file, with no `baseUrl`:

```jsonc
{
  "compilerOptions": {
    // your choices stay yours: a JSX runtime, rbxtsc transformers, your own aliases
    "jsx": "react",
    "jsxFactory": "Vide.jsx",
    // ...the roblox-ts contract...
    "paths": {
      "$aruna/actions/client": ["./src/.aruna/shared/actions.client.generated.ts"],
      "aruna/server": ["./src/.aruna/shared/runtime/server.ts"],
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "src/.aruna/**/*.ts"]
}
```

Because the file is complete on its own, a fresh clone typechecks in the editor before
anything has been generated. See [tsconfig.json](packages/aruna/docs/cli.md#tsconfigjson).

`<generatedDir>/node_modules.project.json` is a nested Rojo project holding the
npm scopes that ship Luau, rebuilt from `node_modules/` on every `aruna build`.
`default.project.json` mounts it once:

```json
"rbxts_include": {
  "$path": "include",
  "node_modules": { "$path": "src/.aruna/node_modules.project.json" }
}
```

Adding a Roblox-facing dependency then needs no Rojo edit at all. Build-time-only
packages (bundlers, theme generators, `@types/*`, `@rbxts/types`) ship no Luau
and are left out: a scope whose packages all ship Luau is mounted wholesale, and
a mixed scope is mounted per qualifying package so the rest never reach the
DataModel. Per-package mounts are named the way Rojo names a scope mount — from
each package's own project file, so `@lattice-ui/react-dialog` stays `dialog`.
A project that keeps its own hand-written mounts still works — `aruna doctor`
reports any installed scope it never mounts, which is otherwise a silent failure:
every build step exits 0 and the require fails at runtime.

## Real app harness

`apps/rbxts-harness` is a private roblox-ts-style app harness.
It intentionally mirrors Recommended Layout v0 closely enough to act as the realistic app/starter reference while still remaining a harness rather than create-app output.
Its whole build is a single turnkey command — `"build": "aruna build"` — exactly as a real consumer would run it: the bare `aruna build` generates the action (and signal) stubs, vendors the Roblox runtime into `src/.aruna/shared/runtime/`, partitions the project by module classification, and drives `rbxtsc` to compile to Luau. There is no separate typecheck/rbxtsc/layout step.
The source consumes Aruna through the vendored runtime via subpath imports (`aruna/server`, `aruna/schema`, `$aruna/actions/*`, `$aruna/signals`).
Because the source uses the `domains/` recommended layout (classification is by convention, not by physical folders), `aruna build` stages the source into `out/client`, `out/server`, and `out/shared` and `default.project.json` maps each onto the Roblox DataModel — server code into `ServerScriptService` (never replicated to clients), client into `StarterPlayerScripts`, shared (plus the vendored runtime and client-callable stubs) into `ReplicatedStorage`.
The harness covers generated action files, app bootstrap, schema inference (including optional fields), domain-local UI files, and public Aruna runtime imports.
The runtime entries live under `src/client.tsx` and `src/server.ts`; `src/app/bootstrap.ts` and `src/app/providers.ts` stay shared-safe app composition helpers rather than hidden runtime entry files.
It is not `create-aruna-app` output, generated Roblox Instance creation, or full Studio validation.

## Post-MVP

These stay out of the next cutline:

- resource patches (resources send whole snapshots)
- policies and capabilities
- Studio overlay and Studio runner flow (`aruna test` runs specs under Lune, not Studio)
- generated Roblox Instance creation
- full production Studio validation
- LSP and editor extensions

Already shipped, and so no longer on this list: resources and resource invalidation
(docs/rfcs/resources.md), player sessions
(`createServerApp({ createSession })`, `ctx.session`), `create-aruna-app` scaffolding
(0.2.0), and Rojo integration as far as Aruna needs it: project verification in
`aruna init` and `aruna doctor`, plus `aruna init --force` (0.3.0), generated
`node_modules` mounts (0.4.0), and `rojo serve` under `aruna dev` (0.2.0).

## Intentionally not implemented

- production Studio validation for remoting
- full schema compiler
- remote/action codegen beyond action stubs, the signal registry, the resource modules, and generated entry scripts
- generated Roblox Instance creation
- LSP
- VSCode extension
- plugin API
- custom Luau emitter
