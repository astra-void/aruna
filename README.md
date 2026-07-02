# aruna

Aruna is a compiler-first Roblox framework for server-authoritative games.

The model is intentionally closer to Svelte-style compile-time transforms than to a heavy OOP framework. Classes are allowed. Services are not the framework model. Actions are.

Aruna owns boundaries, actions, generated output, and diagnostics. Users own domain taxonomy.
Aruna complements roblox-ts and TypeScript; it does not replace them.
Its product value comes from compiler-discovered server actions, an inspectable action contract, and boundary-aware diagnostics, not from a typed remote wrapper alone. Server-owned resources and policy metadata are the intended direction, not yet implemented.

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
    actions.client.generated.ts
    actions.server.generated.ts
    manifest.json
```

Policy notes:

- `src/client.tsx` and `src/server.ts` are the harness runtime entry files.
- The harness source stays spec-shaped; emitted output is partitioned separately for `rbxtsc`.
- `domains/` is a recommended organization pattern, not a boundary kind.
- `shared/` is reserved for cross-domain shared-safe code.
- `.aruna/` is generated output and can be deleted and regenerated safely.
- Do not require every client-only or server-only module to use `.client.ts` or `.server.ts`.
- Reserve `.client` and `.server` suffixes for explicit runtime entry hints, not broad folder conventions.

## Configuration

Aruna is still pre-public, so the config surface is being shaped around the intended public API now.
Use `defineConfig()` and the nested config shape directly.

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
    transport: "remote-event",
    defaultRateLimit: {
      key: "player",
      windowMs: 1000,
      max: 20,
    },
  },
  conventions: {
    client: ["src/client.tsx", "src/domains/**/ui.tsx"],
    server: ["src/server.ts", "src/domains/**/actions.ts", "src/domains/**/runtime.ts"],
    shared: ["src/app/**", "src/shared/**", "src/domains/**/schema.ts", "src/domains/**/model.ts"],
  },
  strict: {
    sharedSafety: true,
    rawRemoteUsage: "warning",
    unresolvedImports: "warning",
  },
});
```

- `compiler.generatedDir` controls where generated files are written.
- `compiler.manifest` accepts a manifest path string or `{ output }`.
- `actions.transport` currently supports `remote-event`, `remote-function`, and `memory`.
- `actions.defaultRateLimit` uses `key`, `windowMs`, and `max`.
- `conventions.client`, `conventions.server`, and `conventions.shared` are arrays of glob strings.
- `strict` is accepted and normalized; the current implementation does not fully enforce every strict behavior yet.
- The legacy flat `generatedDir` / `manifest.output` config shape is no longer supported.
- `domains/` remains recommended, not required.

## Quickstart flow

1. Config:

   ```ts
   import { defineConfig } from "aruna";

   export default defineConfig({
     compiler: {
       generatedDir: "src/.aruna",
       manifest: "src/.aruna/manifest.json",
     },
     actions: {
       transport: "remote-event",
       defaultRateLimit: {
         key: "player",
         windowMs: 1000,
         max: 20,
       },
     },
     conventions: {
       client: ["src/client.tsx", "src/domains/**/ui.tsx"],
       server: ["src/server.ts", "src/domains/**/actions.ts"],
       shared: ["src/shared/**", "src/domains/**/schema.ts", "src/domains/**/model.ts"],
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
   aruna doctor --fix
   aruna check
   aruna build
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
- `aruna check` (also flags layout desync: stale generated artifacts `aruna::110`, tsconfig aliases pointing at an old emit path `aruna::111`)
- `aruna inspect`
- running `aruna` with no subcommand aliases to `aruna check`
- `aruna build` prunes stale artifacts from a previous codegen layout (tracked in `.aruna-build.json`, confined to `generatedDir`)
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
- `aruna inspect actions` lists client-callable actions, input/output schema summaries, serialization policy metadata, rate-limit metadata, and basic authority notes
- `aruna inspect contract` emits a deterministic JSON snapshot of the action contract surface, including ids, source paths, generated export names, schema metadata and summaries, serialization policy, rate limits, authority notes, and warnings
- `aruna contract diff` compares two action contract snapshots or a snapshot file against the current project and reports breaking, non-breaking, and info-level changes
- generated action files are snapshot-tested in the fixture suite
- application code should import generated actions through `$aruna/actions/client` and `$aruna/actions/server`
- `aruna build` writes deterministic `src/.aruna/actions.client.generated.ts` and `src/.aruna/actions.server.generated.ts`
- generated client stubs are typed from schema metadata where the metadata is supported
- generated client stubs now connect to a minimal action runtime contract
- an in-memory action invoker exists for non-Roblox tests
- thin client/server app bootstrap helpers at `aruna/client` and `aruna/server` wire the runtime invoker and server action registry
- the bootstrap helpers are functional, disposable, and intentionally do not scan modules or register services
- a structural Roblox `RemoteFunction` action transport adapter exists for tests and future Studio integration
- a structural Roblox `RemoteEvent` request/response transport adapter exists for tests and future Studio integration
- Roblox-facing default action remote helpers now bind to `ReplicatedStorage/Aruna/Actions`
- `packages/aruna` is organized internally into `cli/`, `runtime/`, `actions/`, and `schema/` implementations
- the public subpath exports remain stable through top-level compatibility shims
- `@rbxts/types` and `@rbxts/compiler-types` are used at typecheck time for Roblox-facing runtime types
- runtime schema validation now runs on action input and output at dispatch time
- runtime serialization policy now runs on action input and output at dispatch time using the default `plain-data-v1` boundary
- action input/output rejects `Instance`, `Player`, function, class-instance, cyclic, non-finite, and other non-plain values by default
- basic fixed-window action rate limiting now runs per action and player/key before `run()`
- invalid input and serialization failures do not consume quota
- manifest action records now include serialization policy metadata and optional `rateLimit` metadata
- the contract snapshot foundation is implemented through `aruna inspect contract`, and `aruna contract diff` now serves as the compatibility gate for action contract snapshots
- the MVP schema helpers support string, number, boolean, and undefined literal values, plus array, object, optional, and enum validation
- the schema DSL now has TypeScript inference for primitives, literals, arrays, objects, optionals, and enums
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

Server — publish to one player, several players, or everyone:

```ts
import { createRemoteSignalPublisher } from "aruna";

const signals = { "combat.damaged": damaged };
const publisher = createRemoteSignalPublisher(remote, signals);

publisher.to(player, "combat.damaged", { amount: 12, source: "trap" });
publisher.toMany(players, "combat.damaged", { amount: 5, source: "fall" });
publisher.toAll("combat.damaged", { amount: 3, source: "lava" });
```

Client — subscribe statically at app wiring, dynamically with `.on()`, or both:

```ts
import { createRemoteSignalSubscriber } from "aruna";

const subscriber = createRemoteSignalSubscriber(remote, signals, {
  handlers: {
    "combat.damaged": (payload) => updateHud(payload),
  },
});

const connection = subscriber.on("combat.damaged", (payload) => {
  /* ... */
});
connection.disconnect();
```

- Payloads are validated against the `plain-data-v1` serialization boundary and the declared schema on publish (the server throws on a violation) and dropped on schema mismatch on delivery (the client never invokes a handler with a malformed payload).
- Both runtimes ship turnkey default-transport helpers `createSignalPublisher(signals)` / `createSignalSubscriber(signals)` over a dedicated signal RemoteEvent, distinct from the action remote. They ensure / wait for the remote on call, so no hand-written boot-order plumbing is needed; `createServerApp({ signals, createPublisher })` can own the publisher so the remote is created at boot.
- An app-owned publisher is injected into every action's `ctx`, so an action's `run` can publish signals directly (`ctx.publisher?.toAll(...)`). Bind a `defineAction` with `createActionDefiner<Signals, Player>()` for a non-optional, registry-checked `ctx.publisher` — no plumbing module. See [docs/signals.md](packages/aruna/docs/signals.md#publishing-from-inside-an-action).
- Signals are compiler-discovered: `defineSignal` exports are recorded in the manifest (`manifest.signals`), listed by `aruna inspect signals`, and included in the contract snapshot from `aruna inspect contract`. (Contract `diff` currently gates action changes; extending the diff to signals is a follow-up.)

## Binary serialization

`encodeBinary` / `decodeBinary` pack a schema-conforming value into a tightly packed byte buffer, using the schema as the layout. Because both sides share the schema, no field names or type tags travel on the wire — only the payload bytes.

```ts
import { encodeBinary, decodeBinary } from "aruna";
import { schema } from "aruna/schema";

const hit = schema.object({ amount: schema.number(), source: schema.string() });

const bytes = encodeBinary(hit, { amount: 12, source: "trap" });
const value = decodeBinary(hit, bytes); // { amount: 12, source: "trap" }
```

- The wire format is byte-identical across the Node reference runtime (`Uint8Array` + `DataView`) and the roblox-ts native runtime (Luau `buffer`), so a value encoded on one decodes on the other.
- Layout: string = u32 length + UTF-8; number = the declared numeric width; boolean = u8; literal = 0 bytes; array = u32 count + items; object = fields in sorted key order; optional = u8 present flag + inner; enum = u32 index; union = u32 member index + member.
- **Numeric width hints** pick a packed encoding per number. `schema.number()` is a full-width `f64`; `schema.f32()`, `schema.u8()`, `schema.u16()`, `schema.u32()`, `schema.i8()`, `schema.i16()`, and `schema.i32()` pack to their declared byte width and (for integer formats) validate the value is a whole number in range. A `{ hp: u16, team: u8 }` element costs 3 bytes instead of 16. Widths flow through the compiler into action/signal schema metadata (`numericFormat`) and the contract summary.

  ```ts
  const hit = schema.object({ amount: schema.u16(), crit: schema.boolean() });
  encodeBinary(hit, { amount: 1200, crit: true }).length; // 3 bytes
  ```

- Encoding assumes the value already matches the schema (the action and signal boundaries validate first); a mismatch throws rather than emitting a corrupt buffer.

## Spec Cutline

Serialization boundary, fixed-window rate limits, the contract snapshot, contract diff, and package-consumption validation are all implemented. The next cutline stays on stabilization and a create-app starter contract, not more transport expansion or a policy/capability system:

1. Stabilize current compiler, action, runtime, and package-consumption behavior.
2. Add runtime execution tests for the roblox-ts-native runtime, preferably through a Lune/Luau harness (today the native runtime is compiled but not executed in CI).
3. Refine thin authority inspection without adding a full policy/capability system.
4. Write the create-app RFC / starter contract.
5. Design resources and invalidation after the starter contract is stable.
6. Implement resources later.

## Package consumption validation

`apps/package-consumption-harness` simulates a project outside the monorepo source layout consuming Aruna as a package.
It imports `defineConfig` from the root package for config only, and uses the runtime-safe public subpaths `aruna/server`, `aruna/client`, `aruna/roblox`, and `aruna/schema` for Roblox-facing code.
It validates `aruna doctor --fix --emit-runtime`, `aruna check`, `aruna build --emit-runtime`, `aruna inspect actions`, `aruna inspect contract --json`, and `aruna contract diff` against that package-style layout.
It does not implement `create-app`.

Package consumption uses a vendored-runtime model rather than direct `node_modules` imports of Roblox-facing code:

- The roblox-ts-native runtime lives at `packages/aruna/roblox/` and ships in the package via `files` (it is separate from the Node reference runtime under `packages/aruna/src`).
- `aruna build --emit-runtime` vendors that native runtime into the consumer as project source under `src/.aruna/runtime/`.
- `aruna doctor --fix --emit-runtime` installs the `aruna/*` → vendored-runtime tsconfig path aliases that pair with `build --emit-runtime`.
- `default.project.json` maps the full `out` tree, so `rbxtsc` compiles the whole consumer — including the vendored runtime — to Luau without the "modules directly under node_modules" rejection.

`pnpm verify:package-consumption` builds local tarballs and installs the packed Aruna dependency graph without contacting the npm registry for `aruna`, `@arunajs/core`, or `@arunajs/compiler`.
The packed package-style tarball smoke runs `doctor --fix --emit-runtime` and `build --emit-runtime`, generates `src/.aruna` action files and the vendored runtime, passes TypeScript, and compiles to Luau with `rbxtsc`. This is package-layout and rbxtsc compile validation, not production Studio validation.

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
`aruna build` writes the physical generated files used by TypeScript and roblox-ts tooling.
For TypeScript and roblox-ts tooling, run `aruna doctor --fix` once to install the required tsconfig path aliases.

## Real app harness

`apps/rbxts-harness` is a private roblox-ts-style app harness.
It intentionally mirrors Recommended Layout v0 closely enough to act as the realistic app/starter reference while still remaining a harness rather than create-app output.
Its whole build is a single turnkey command — `"build": "aruna build"` — exactly as a real consumer would run it: the bare `aruna build` generates the action (and signal) stubs, vendors the Roblox runtime into `src/.aruna/runtime/`, partitions the project by module classification, and drives `rbxtsc` to compile to Luau. There is no separate typecheck/rbxtsc/layout step.
The source consumes Aruna through the vendored runtime via subpath imports (`aruna/server`, `aruna/schema`, `$aruna/actions/*`, `$aruna/signals`).
Because the source uses the `domains/` recommended layout (classification is by convention, not by physical folders), `aruna build` stages the source into `out/client`, `out/server`, and `out/shared` and `default.project.json` maps each onto the Roblox DataModel — server code into `ServerScriptService` (never replicated to clients), client into `StarterPlayerScripts`, shared (plus the vendored runtime and client-callable stubs) into `ReplicatedStorage`.
The harness covers generated action files, app bootstrap, schema inference (including optional fields), domain-local UI files, and public Aruna runtime imports.
The runtime entries live under `src/client.tsx` and `src/server.ts`; `src/app/bootstrap.ts` and `src/app/providers.ts` stay shared-safe app composition helpers rather than hidden runtime entry files.
It is not create-app, Rojo generation, generated Roblox Instance creation, or full Studio validation yet.

## Post-MVP

These stay out of the next cutline:

- resources and resource invalidation
- policies and capabilities
- player sessions
- Studio overlay and Studio runner flow
- DataStore workflows
- generated Roblox Instance creation and Rojo integration
- create-app scaffolding
- full production Studio validation
- LSP and editor extensions

## Intentionally not implemented

- production Studio validation for remoting
- full schema compiler
- advanced remote/action codegen beyond action stubs
- generated Roblox Instance creation and Rojo integration
- LSP
- VSCode extension
- create-app scaffolding
- plugin API
- custom Luau emitter
- full roblox-ts build orchestration
