# Before you ship

A checklist for taking an Aruna game live. Each item is short and links to the page that
explains it. Most of it is about what Aruna does **not** do for you.

## Actions

- **Every registered action can be called by any client**, with any input that passes its
  schema. Check who may call it in `authorize(ctx, input)`
  ([authorize](./actions.md#authorize)). Check what the input is allowed to do (price,
  ownership, cooldowns) in `run`: a schema checks shape, not game rules
  ([What the schema does not check](./actions.md#what-the-schema-does-not-check)).
- **Rate limits.** An action without its own `rateLimit` gets `actions.defaultRateLimit`,
  20 calls per player per second unless you change it. Set a tighter limit on anything
  expensive, and run `aruna inspect network` to see what each action ends up with
  ([Rate limiting](./actions.md#rate-limiting)).
- **Errors.** The client sees only public errors; anything else becomes
  `ActionInternalError` with an `errorId`. Log the original in `createServerApp({ onError })`
  so a player's report can be matched to the server log, and do not ship with
  `exposeInternalErrors: true` ([Errors the client sees](./actions.md#errors-the-client-sees)).
- **Retries.** A timed-out call may have run. Declare `idempotent: true` only on actions
  that are safe to run twice ([Retries and idempotency](./actions.md#retries-and-idempotency)).

## Stores

- **A failed load is not a new player.** Never hand out a default document when a load
  fails; that is how a save file gets overwritten. Gate actions that need data with
  `requireStores` ([Readiness](./stores.md#readiness)).
- **DataStore budget.** Heartbeats and saves spend DataStore requests on every player.
  Check the cost table for your player count and raise `heartbeatMs` if it is too high
  ([Where the session lock lives](./stores.md#where-the-session-lock-lives)).
- **A crashed server holds its players' data until the lock expires** (`lockTtlMs`, 2
  minutes by default). Until then those players cannot load on another server.
- **Not implemented yet:** purchase receipts (`ProcessReceipt`) and a teleport handoff.
  Handle developer product purchases yourself. A teleported player's load waits for the
  old server to release the record ([Persisted format v1](./stores.md#persisted-format-v1)).
- **Studio.** Without API access a playtest runs on an in-memory store and saves nothing
  ([Studio without API access](./stores.md#studio-without-api-access)).

## Contracts and deploys

- **Commit the contract snapshot** (`aruna.contract.json`) and check it in CI, so a store
  change that would leave saved records unreadable fails the build instead of failing
  player loads ([The store compatibility gate](./cli.md#the-store-compatibility-gate)).
- **Run `aruna contract diff`** before a release to see breaking changes to actions,
  signals, stores and resources ([Contract changes](./actions.md#contract-changes)).
- **Old servers keep running after a publish.** Pass the generated `contractHash` to both
  sides so a client can detect a server from another build
  ([Detecting a client built for another server](./actions.md#detecting-a-client-built-for-another-server)).

## Resources and signals

- **Resource loads time out** after `loadTimeoutMs` (30 seconds by default), so a hung
  load cannot block a resource forever ([Load timeouts](./resources.md#load-timeouts)).
- **What resources guarantee, and what they do not**, such as delivery to a player who
  left ([Guarantees](./resources.md#guarantees-and-what-is-not-guaranteed)).
- **Unreliable signals can be dropped and arrive out of order**, and Roblox caps their
  payload at about 900 bytes. Use them only for data a newer message replaces
  ([Unreliable signals](./signals.md#unreliable-signals)).

## What the tools cannot see

- **Shared safety is static.** The compiler does not follow dynamic requires or read
  service names stored in variables. Passing it is evidence, not proof
  ([What a static check cannot see](./shared-safety.md#what-a-static-check-cannot-see)).
- **Metrics are per Luau VM.** `createNetworkMetrics()` counts what one server, or one
  client, sees. Aggregate across servers yourself ([Observability](./observability.md)).

If something fails in the live game, start with [troubleshooting](./troubleshooting.md).
