# Changelog

All notable changes to the `aruna` package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

These changes close gaps found by dogfooding Aruna from a downstream consumer.
This is a pre-1.0 release: the renamed/removed symbols below are a hard break,
not a deprecation cycle — migrate call sites to the canonical names.

### Added

- **`aruna build --watch` — the build loop is now automatic.** The CLI stays
  running and re-runs the full build (stub generation, runtime vendoring, rbxtsc)
  whenever project source changes, removing the stale-stub footgun of forgetting
  to rebuild after an action/signal edit. Save bursts debounce into one rebuild, a
  change landing mid-build queues exactly one follow-up, and the build's own
  output trees (generated dir, `out/`, `include/`) never re-trigger it.

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
