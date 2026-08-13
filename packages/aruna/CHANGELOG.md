# Changelog

All notable changes to the `aruna` package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
