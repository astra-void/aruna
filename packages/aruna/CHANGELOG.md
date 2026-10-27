# Changelog

All notable changes to the `aruna` package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The testing release. A project could always exercise an action in-process — the
runtime has had `app.dispatch` for that since 0.1 — but nothing shipped that a
consumer could actually run: the harness lived in this repo's own `apps/`, the
Lune loader with it, and a spec had to hand-build a context, a fake Players
service, a recording publisher, and a store backend before it could assert
anything. Meanwhile a spec file placed next to the code it tested was staged into
the game build like any other module.

### Added

- **`idempotent: true` on `defineAction`, and server-side de-duplication of
  retried calls.** Declaring an action idempotent says running it twice has the
  same effect as running it once. The compiler reads it (a boolean literal,
  `aruna::569 invalid-action-idempotent` otherwise) into the manifest, `aruna
  inspect actions`, and the contract snapshot, and the generated client stub
  passes `{ idempotent: true }`, which is what lets the default retry policy
  retry a timeout. `aruna contract diff` treats dropping it as breaking.

  Independently, every attempt of a retried call now carries one idempotency
  key (the 4th argument of the action RemoteEvent; a field of the Node request
  envelope), and the server runs a call once per key: a duplicate that arrives
  while the first is still running attaches to it, and a later one gets the
  remembered result. Keys are kept per player for 20 seconds, at most 64 per
  player, and dropped on leave. A call refused before it ran (rate limited,
  invalid input) is not remembered. `ActionInvokeOptions` gains `idempotent` and
  `idempotencyKey`; `app.dispatch` and the test harness's `invoke` take
  `{ idempotencyKey }` as a fourth argument, and the native `ActionRegistry`
  gains `forgetPlayer`. A server app now always subscribes to player removal
  (where it has a players source) so it can drop those keys.

- **A store compatibility gate in `aruna check` and `aruna build`.** In
  Roblox a client is replicated from the server it joined, so client/server
  skew inside one server essentially cannot happen; the boundary that does
  cross versions is the DataStore, where records the last build saved wait for
  the next one to read them. The compiler already recorded each store's
  schema and version, but `contract diff` ignored stores entirely. Now:

  - `aruna inspect contract` includes stores (id, kind, version, scope,
    `hasMigrate`, schema metadata and summary).
  - `aruna contract diff` judges a store by whether the new code can read a
    record the old code wrote at the same version: a new required field with
    no `.default()`, a changed or narrowed type, a version that went down, a
    bump with no `migrate`, or a changed scope or kind is breaking; a removed
    field is a warning (a new `warning` severity, counted in `summary.warning`);
    a bump with `migrate` is info.
  - When a snapshot is committed — `contract: { snapshot }` in the config,
    `aruna.contract.json` by default — `check` and `build` compare against it
    with no flags, and a breaking store change is
    `aruna::578 store-incompatible-change`, an error unless
    `strict.storeCompatibility` says otherwise. `build` stops before vendoring
    or compiling. An unreadable snapshot is `aruna::579 contract-snapshot-invalid`.
  - `aruna contract update` writes the snapshot; `aruna contract diff` with no
    arguments compares against it.

- **A request budget in front of dispatch.** `createServerApp({ requestBudget,
  onAbuse })`, in both runtimes. A per-action `rateLimit` rightly ignores
  invalid input, but nothing priced the checking itself, so an exploiter could
  spam malformed payloads for free, each one costing defaults, a full
  wire-safety walk, and a validation. Now every envelope is charged to a
  per-player token bucket (60 burst, 30 per second) before the payload is read
  and dropped silently once it is spent; a player's dispatches running at once
  are capped (32), and the next is refused with `ActionRateLimitError`
  (`retryAfterMs: 100`). `onAbuse(player, { reason })` hears about each one.
  Budget state is dropped on leave. The native `ActionRegistry` gains
  `admitEnvelope`, which its transport calls first.

- **`aruna/testing` — the spec surface.** `createTestServerApp(options)` wraps a
  real `ServerApp`, owning the transport, the publisher, and the players source
  so a spec drives the shipping dispatch path — validation, rate limiting,
  middleware, sessions, `ctx.store` — with no RemoteEvent, Players service, or
  DataStore:

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

  `join(player)` / `leave(player)` drive the player lifecycle; `published()` and
  `takePublished()` record what the signal publisher would have put on the wire
  (the shipping publisher over a recording remote, so an invalid payload still
  fails); `client(player)` returns a client app wired to this server, subscriber
  included, so a generated stub and the signal it triggers can both be asserted.
  `createTestPlayer()` returns a player double typed as `Player`.

- **A frozen, steppable clock.** The harness freezes the clock the rate limiter
  reads and `harness.advance(ms)` steps it, so a spec crosses a rate-limit
  window instead of waiting one out. `createServerApp({ nowMs })` — which the
  Node reference runtime already had — now exists on the native runtime too, and
  the native limiter's `check` accepts the clock rather than always reading
  `os.clock()`.

- **The test framework, in both runtimes.** `describe`, `it`, `itSkip`,
  `beforeEach`, `afterEach`, and `expect` (with `.not`, `toEqual`, `toThrow`, and
  `expect(promise).rejects.toThrow`) ship from `aruna/testing`, because under
  Lune there is no host runner to supply them. Rejections are read through one
  helper in both runtimes, so a matcher works against an `Error` and against the
  native runtime's plain table alike.

- **`aruna test`.** Compiles the project *with* its specs and runs the compiled
  Luau under [Lune](https://lune-org.github.io), streaming one line per test:

  ```text
  ✓ shop.purchaseItem > prices the order and reports success
  ✓ shop.purchaseItem > enforces the action's rate limit

  2 passed, 0 failed
  ```

  The runner ships with the package and loads roblox-ts's own `RuntimeLib`
  against an Instance tree rebuilt from the compiled output, so imports resolve
  with the same semantics the compiler emitted them for. `--filter <pattern>`
  narrows by spec path. Lune is not an npm package: install it with
  `rokit add lune-org/lune`.

- **A `test` module kind.** `**/*.test.ts(x)` and `**/*.spec.ts(x)` (extend with
  `conventions: { test: [...] }`) classify as tests **before** the
  client/server/shared tiers are considered — a spec sits next to the code it
  exercises, so `src/domains/shop/server/pricing.test.ts` matches `**/server/**`
  too and would otherwise be reported as an ambiguous match. A spec may import
  client, server, and shared modules alike.

- **`aruna::305 test-module-imported`.** Game code importing a spec is an error,
  not a style note: the game build does not compile specs, so the import would
  not resolve in the place that ships.

- **An injectable players source on the native `createServerApp`.**
  `createServerApp({ players })` replaces the Players service as the source of
  joins and leaves, mirroring the option the Node reference runtime already had.
  Unset in a game, where the app connects to `Players` itself; set by the test
  harness, which fires the handlers on demand.

- **`aruna::507 raw-remote-usage`, driven by `strict.rawRemoteUsage`.** The
  option was parsed but did nothing. It now reports project code that builds a
  remote (`new Instance("RemoteEvent" | "RemoteFunction" |
  "UnreliableRemoteEvent")`) or touches one of its send/receive members
  (`FireServer`, `FireClient`, `FireAllClients`, `InvokeServer`,
  `OnServerEvent`, `OnClientEvent`, `OnServerInvoke`). Traffic over such a
  remote skips the validation, rate limiting, and middleware an action gets. A
  warning by default; `"error"` fails the build, `"off"` turns it off. Specs
  and the generated dir (the vendored runtime included) are not checked.

- **`diagnostics.ignore`.** A list of diagnostic codes (`"aruna::507"`) or
  names (`"raw-remote-usage"`) to drop from every report, project-wide. A
  top-level `diagnostics` key used to be rejected as the retired flat config
  shape. It is now a nested section again, with `ignore` as its only field.

### Changed

- **Breaking: malformed request envelopes are dropped, and ids are
  bounded.** A request id must be a string of at most 64 characters and an
  action id at most 128, or the envelope is dropped before dispatch. The Node
  RemoteEvent transport used to answer a malformed envelope that still had a
  usable request id with an `ActionRequestError`; it now sends nothing, like
  the native transport — a reply only gives a flood something to measure.

- **Breaking: wire safety runs first, and stops at 2048 values.** Dispatch now
  checks wire safety before filling `.default(...)` values (then validation,
  then the per-action rate limit), and the walk gives up past 2048 visited
  values in both runtimes, on top of the existing depth limit: depth alone did
  not bound the work, since a flat array of a million numbers is one level
  deep. An input with more values than that is `ActionSerializationError`. An
  action's output and a signal payload are server-authored and not held to the
  limit.

- **Breaking: the default client retry no longer retries a timeout, unless the
  action is idempotent.** `withRetry` (and `createClientApp({ retry })`) used to
  retry `ActionTimeoutError` for every action. A timeout does not mean the server
  did not run the action — a purchase may have committed and only the response
  was late — and each attempt went out under a fresh request id, so the server
  could not tell a retry from a new purchase: a non-idempotent action could run
  twice. Rate-limit rejections are still retried (the server refused the call
  without running it). A timeout is retried only for an action declared
  `idempotent: true`, and a `retryOn` you supply keeps full control.

- **`strict.unresolvedImports` now sets the severity of `aruna::105`.** It was
  parsed and ignored, so the warning stayed a warning whatever it said. `"error"`
  now fails the build, and `"off"` stops reporting it.

- **`strict.sharedSafety: false` reports `aruna::109 strict-option-not-enforced`.**
  No shared-module safety check exists, so the option has never done anything.
  Setting it to its non-default value now says so instead of passing silently.
  The docs that said it guarded the shared → server import boundary were wrong:
  that boundary is always checked.

- **Breaking: internal error messages no longer reach the client.** Before
  this, the native runtime sent `tostring(reason)` for anything an action
  threw, and the Node transport sent `error.message`. A Luau runtime error
  carries the server script's path and line
  (`ServerScriptService.domains.shop.actions:42: attempt to index nil`). Now
  only public errors keep their `name` and `message` on the wire: the
  framework's own failures about the client's request (`ActionValidationError`
  and `ActionSerializationError` for the input, `ActionRateLimitError`,
  `ActionNotFoundError`, `ActionTimeoutError`) and errors made with the new
  `actionError` helper. Everything else reaches the client as
  `{ name: "ActionInternalError", message: "internal error", errorId }`.

  That includes an action's output failing its schema
  (`ActionValidationError`) or not being wire-safe
  (`ActionSerializationError`): a bad output is a server bug, and a schema's
  message — which a `.refine()` may have written — is server-authored. Such a
  failure is still the real `ActionValidationError` /
  `ActionSerializationError` for middleware (a rejection of `next`) and for
  `onError` (with full detail, plus the `errorId`); only the client sees
  `ActionInternalError`, unless `exposeInternalErrors` is set.

  ```ts
  import { actionError } from "aruna/server"; // or "aruna/roblox"

  throw actionError("OutOfStock", "Item is sold out");
  ```

  `onError` gets the original error, plus the same `errorId` in its info, so
  a player's report can be matched to the server log. A thrown plain table
  with `name` and `message` used to cross the wire as is in the native
  runtime. It no longer does unless it was made with `actionError`. `app.dispatch`
  follows the same rule. In the Node runtime it rejects with an
  `ActionInternalError` whose `cause` is the original error.

- **`createServerApp({ exposeInternalErrors })`.** Defaults to `false`. When
  set, a non-public error is sent with its own name and message, as before.
  `createTestServerApp` defaults it to `true`, so a spec still sees the real
  failure.

- **`aruna add domain` scaffolds a spec.** A new domain now starts with
  `actions.test.ts` next to its starter action — already passing, and already
  exercising validation — instead of an empty habit to remember.

- **The game build leaves specs out entirely.** They are never staged, so nothing
  in the place can reach one, and the vendored test framework
  (`runtime/testing*.ts`) is skipped along with them rather than replicated to
  every client. It is still written to disk, so `aruna/testing` resolves in an
  editor and under `aruna check`.

- **Discovery skips specs.** A `defineAction` / `defineSignal` / `defineStore` /
  `defineRuntime` inside a spec is a fixture: it does not enter the manifest, the
  generated registry, or the contract — and a duplicate id in a spec no longer
  breaks the build it was only meant to test.

- **Breaking: an action's schema failure is `ActionValidationError` in both
  runtimes.** The Node runtime threw `SchemaValidationError` for a failing action
  input or output, while the native runtime and the docs said
  `ActionValidationError`. Dispatch now throws `ActionValidationError`, exported
  from `aruna/server`, and that is the `name` a client sees. It subclasses
  `SchemaValidationError`, so `instanceof SchemaValidationError` still matches. A
  client that compared `err.name` with `"SchemaValidationError"` has to change.

- **An unknown action id is `ActionNotFoundError` in both runtimes.** Both
  reply `Aruna action not found: <id>` with that name. Before this, Node threw
  a plain `Error` and the native runtime replied `unknown action: <id>` with no
  name. Node exports the class from `aruna/server`.

- **Native validation messages match the Node runtime's wording.** A failing input
  reads `Aruna action shop.buy input validation failed: item: expected string`,
  not `invalid action input: item: expected string`. A spec that matched the old
  text has to change.

### Fixed

- **The Node RemoteEvent transport dropped middleware, `onError`, `ctx.session`,
  and `ctx.store`.** `bindRemoteEventActions` copied a hand-kept list of five
  dispatch options and silently left out the rest. An action dispatched over
  `createServerApp({ transport: robloxRemoteEvent() })` therefore skipped the
  app's middleware (an auth check included), never reached `onError`, and saw
  no session or store document. `app.dispatch` was unaffected. The binder now
  forwards every dispatch option, and `BindActionsOptions` is
  `DispatchActionOptions` plus `createContext`. The native runtime never had
  this gap.

- **The native runtime now validates action output.** It checked only that the
  output could cross the wire, though the README and the testing docs both said
  output was validated against `output`. It now checks the output schema and
  then wire safety in the innermost step, where the Node runtime checks them.
  Middleware therefore sees a failing output as a rejection, and the failure
  reaches `onError`.

- **Extensionless imports of a dotted file name resolved to the wrong module.**
  `import "./pricing.test"` resolved to `pricing.ts`, because the resolver tried
  replacing the last dotted segment before appending an extension. Appending is
  TypeScript's own rule and now comes first; the replacing form (for the
  `./foo.js` shape an ESM-style import writes) still applies after it. Any file
  with a dot in its name was affected, not just specs — and the boundary check
  then ran against whichever module the specifier had silently landed on.

- **An old server no longer migrates, or writes back, a record a newer
  version saved.** `decodeStoreValue` called `migrate` whenever the stored
  version differed from the store's, including when it was *higher*. After an
  update, old servers keep running; a player saved at v3 by a new server who
  follows a friend into an old v2 server had their record handed to the v2
  `migrate`. A permissive one passed the v3 data through, the old server saved
  it back under a v2 envelope, and the next new server ran the v2 → v3
  migration on it again — catastrophic for a currency rescale. A record from a
  newer version now fails with the new, non-retryable
  `StoreVersionAheadError` in both runtimes: `migrate` is not called, a keyed
  store's `save` / `update` refuse it, and a player store treats it as a failed
  load (no default document, no lock taken, nothing written). Kick from the
  player store's existing `onLoadFailed`, which the app's load reports
  through; `docs/stores.md` has the pattern.

- **A contract snapshot read back from a file kept less than it was written
  with.** The snapshot parser dropped union and tuple `members` and a number's
  `numericFormat`, so `aruna contract diff --baseline` saw a committed tuple as
  a length change against the same code, and could not tell `u8` from
  `number`. Both now survive the round trip.

### Security

- **The native runtime now rejects NaN and infinities.** The Node runtime
  rejected them through `Number.isFinite`, and the README said plain-data-v1
  did, but the native runtime — the one that runs in the game — only checked
  `typeIs(value, "number")`. `schema.number()` and `schema.f32()` accepted
  `0/0`, `math.huge` and `-math.huge`, the wire-safety check let every number
  through, and `schema.vector3()` and the other Roblox value types accepted a
  value with a NaN component. That is exploitable: every comparison with NaN is
  false, so a guard like `if (input.amount > balance) throw ...` lets a NaN
  through, and the NaN then poisons whatever it is added to — a store
  document included. Now a non-finite number fails every number format and the
  wire-safety check, top-level or nested, and so does a Vector3, Vector2,
  Color3, CFrame (all 12 components), UDim, or UDim2 with a non-finite
  component. An action without an input schema rejects one as
  `ActionSerializationError`, the same as with one, since the wire check runs
  first. The native schema messages now match Node's: `expected finite number`,
  `expected Vector3 { x, y, z }`, and so on. A spec that matched the old
  `expected number` has to change.

## [0.6.0] - 2026-08-16

The domain-layout release. A domain was one file per concern — every action in
`actions.ts`, every schema in `schema.ts` — so the only way to grow one was to
keep appending to the same files, and the only way to split them was a config
edit. Meanwhile nothing stopped one domain from importing another's internals:
`domains/` was a naming convention with no boundary behind it, so cross-domain
coupling formed against implementation details the owning domain never meant to
publish.

### Added

- **Folder form for every concern.** A file-name convention now also classifies
  the directory of the same name: `**/actions.ts` covers `**/actions/**`,
  `**/ui.tsx` covers `**/ui/**`, and a project's own
  `conventions: { shared: ["src/domains/**/policy.ts"] }` covers
  `src/domains/**/policy/**`. A concern that outgrew one file splits into a
  folder with no config change — and since actions, signals, stores, and
  runtimes are discovered by their definition call rather than by file name,
  the definitions come along. Matches are ranked in three tiers: a directory
  glob (`**/server/**`), then the derived concern folder (`**/actions/**`),
  then the file name, so `src/shared/actions/util.ts` is still shared and
  `domains/shop/ui/schema.ts` is client UI rather than a shared schema.
- **`**/index.ts` classifies as shared.** A barrel is a surface other modules
  import through, so it is shared-safe by default instead of unclassified. A
  barrel inside a partition folder keeps that folder's kind.
- **Domain-to-domain public API boundary — `aruna::304`.** A domain (one
  directory below `domains/`, extended by `domains: { roots: [...] }`) keeps its
  `client/` and `server/` subtrees to itself. What other domains may import is
  every module at the domain root — or, once the domain has an `index.ts`,
  exactly that barrel. An import that reaches past the surface is
  `aruna::304 cross-domain-private-import`:

  ```text
  warning aruna::304 cross-domain-private-import
    src/domains/shop/server/actions.ts imports src/domains/inventory/server/ledger.ts,
    which is private to the inventory domain.
  ```

  `strict.domainBoundary` sets the severity — `"warning"` by default, `"error"`
  to fail the build, `"off"` to disable. Only domain-to-domain edges are
  checked: imports inside one domain are unrestricted, and app-shell code
  (`src/client/**`, `<root>/app/**`, the entry files) still boots a domain's own
  client and server modules.

## [0.5.0] - 2026-08-15

The boot-order release. `runtime.ts` was a classification and nothing else — the
compiler knew the file was server-only and then never started it — so every
project hand-wrote a bootstrap script listing each `start*()` call in a
hand-chosen order. That file is derived information whose ordering rules lived
only in comments, and as a separate Script it raced the generated entry.

### Added

- **Domain runtimes — `defineRuntime`.** Declare the server work that starts at
  boot, and the runtimes it has to start after:

  ```ts
  export const emoteRuntime = defineRuntime({
    id: "emote",
    after: ["grab"],
    start() { ... },
  });
  ```

  The compiler resolves the `after` edges into a boot order (a stable
  topological sort, ties broken by id), records it in `manifest.runtimes`, and
  emits the sequence into the generated server entry after the app is
  constructed — so the transport exists before the first heartbeat, and the
  starts no longer race a hand-written Script that Roblox was free to run first.
  The ordering comments become edges the build checks: an `after` naming no
  runtime, a self-edge, and a cycle are `aruna::582`, a duplicate id is
  `aruna::581`, and a runtime with no `start` is `aruna::580` — the one shape
  that would compile and then quietly do nothing at boot. `aruna check` reports
  all of them without writing anything. Requires `entries: "generated"`.

### Fixed

- **A config can import `defineConfig` from `@arunajs/aruna`.** The config
  evaluator only shimmed the `aruna` alias, so writing the real package name —
  which is what the rest of a project imports — fell through to a CommonJS
  require and failed with Node's `No "exports" main defined`, an error that names
  the package rather than the import. Both the scoped name and its `/config`
  subpath now resolve.
- **A mixed npm scope is mounted per package, not wholesale.** Scope-level Rojo
  mounts put every build-time-only package in the scope into the DataModel as an
  empty Folder and made Rojo walk its whole file tree — `@facet-ui/theme`,
  `@rbxts/types` and `@rbxts/compiler-types` all materialized, which is what
  hand-written mounts had been spelling out to avoid. A scope whose packages all
  ship Luau still mounts wholesale. Per-package mounts take each instance name
  from the package's own project file (`@lattice-ui/react-dialog` → `dialog`),
  which is the name Rojo and the roblox-ts resolver both compute.

### Changed

- **Watch mode restages incrementally.** Staging rewrote every file each pass and
  cleared the staged `src/` before a reuse, so every rebuild restamped the whole
  tree and the resident `rbxtsc --watch` recompiled all of it — the cost keeping
  it alive was meant to avoid. Staging now writes only files whose bytes changed
  and prunes what the manifest no longer accounts for, which is what the
  wholesale clear was protecting against.

## [0.4.0] - 2026-08-15

The persistence release. Aruna knew what a game sends over the wire and nothing
about what it keeps; stores close that, with the failure modes that cost real
player data handled by the runtime rather than by every call site. Zero-config
also stops being an either/or: supplying `conventions` extends the built-ins now
instead of replacing them.

### Added

- **Stores — `defineStore` and `definePlayerStore`.** Declare a record's shape,
  default, and version once; the runtime owns validation, bounded retries with
  jittered backoff, request-budget awareness, versioned payloads with `migrate`,
  and — for player save files — a session lock claimed inside the same
  `UpdateAsync` that reads the record. Nothing throws: every operation resolves
  with a `StoreResult<T>` carrying a typed `StoreError` and whether a retry could
  plausibly succeed. A failed load returns an error and never a value, so the
  default can never be written over a record that could not be read. Both
  runtimes ship the same surface. See [docs/stores.md](./docs/stores.md).
- **`createServerApp({ playerStore })`.** The app loads a player's document on
  join, releases it on leave, flushes everything on `BindToClose`, and injects
  the open document into every action as `ctx.store` — optional by design,
  because a document that has not loaded must not be replaced by a default.
- **Stores in the compiler and the CLI.** Store exports are recorded in the
  manifest, their modules classify as `serverStore` and stage into the server
  partition, and `aruna inspect stores` lists them without executing the project.
  A client or shared module that imports a store is `aruna::574`; structural
  mistakes that can cost a save file (`aruna::570`, `571`, `573`, `575`, `576`)
  are errors, and `572` / `577` warn.
- **Generated Rojo `node_modules` mounts.** `aruna build` writes
  `<generatedDir>/node_modules.project.json` listing every scope holding a
  package that ships Luau, so `pnpm add` no longer comes with a hand edit to
  `default.project.json` — the failure it removes is success everywhere and a
  missing require in Studio. `aruna doctor` reports the scope a hand-written
  mount is missing.

### Changed

- **`conventions` in `aruna.config.ts` extends the built-in globs instead of
  replacing them.** Adding one glob used to cost a restatement of every default
  beside it. Config globs also outrank the defaults wherever both match, so a
  file-name glob a project pinned by hand is no longer reclassified by a default
  directory glob. `conventions: { defaults: false }` restores the old
  replace-everything semantics exactly. **This is a breaking change**: a project
  supplying `conventions` now also inherits the built-ins, so classification
  changes for paths it never covered. `**/signals.ts` joins the shared defaults,
  which is structural — the generated signal registry lands in the shared
  partition and imports each definition from its declaring file.
- **The generated tsconfig fragment carries the whole roblox-ts compile
  contract.** The `target`/`module`/`moduleResolution`/`noLib` triple rbxtsc
  requires, the `@rbxts` type roots, `src` → `out`, and the include globs that
  reach the dot-prefixed generated dir were hand-copied into every consumer
  tsconfig and drifted silently. A scaffolded tsconfig is now `extends` plus what
  the project actually chooses; an existing project's inline values still win.
- **Watch mode keeps one `rbxtsc --watch` alive** across rebuilds and only
  restages sources into it, instead of paying a cold compile per change. It stays
  an optimization: no rbxtsc, `--no-emit-luau`, or a child that fails to start
  falls back to one-shot builds with a note.

### Fixed

- **A source-less project is no longer reported as a malformed tsconfig.**
  TypeScript's "No inputs were found in config file" (TS 18003) was forwarded as
  `aruna::103`, so a freshly scaffolded project failed `aruna doctor` on a
  perfectly well-formed file.

## [0.3.0] - 2026-08-14

The silent-failure release. Verifying Aruna against real Rojo projects turned up
two ways to end up with a place that contains none of your code while every
command in the pipeline exits 0. Both are now impossible to hit quietly.

### Fixed

- **Generated files under the dot-prefixed generated dir are compiled again.**
  TypeScript's wildcard `include` globs never match a directory segment starting
  with a dot, so `src/**/*.ts` skipped `src/.aruna/` entirely. Files there still
  reached the program when something imported them, which masked the hole — but
  with `entries: "generated"` the entry scripts live there and nothing imports
  them, so they were never compiled: the built place had no `Script` or
  `LocalScript` at all and nothing ran. The generated dir is now named
  explicitly in both the staged tsconfig `aruna build` compiles against and the
  tsconfig `aruna init` scaffolds, so the entries are emitted and `aruna check`
  and your editor typecheck them. The vendored binary codec (`binary.ts`) was
  never reaching Luau for the same reason and now does.
- **The staged build compiles what your project actually configures.** `aruna
  build` partitions the project into a temp tree before running `rbxtsc`, and it
  rebuilt the tsconfig from scratch while copying only the modules the manifest
  lists — so everything else your compile depends on disappeared. Ambient `.d.ts`
  files are not modules and were never staged, taking their `declare global` /
  JSX augmentations with them; and your own `compilerOptions` were dropped,
  including rbxtsc `plugins` transformers, the JSX factory pair, decorators and
  `lib`. A project whose UI props come from an augmentation and whose transformer
  lowers them failed to typecheck, and would have emitted untransformed code even
  if it had. The staged config now inherits your `compilerOptions` through the
  `extends` chain and overrides only what describes the staged tree, strictness
  flags (`strict`, `noUncheckedIndexedAccess`) are left to you rather than forced,
  every `.d.ts` under `src/` is staged, and root-level config files are copied so
  toolchain plugins find theirs.
- **`rbxtsc` resolves and runs on Windows.** The extensionless `rbxtsc` entry npm
  writes is a POSIX shell script only Git Bash can run; the bin lookup now
  prefers the `.cmd`/`.bat`/`.exe` shims and spawning routes through `cmd.exe`
  with arguments quoted for it.

### Added

- **Rojo project verification.** Adopting Aruna inside an existing Rojo project
  was a silent no-op: `aruna init` kept the project file `rojo init` scaffolds,
  which mounts Luau sources off `src/` and never mounts `out/`, and nothing
  downstream looked at it. The project file is now checked against the
  partitioned `out/` contract from both ends — `aruna init` warns when it keeps
  an unmounted project, and `aruna doctor` grows a `rojo project` section that
  reports the missing mounts.
- **`aruna init --force`.** Overwrites the scaffolded files instead of keeping
  what is already there — the one-command fix for a Rojo project file that does
  not mount `out/`. Without it `init` still keeps your files, as before.

### Changed

- **`aruna doctor` exits 1 when the Rojo project omits an `out/` mount.** This is
  the only signal available for a build that would otherwise succeed into an
  empty place. A missing or malformed project file stays report-only — `rojo
  build` refuses those loudly on its own — and a project file under a
  non-default `*.project.json` name is inspected rather than reported missing.

## [0.2.0] - 2026-07-16

The setup-DX release: the daily loop and project scaffolding become one-command
(`aruna dev`, `aruna add domain`, `npm create aruna-app`), the transport abstraction
collapses onto the single RemoteEvent wiring, and the wire gets safety rails
(schema fingerprints, path-aware validation errors, typed wire errors, default
request timeouts). This is a pre-1.0 release: the removed symbols and config
fields below are a hard break, not a deprecation cycle.

### Added

- **`aruna dev` — the one-command daily loop.** Runs the watch build (codegen +
  vendoring + rbxtsc per save) and spawns a `rojo serve` child once the first
  pass has produced `out/`. Configure with `dev: { rojo: true | false | { port } }`
  (plus `--no-rojo` / `--rojo-port`); rojo output is line-prefixed with `rojo │`,
  and rojo failing to launch or exiting warns without tearing down the watch loop.
- **`aruna add domain <name> [--with ui,runtime]` — convention-true scaffolding.**
  Generates `<root>/domains/<name>/{schema,model,actions}.ts` (plus `ui.tsx` /
  `runtime.ts`) whose file names are the classifier's own Recommended Layout
  conventions, so scaffolded files are correctly classified by construction.
  The actions template imports its schemas from `./schema` (see below).
- **`create-aruna-app` — `npm create aruna-app@latest my-game`.** Scaffolds the pinned
  rbxts toolchain matrix, `entries: "generated"` config, rokit/VS Code/git
  plumbing, then installs and runs `aruna init` → `aruna add domain shop --with
  ui` → `aruna build`, so a fresh project builds green in one command.
- **`aruna doctor` toolchain check.** Reads the installed roblox-ts's own
  TypeScript pin and warns when the installed `typescript` drifts from it — the
  classic rbxts setup trap, surfaced before rbxtsc fails confusingly.
- **Schemas resolve through one import hop.** `input: purchaseInput` with
  `import { purchaseInput } from "./schema"` now extracts contract metadata; an
  identifier that resolves to nothing is the new `aruna::565` error instead of a
  silent `unknown` contract.
- **`rateLimit.key: "global"`** — a single shared bucket across all callers,
  alongside the per-player default, end to end (parser, both runtimes, contract).
- **Wire safety rails.** Binary frames carry a u32 schema fingerprint (identical
  layout hash in both runtimes) so mid-rollout schema drift fails loudly;
  validation failures report the failing path (`firstSchemaIssue`); wire errors
  are typed; client requests time out by default instead of hanging forever.
- **Unreliable signals.** `defineSignal({ unreliable: true })` routes over a
  dedicated UnreliableRemoteEvent for high-frequency latest-value-wins channels.
- **Native `ServerApp.actions` + `ServerApp.dispatch`** — the in-process,
  validated dispatch path (the supported way to exercise actions under Lune),
  plus a player lifecycle hook on the server app.

### Changed

- Default remote instances are the flat `ArunaActionRemoteEvent` /
  `ArunaSignalRemoteEvent`, identical across both runtimes.
- `publisher.toBatched` returns a `Promise` that settles after the last chunk.
- The roblox-flavored `defineAction`'s `ctx.player` is `Player` (non-optional).
- `defineSignal` preserves the id literal type (`definition.id` no longer widens
  to `string`), so call sites key publishes/subscribes off the definition.
- `aruna init` scaffolds `skipLibCheck: true` — an @rbxts/types point release
  can no longer break a consumer's `tsc --noEmit`.
- Boundary rules now also apply to unclassified modules.

### Removed (breaking)

- **`actions.transport` config field** — Aruna always uses the RemoteEvent
  transport; the config loader rejects the field with a migration message, and
  the remote-function/memory public transport surface is gone.
- The remote-signal static `handlers` option — use `subscriber.on(id, handler)`.
- `bindRemoteEventActions` is internal — bind through `createServerApp({
  transport: robloxRemoteEvent() })` / `bindActions`.

The earlier dogfooding round below (versioned 0.1.3 locally, never published to
npm) also ships for the first time in 0.2.0. Those changes close gaps found by
dogfooding Aruna from a downstream consumer; the renamed/removed symbols are
likewise a hard break.

### Added

- **`aruna build --watch` — the build loop is now automatic.** The CLI stays
  running and re-runs the full build (stub generation, runtime vendoring, rbxtsc)
  whenever project source changes, removing the stale-stub footgun of forgetting
  to rebuild after an action/signal edit. Save bursts debounce into one rebuild, a
  change landing mid-build queues exactly one follow-up, and the build's own
  output trees (generated dir, `out/`, `include/`) never re-trigger it.

- **`createClientApp({ signals, createSubscriber })` — the client app can own the
  signal subscriber**, mirroring the server app owning the publisher. Pass the
  generated registry plus `createSignalSubscriber` (from `aruna/roblox`) and the
  app builds a typed subscriber at boot, exposed as `clientApp.subscriber` and
  disposed with the app. Exported `ClientSignalSubscriberFactory` in both
  runtimes.

- **`aruna contract diff` now gates signals.** A removed signal, a removed or
  retyped payload field, or a serialization-policy change is breaking; an added
  signal or payload field is non-breaking — output compatibility rules, since
  payloads travel server → client. Signal-free baselines from before signals
  existed still parse and diff cleanly.

- **`schema.record(value)` and `schema.tuple([...])` — maps and fixed-shape
  arrays are first-class.** `record` is a homogeneous string-keyed map
  (`Record<string, V>`; non-string keys fail validation), `tuple` a fixed-length
  heterogeneous array validated positionally. Both work end-to-end: runtime
  validation in both runtimes, compiler-extracted metadata, typed generated
  stubs, contract snapshots/diff (a record value-type change or tuple re-shape is
  breaking), and the binary codec with a deterministic byte-identical layout
  (records sort entries by key; tuples encode a fixed sequence, no length
  prefix). `nullable` was deliberately left out: Luau collapses nil/undefined, so
  it cannot be distinguished from `optional` on the wire.

- **`createServerApp({ middleware, onError })` — around-run action middleware.**
  Middleware is applied outermost-first to every action on every dispatch path,
  running inside rate limiting and input validation (a throttled or malformed
  request never reaches it): auth checks, logging, timing. Throw to
  short-circuit; await `next()` to observe/transform. `onError` observes errors
  raised from the execution chain before they reach the transport. Both
  runtimes; `ActionMiddleware` / `ActionErrorHandler` join the export-parity
  contract.

### Changed

- **`createClientApp({ transport })` — the client and server now share one wiring
  vocabulary.** The `invoker` option is renamed to `transport`, the client
  counterpart of `createServerApp({ transport })`; the `ClientTransport` type is
  exported from `aruna/client` in both runtimes. When `transport` is omitted,
  `createClientApp()` builds the default Roblox invoker (`createActionInvoker()`),
  so client boot is one argless call. The app disposes a default-built transport;
  a caller-supplied transport stays caller-owned.

### Fixed

- **Layout-transition safety: stale generated artifacts are pruned (correctness).**
  `aruna build` now tracks the files it emits in a `.aruna-build.json` ledger and
  prunes artifacts from a previous codegen layout it no longer emits — the flat
  `*.generated.ts` stubs and the flat `runtime/` directory left behind by the
  split-tree migration. Pruning is confined to the `generatedDir` and the owned
  ledger (plus those known legacy names), so hand-written files are never touched.
  This removes the silent-oncompile footgun where a stale flat artifact, still
  pointed at by an out-of-date alias, shadowed the current split-tree output.
- **`aruna check` now reports layout desync.** New diagnostics surface a stale
  generated artifact on disk (`aruna::110`) or a tsconfig alias pointing at a path
  that no longer matches the current emit layout (`aruna::111`), so the desync can
  no longer pass silently. Both are repaired by `aruna build` / `aruna doctor --fix`.
- **`defaultRateLimit` now reaches the wire (correctness).** A config-level
  `defaultRateLimit` was dropped on the way to the RemoteEvent/RemoteFunction
  dispatch path: actions without their own `rateLimit` were never throttled. The
  transport binders (`bindRemoteEventActions`, `bindRemoteFunctionActions`) now
  accept and forward `defaultRateLimit`, and `createServerApp` applies it on
  every dispatch path. Regression covered by `default-rate-limit-app.test.ts`.
- The `createServerApp(...).bind((registry) => bindActions(registry))` 2-step
  pattern is no longer a dead path — it now seeds `defaultRateLimit` into the
  registry it hands the binder, so the fallback is enforced even when no dispatch
  options are forwarded.

### Added

- **`ctx.publisher` — publish signals from inside an action.** When
  `createServerApp` owns a publisher (`{ signals, createPublisher }`), it is
  injected into every action's `run` context (both runtimes, every transport), so
  an action can push server → client signals without a hand-written holder module.
  `ctx.publisher` is optional on the base `defineAction`. Bind a `defineAction` to
  your signal registry with **`createActionDefiner<Signals, Player>()`** (exported
  from `aruna/server` and `aruna/roblox`) to get a non-optional, registry-checked
  `ctx.publisher` — a wrong signal id or payload is a compile error. It is pure
  typing sugar; the publisher is still owned and built by the app.
- **`aruna doctor --fix` realigns every alias to the current emit layout** —
  action, `$aruna/signals`, and `aruna/*` runtime aliases are rewritten to the
  split-tree paths and stale flat targets dropped, cross-repo (`--project .`) too.
- **`createServerApp({ transport })`** — the app now owns the transport binding.
  Pass `robloxRemoteEvent()` (or `robloxRemoteFunction(remote)`) so every dispatch
  option, including `defaultRateLimit`, reaches the wire. The app exposes
  `binding` and `dispose()`. This is the recommended server wiring.
- **`createServerApp({ signals, createPublisher })`** — the app can own the signal
  publisher, building it (and creating the signal remote) at boot via
  `serverApp.publisher`, removing the hand-written lazy-singleton plumbing module
  and its boot-order footgun.
- **Turnkey signal helpers in the Node reference runtime** — `createSignalPublisher(signals)`
  and `createSignalSubscriber(signals)` (plus `ensureSignalRemote` /
  `waitForSignalRemote`) now exist in both runtimes with identical signatures.
  The `(remote, signals)` form (`createRemoteSignalPublisher` /
  `createRemoteSignalSubscriber`) remains as the advanced overload.
- **`ClientApp.invoke(...)`** — an injection-friendly call path that does not depend
  on the global `invokeAction` install order. The not-installed error message is
  now actionable.
- Shorter, transport-agnostic option type names: `ActionInvokerOptions`,
  `BindActionsOptions`, `BindFunctionActionsOptions`, `ActionContextFactory`,
  `RateLimitKeyResolver`, `SignalSubscriberOptions`.
- `Infer<typeof schema>` is the canonical schema-inference type across both
  runtimes.

### Changed

- Generated client stubs emit `Promise<void>` for actions without an output
  schema (was `Promise<unknown>`); a declared output schema still emits the
  inferred payload type. Action input without a schema stays `unknown`.
- The compiler classifies files under `generatedDir` by their path relative to
  `generatedDir`, so a `generatedDir` nested inside a `client`/`server`/`shared`
  convention path no longer produces a spurious multi-convention (boundary) error.

### Removed (breaking)

- `createServerApp(...).bind(...)` and the `ServerActionBinder` type — use
  `createServerApp({ transport })` (or an inline
  `transport: ({ registry, dispatch }) => bindActions(registry, dispatch)`).
- `RemoteEventActionInvokerOptions` — use `ActionInvokerOptions`.
- `BindRemoteEventActionsOptions` — use `BindActionsOptions`.
- `BindRemoteFunctionActionsOptions` — use `BindFunctionActionsOptions`.
- `RemoteEventActionContextFactory` — use `ActionContextFactory`.
- `CreateRemoteSignalSubscriberOptions` — use `SignalSubscriberOptions`.
- `ActionRateLimitKeyResolver` — use `RateLimitKeyResolver`.
- `InferSchema` — use `Infer`.
