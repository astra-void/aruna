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

- **Schema constraints in the contract.** The compiler records every bound
  whose argument it can read (a number literal, or a module-level `const` bound
  to one) as a value on the schema — `minLength`/`maxLength`,
  `minChars`/`maxChars`, `min`/`max`, `int`, `minItems`/`maxItems`,
  `maxEntries` — counts `.refine()` calls, names a bound computed at runtime in
  `dynamicConstraints`, and hashes only what it cannot read. `aruna contract
  diff` judges each change by the direction the value travels: a tighter input
  bound is breaking and a looser one non-breaking; for an output or a signal
  payload, the other way round; a changed predicate is a
  warning. `aruna inspect` shows the bounds after the type
  (`string (maxLength 64)`).

- **`aruna::514 unbounded-action-input`.** An action whose input leaves a
  string, array, or record without an upper bound is a warning, listing each
  such path; a bound computed at runtime counts. `strict.unboundedInput` sets
  its severity (`"off"` | `"warning"` | `"error"`). `aruna add domain`
  scaffolds a bounded input.

- **`schema.record(...).maxEntries(n)`**, with `.refine()` and `.default()` on
  records like on arrays.

- **Token-bucket rate limits.** `rateLimit: { ..., strategy: "tokenBucket" }`
  (and `actions.defaultRateLimit.strategy`) holds at most `max` tokens and
  refills `max` of them evenly over `windowMs`, so a burst never exceeds `max`,
  where a fixed window lets up to 2 × `max` through across a boundary. A
  refusal's `retryAfterMs` is the time until the next token. `"fixedWindow"`
  stays the default; the manifest and the contract record the strategy only for
  a token bucket, and `contract diff` reports a strategy change as info.

- **`aruna migrate`: codemods for breaking changes.** `aruna migrate --list`
  shows them; `aruna migrate <name> --dry-run` prints a unified diff without
  writing; `aruna migrate <name>` applies it. Codemods edit only what they
  change (no reformatting), are safe to run twice, and report the sites they
  could not rewrite with confidence, by file, line, and column. The first one,
  `action-validation-error-name`, migrates code that compares an error's
  `name` against the old `"SchemaValidationError"` to `"ActionValidationError"`
  (see the stabilization round's rename). docs/codemods.md covers writing one.

- **Canary releases.** A manual run of the publish workflow publishes the whole
  package graph as `<next patch>-canary.<sha>.<run>` under the npm `canary` tag
  (`npm install @arunajs/aruna@canary`), next to the tag-triggered stable
  release. Canaries carry no stability guarantees (docs/stability.md).

- **`aruna dev` and `aruna build --watch` recompile incrementally.** The watch
  loop keeps one compiler session for its lifetime and tells it which files
  changed, so a rebuild re-reads and re-parses only those files; on a 3,000-file
  project a one-file edit rechecks in ~40 ms instead of ~800 ms. Changing
  `aruna.config.*` or a `tsconfig*.json` starts a fresh session. The compiler
  also runs off the main thread now, so the watcher, the rojo child, and the
  resident rbxtsc keep running while it works.

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

- **`schema.string().maxChars(n)` / `.minChars(n)`.** Length limits in
  characters (code points) — `"가나다"` is 3, `"😀"` is 1 — for the limits a
  person reads: names, chat lines. A string that is not valid UTF-8 (natively,
  where `utf8.len` returns nil; in Node, one with a lone surrogate) has no
  character count and fails. The compiler counts a literal `.maxChars(n)` as at
  most 4n bytes when sizing a signal payload.

- **The store gate sees constraints.** At the same version, `aruna contract
  diff` and the `aruna::578` gate now treat a literal `.maxLength(n)` /
  `.maxItems(n)` that was lowered, or added where there was none, as breaking
  (`store-bound-tightened`): records saved under the old bound may be longer.
  Raising or removing one is compatible. Constraints the compiler cannot
  evaluate — `.min()`, `.minLength()`, `.maxChars()`, `.refine()`, a non-literal
  bound — it now records as `constraintsHash` in the schema metadata (a stable
  hash of the chain's source, whitespace ignored, omitted when there is no
  chain); a hash that changed at the same version is a `warning`,
  `store-constraint-changed`: "constraint changed; saved records not verified".

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

- **`wire: "binary"` signals, and a size check for unreliable ones.** The
  binary codec existed but no transport used it, and an unreliable signal
  over Roblox's ~900-byte limit was dropped with no error anywhere.
  `defineSignal({ wire: "binary" })` now sends the payload as an
  `encodeBinary` buffer in both runtimes, byte-identical between them; the
  subscriber decodes before validating, and a frame with another schema's
  fingerprint is dropped like a schema mismatch. The compiler computes the
  largest encoding a payload schema allows (strings need `.maxLength`, arrays
  `.maxItems`; optionals and unions take their largest branch; records are
  unbounded), records it as `maxEncodedBytes` in the manifest, `aruna inspect
  signals`, and the contract snapshot, and checks unreliable signals:
  `aruna::510` warns when the payload is unbounded, `aruna::511` fails the
  build when it can exceed 900 bytes (the binary frame header included).
  `aruna::512` rejects a `wire` that is not the literal `"binary"`, or a binary
  signal without an encodable payload schema. The compiler now records a
  string's `.maxLength` / `.length` and an array's `.maxItems` / `.length` in
  schema metadata (`maxLength`, `maxItems`); other constraints stay
  runtime-only.

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

- **Breaking: contract snapshot version 2.** `aruna.contract.json` now records
  schema constraints (see Added). A version 1 snapshot is still read, as a
  baseline whose constraints are unknown: `contract diff` and the store gate
  compare no constraints against it and say so in an info entry
  (`constraints-not-compared`); `aruna contract update` writes version 2.
  `SchemaMetadata.maxLength` is now the declared byte bound only (a
  `.maxChars(n)` is `maxChars`, no longer folded in as 4n), and
  `constraintsHash` covers only `.refine()` predicates and bounds computed at
  runtime.

- **Breaking: the store gate judges every recorded bound.** At the same
  version, a bound that tightens — `.min()` raised, `.int()` or a `.refine()`
  added, `.maxEntries` lowered, as well as `maxLength`/`maxItems` — is
  `store-bound-tightened` (breaking, so `aruna::578`), where everything but a
  literal `maxLength`/`maxItems` used to be a hash-change warning. A loosened
  bound is compatible and no longer reported; only a changed predicate or a
  computed bound is still `store-constraint-changed`.

- **`aruna inspect contract` summarizes a contract that has warnings.** It used
  to print only the counts whenever there was any diagnostic.

- **Breaking: wire protocol v1.** Every remote fire carries one frame,
  `[1, ...items]`, and every item names its kind in `t`: calls
  `{ t = 1, i, a, d?, k? }`, responses `{ t = 2, i, r }`, signals
  `{ t = 3, s, d? }`; `t = 4` is reserved for resource patches
  (docs/wire-protocol.md). Calls, responses and reliable signals are batched and
  flushed once per frame at `RunService.Heartbeat`, at most 64 items a frame;
  unreliable signals are never batched. The server drops a frame with an unknown
  protocol version or over 64 items whole, before reading an item, charging one
  request and reporting `unknown-protocol-version` / `oversize-batch` through
  `onAbuse`; every item in a frame is charged on its own, and one that is not a
  call is `malformed-envelope`. A client drops such a frame with a Studio
  warning (`onProtocolError`). The unreliable size checks (`aruna::511`/`513`,
  the publisher's) use a 75-byte frame overhead (was 55).
  `RemoteSignalMessage` and `SIGNAL_ENVELOPE_OVERHEAD_BYTES` are gone.

- **Breaking: one ordered reliable channel per player.** Action responses and
  reliable signals now share one RemoteEvent, `ArunaRemoteEvent` (`REMOTE_NAME`),
  and one per-player outbox, so a client reads them in the order the server
  produced them: a signal published inside an action's `run()` is handled before
  that action's response settles, broadcasts included. `ArunaActionRemoteEvent` /
  `ArunaSignalRemoteEvent` and `ACTION_REMOTE_NAME` / `SIGNAL_REMOTE_NAME` are
  gone; calls travel the same remote. The two ends are `ServerChannel`
  (`createServerChannel`) and `ClientChannel` (`createClientChannel`); the
  default wiring shares one per remote, and `createRemoteEventChannel` makes a
  separately batched one over the default remote. Batching options moved from
  the producers to the server channel: `createRemoteSignalPublisher(channel,
  signals, unreliableRemote?)`, `createRemoteSignalSubscriber(channel, signals,
  unreliableRemote?, options?)`, `bindActions(registry, { contractHash?,
  channel? })`, `robloxRemoteEvent({ contractHash?, channel? })`.
  `bindRemoteActions` and `createRemoteActionInvoker` bind a remote of your own.
  `createTestServerApp({ batching: true })` runs the wire as a game does, with a
  `step()` that flushes one frame, so a spec can assert cross-kind order.

- **Breaking: store records use persisted format v1.** `{ "$aruna": 1, v, d, t,
  m?, l? }`: an explicit marker carrying the envelope format version, a
  framework metadata slot `m` (receipt ids, handoff token, erasure marker; never
  validated or migrated), and the lock as `l: { o, h }`. A value without the
  marker is adopted as raw data at version 0, however envelope-like; a newer
  envelope format is refused with `StoreVersionAheadError`. The lock stays in
  the record; an idle document refreshes it only at half the TTL. See
  docs/stores.md, "Persisted format v1". `StoreSnapshot` gains `meta`;
  `readStoreRecord`, `recordStoreReceipt`, `hasStoreReceipt` are new;
  `isStoreLockState` is gone.

- **Breaking: the v1 envelope evolves without a format bump.** The top level is
  closed: an unknown top-level field makes a v1 envelope malformed
  (`StoreValidationError`); it used to be dropped on the next write. `m` is
  open: a key this runtime does not know is written back verbatim (exposed as
  `meta.preserved`), up to 4 KB JSON-encoded (`STORE_MAX_PRESERVED_META_BYTES`;
  over it is `StoreValidationError`, never truncation), unless it starts with
  `!` (`STORE_MUST_UNDERSTAND_PREFIX`), which refuses the record with
  `StoreVersionAheadError` and never writes it back, including from a player
  store that holds the lock. Receipt ids are must-understand and move from
  `m.r` to `m["!r"]`; `m.h` and `m.e` stay may-ignore. docs/stores.md, "How the
  format evolves".

- **Pre-release policy.** Until the first public release, breaking changes need
  no deprecation, shim, or migration notes, and the API report is a review aid
  rather than a gate (docs/stability.md). Diagnostic codes are still never
  reused.

- **One-shot `check`, `build`, and `inspect` are ~3× faster** (about 800 → 240 ms
  at 3,000 files): module classification compiled each convention's glob set
  again for every file it matched.

- **Breaking: the `aruna/*` runtime subpaths are type-only, and their types are
  the native runtime's.** `aruna/server`, `aruna/client`, `aruna/roblox`,
  `aruna/schema`, and `aruna/testing` used to resolve, without the doctor
  aliases, to a separate Node implementation of the runtime and its
  declarations — which differed from the native runtime a game compiles (the
  run context was `ActionRunContext` instead of `ActionContext`, errors were
  classes, `aruna/schema` exported 46 names instead of 12). They now carry only
  `types`, emitted from the native runtime (`dist/native/`), so an editor
  without the aliases sees exactly what `rbxtsc` compiles against. Importing
  them from Node fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`; a roblox-ts build
  is unaffected, since it always compiled the vendored copy.

  Migration: code that only type-checked against the Node declarations now
  reports the errors `rbxtsc` already reported. The usual ones are
  `ActionRunContext` → `ActionContext`, `instanceof ActionValidationError` (and
  the other error classes) → compare `err.name`, `validateSchema(s, v)` →
  `s.validate(v)` / `firstSchemaIssue(s, v)`, and `getActionRemote` /
  `ensureActionRemote` / `waitForActionRemote` → `createActionInvoker` /
  `robloxRemoteEvent`, which find or create the remote themselves.

- **`encodeBinary`, `decodeBinary`, and `schemaFingerprint` are exported from
  `aruna/schema`**, working on a Luau `buffer` in-game. They replace the root
  `aruna` export (see Removed).

- **`createRemoteSignalPublisher` / `createRemoteSignalSubscriber` are exported
  from `aruna/roblox`**, as docs/signals.md already said — the lower-level
  endpoints over a remote you supply. `SignalMap` is exported from
  `aruna/server`.

- **Breaking: string length constraints count UTF-8 bytes in both runtimes.**
  `maxLength`, `minLength`, and `length` counted UTF-16 code units in Node
  (`value.length`) and bytes natively (`#value`), so `"가나다"` was 3 in a spec and
  9 in the game, and a Korean name that passed every Node test failed in
  production. The compiler's size bound and the binary codec already counted
  bytes. Node now counts UTF-8 bytes too, and the failure message says so:
  `expected length <= 16 bytes` (was `expected length <= 16`), in both runtimes.

  **Migration:** ASCII strings are unaffected. A limit meant for people
  (characters on screen) should become `.maxChars(n)` / `.minChars(n)`; a limit
  meant as a size budget can stay `.maxLength(n)`, but check the number — it is
  now bytes in Node as well, so a Korean or emoji value takes 3–4 per character.
  Tests that match the old message text need the ` bytes` suffix.

- **Breaking: `aruna contract update` refuses a store change saved records
  cannot survive.** It used to write the snapshot unconditionally, and
  `aruna::578` told you to run it "once the change is intended" — advice that,
  followed, shipped exactly the failure the gate exists to prevent: intending a
  change does not make the old records readable. `contract update` now diffs
  the committed snapshot against the code first and, when a `store-*` change is
  breaking, lists the changes and exits 1 without writing. It writes anyway only
  with `--accept-unreadable-records`, and prints a warning naming every record
  change it accepted. An unreadable snapshot file is refused the same way (there
  is nothing to compare against; restore it). The `aruna::578` suggestion now
  names the only two fixes — a `.default(...)`, or a version bump with a
  `migrate()` — and no longer mentions `contract update`.

  **Migration:** if a script runs `aruna contract update` after a store change
  that is breaking on purpose, add `--accept-unreadable-records`.

- **`aruna contract update --check`.** Writes nothing; exits 1 when the
  committed snapshot is missing, unreadable, or differs from what `contract
  update` would write (whitespace aside), and says whether `update` would
  refuse the difference. `docs/cli.md` has a CI recipe.

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

- **Breaking: an Instance crosses the action boundary only where the schema
  says `schema.instance()`.** The native wire-safety check accepted any
  Instance anywhere, although its own comment and the README said Instances
  were rejected; the Node runtime rejected every Instance, even where the
  schema asked for one. Both now walk the value against its schema (input,
  output, or signal payload) and accept an Instance — a `Player` included —
  only where that schema declares `schema.instance()`. An action with no input
  schema, or a field the schema does not declare, rejects one as
  `ActionSerializationError`; an action that does declare `schema.instance()`
  now works in the Node runtime too.

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

### Removed

- **Compatibility-only code.** `aruna build --emit-runtime` (vendoring is the
  default; `--no-emit-runtime` remains); the dedicated messages for a flat
  (pre-`defineConfig`) config and for `rateLimit.limit` (both now get the
  generic unsupported-field diagnostic); pruning of the flat codegen layout's
  leftovers and `aruna::110 stale-generated-artifact` (retired, never reused);
  the native compiler's one-shot `checkProject`/`inspectProject` exports (every
  check goes through a `CompilerSession`).

- **Breaking: the Node runtime.** The package carried two implementations of
  the runtime: the roblox-ts one games compile, and a Node one under
  `packages/aruna/src` that no consumer's game ever ran. Every feature was paid
  for twice and kept in step by a conformance table. The Node one is gone; its
  test suites were ported to specs that run the native runtime under Lune
  (`apps/roblox-runtime-test`), case by case — the mapping is in
  `docs/runtime-consolidation.md`.

  Where the two had drifted, the native behavior — what games already ran — is
  the one kept, so no game changes behavior. Things only the Node runtime did,
  which therefore disappear from the package: error objects carrying
  `actionId` / `role` / `max` / `windowMs` / `timeoutMs` / `expected` /
  `actual` / `cause` (native rejections carry `name`, `message`, and
  `retryAfterMs` / `resetAtMs` / `errorId` where they apply), per-violation
  wire-safety paths (the native boundary reports `non-serializable action
  input`), `invokeAction` rejecting rather than throwing when no invoker is
  installed, transports returning a cleanup function or a disposable instead
  of `{ disconnect }`, and an invoker `dispose()`. Schema issue wording follows
  the native runtime (`expected literal sword`, `expected one of a | b`), and
  `aruna/testing` follows Luau truthiness in `toBeTruthy` / `toBeFalsy` and
  joins test names with `" > "`.

- **Breaking: `encodeBinary`, `decodeBinary`, and `schemaFingerprint` on the
  root `aruna` entry.** They were the Node codec over `Uint8Array`. Use them
  from `aruna/schema` in-game. The root entry is now `defineConfig` and the
  compiler only.

- **The structural Node transport API**: `createRemoteEventActionInvoker`,
  `bindRemoteEventActions`, the `RemoteEvent*Like` / `RemoteSignal*Like`
  types, `TimeoutError`, `dispatchAction`, `createActionRateLimiter`,
  `validateSerializableActionValue`, `assertSchema`, and the in-memory invoker.
  They ran Aruna over a non-Roblox event emitter, which nothing supported
  outside this repo's own tests.

### Fixed

- **A late envelope no longer brings a departed player's state back.** Leave
  dropped the player's request budget and idempotency keys, but an envelope
  Roblox delivered after `PlayerRemoving` created them again, and nothing
  dropped them a second time: the state, and the Player it was keyed by, stayed
  for the life of the server. Leave now also marks the player departed. While
  marked, the transport drops their envelopes (silently, without `onAbuse`: a
  late envelope is not abuse), the guard creates no budget or in-flight count,
  and the idempotency cache runs a call without remembering it. The mark is
  cleared when the player joins again or after 30 seconds
  (`DEPARTED_PLAYER_TTL_MS`), and expired marks are swept on every join and
  leave, so the set itself never pins a player for long. A server app with a
  players source now always subscribes to `PlayerAdded` to clear it, and the
  native `ActionRegistry` gains `readmitPlayer`, which `createServerApp` calls on
  join. A departed set was chosen over weak-keyed tables: a Luau weak key is not
  collected while its value (an in-flight call's closure) still references the
  player, and weak keys would only bound how long the state lasts, not stop it
  coming back.

- **`app.dispatch` is no longer refused by the in-flight cap.** The cap
  (`requestBudget.maxInFlight`, 32) is for a client's envelopes, but
  `app.dispatch` went through the same path, so trusted server code and specs
  running more than 32 calls for one player at once got `ActionRateLimitError`.
  Only the transport applies it now: the `ActionRegistry` gains
  `dispatchInProcess`, which `app.dispatch` uses, while `dispatch` stays the
  transport's capped entry. Idempotency, validation,
  rate limits, and middleware are unchanged for both. The test harness's
  `invoke` and `client` go through `app.dispatch`, so they are exempt too.

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

- **Unreliable size checks count the `{ signalId, payload }` envelope.** The
  message Roblox measures against its ~900-byte limit is the whole envelope,
  but `aruna::511` compared only the payload, so a payload just under the limit
  passed the check and was dropped in the game. The compared size now adds the
  signal id's bytes and a 55-byte envelope allowance (the two key strings plus
  8 bytes for each of the table's five values; the estimate is documented in
  `docs/signals.md`). New warning `aruna::513
  unreliable-signal-payload-near-limit`: a table-encoded unreliable signal
  whose size floor plus envelope is over 75% of the limit, since its real size
  is larger by an amount the compiler cannot know; it recommends
  `wire: "binary"`. And at runtime the publisher measures a
  binary unreliable frame plus the envelope before firing and throws (the
  `aruna::511` message shape) instead of sending one that would be dropped —
  the case the compiler cannot see, an unbounded schema (`aruna::510`).

- **The wire-safety walk stays inside its node budget through unions.** To
  decide whether an Instance was allowed, the walk narrowed a union by calling
  each member's `validate` on the value — a full, unbudgeted walk of the
  subtree, repeated at every nested union, before the 2048-value budget or the
  real validation ran. A client could send a union-typed field holding a huge
  table and have it walked anyway, quadratically for nested unions. The walk now
  carries the set of candidate schemas at each position (a union contributes all
  its members; optional and default unwrap) and never validates. An Instance is
  accepted where any candidate there is `schema.instance()`, and the validation
  that follows still enforces the exact shape.

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
