# Troubleshooting

Start with `aruna doctor`. It reports the project, tsconfig, aliases, Rojo project and
toolchain in one pass and says when a fix is available; `aruna doctor --fix` applies the
tsconfig and alias fixes it can make safely.

```bash
npx aruna doctor
npx aruna doctor --fix
```

For a compiler diagnostic (`aruna::NNN`), see [diagnostics.md](./diagnostics.md).
The rest of this page goes by the message you see: problems installing and building
first, then problems in the running game.

## "Aruna native compiler is not available for <platform>/<arch>"

The compiler core is a native binary, and there is no TypeScript fallback. The message lists
the platforms a prebuilt binary exists for: macOS arm64 and x64, Linux x64 and arm64 (glibc
and musl), and Windows x64 and arm64. On any other platform (32-bit Windows, FreeBSD, …)
Aruna does not run.

## "Aruna native compiler could not be loaded for <platform>/<arch>"

Your platform is supported, but the binary for it was not installed or would not load. The
message names the package it expected (`@arunajs/compiler-<target>`) and every path it
tried. The binary comes as an optional dependency, so it goes missing when optional
dependencies are skipped:

- an install with `--omit=optional` / `--no-optional`, or `optional=false` in `.npmrc`;
- a lockfile written on another OS or CPU that never recorded this platform's package
  (common when a lockfile from a Mac is installed on Linux CI);
- pnpm's `supportedArchitectures` set to exclude this platform.

Fix: check it is there with `npm ls @arunajs/compiler-<target>` (the target is in the
message). If it is missing, reinstall with optional dependencies allowed. If the lockfile is
the cause, delete `node_modules` and the lockfile and install again on any machine, then
commit the new lockfile.

## "Loaded native compiler module did not expose CompilerSession, …"

A native binary loaded, but it belongs to a different Aruna release than the JavaScript
that loaded it. Every `@arunajs/*` package is published at one version, and
`@arunajs/compiler` depends on its native package at exactly that version, so this
happens only when the versions were mixed: a package installed separately at another
version, a `node_modules` left over from an older install, or an override in
`package.json`.

Fix: `npm ls @arunajs/compiler @arunajs/compiler-<target>` shows the versions. Remove any
override or separate install, then reinstall so all of them match `@arunajs/aruna`.

## `EINTEGRITY` or a checksum error while installing

The package manager found that a downloaded package does not match the hash in your
lockfile. npm never lets a published version change, so the package itself did not
change. The cause is local: a corrupted cache, or a lockfile written against another
registry or mirror.

Fix: run `npm cache verify` (or `pnpm store prune`) and install again. If the lockfile came
from another registry, point the install at that registry, or remove `node_modules` and the
lockfile and install from scratch, then commit the new lockfile.

## TypeScript version warning from `aruna doctor`

```
warning: typescript 5.9.3 does not match the =5.5.3 roblox-ts 3.0.0 pins — rbxtsc can fail
with confusing errors. Pin "typescript": "=5.5.3" in devDependencies.
```

roblox-ts compiles with the TypeScript version it pins. Another version usually still
type-checks in your editor, then `rbxtsc` fails with errors that do not point at the cause.
Pin the version the warning names in `devDependencies` and reinstall.

## "rbxtsc not found in node_modules/.bin"

`aruna build` type-checks and generates code, then runs `rbxtsc` to emit Luau. Install
roblox-ts in the project (`npm install -D roblox-ts`). To build without the Luau step on
purpose, pass `--no-emit-luau`.

## The built place is empty, or a module is missing at runtime

```
default.project.json does not mount out/server, out/client.
```

`aruna build` writes Luau into `out/client`, `out/server` and `out/shared`, so server code
lands in `ServerScriptService` and is never replicated. A Rojo project that does not mount
those folders builds without error and produces a place without your code. This is the usual
state after adding Aruna to an existing Rojo project.

Fix: `aruna init --force` replaces the project file with the Aruna layout. To keep your own
file, mount `out/server` → `ServerScriptService`, `out/client` → `StarterPlayerScripts`,
and `out/shared` plus `include` → `ReplicatedStorage`; `aruna doctor` shows what is missing.

## `$aruna/...` imports do not resolve

The `$aruna/actions/client`, `$aruna/actions/server`, `$aruna/signals` and
`$aruna/resources/*` modules are generated, and tsconfig path aliases point at them.
`aruna build` creates both. If the editor still cannot resolve them, run `aruna doctor --fix`
to rewrite the aliases.

`aruna check` reports `aruna::111` (layout desync) when an alias points somewhere the
current layout does not emit, usually after upgrading Aruna. Run `aruna doctor --fix`, then
`aruna build`.

## "lune was not found on PATH" from `aruna test`

`aruna test` compiles specs to Luau and runs them under [Lune](https://lune-org.github.io).
Install it with `rokit add lune-org/lune` (a `create-aruna-app` project already lists it in
`rokit.toml`; run `rokit install`).

## Studio does not pick up changes

`aruna dev` rebuilds on save and runs `rojo serve`. Connect the Rojo plugin in Studio to the
port it prints. If nothing syncs, check that the plugin and the `rojo` CLI are compatible
versions, and that `aruna doctor` reports the Rojo project as `ok`.

## `Infinite yield possible on 'ReplicatedStorage:WaitForChild("ArunaRemoteEvent")'`

The client is waiting for the server to create Aruna's remote, and the server never did.
The server creates it when it binds its transport, in `createServerApp({ transport:
robloxRemoteEvent() })`. Check that the server script runs (it is in `out/server`, which
Rojo mounts into `ServerScriptService`), that it creates the app, and that nothing before
that line errors. The server's output shows the error if one did.

## "Aruna action \<id\> timed out after 10000ms." (`ActionTimeoutError`)

No response arrived within the request timeout (10 seconds by default). Either the
action's `run` took longer than that, because it waited on a DataStore call or a
`WaitForChild`, or the server stopped answering because its app was disposed. The call may
still have run on the server, so calling it again can run it twice.

Fix: make slow work faster, or raise the timeout for the client
(`createClientApp({ requestTimeoutMs })`). To retry timeouts automatically, set
`createClientApp({ retry })` and declare the action `idempotent: true`, but only if running
it twice is safe ([Retries and idempotency](./actions.md#retries-and-idempotency)).

## `ActionInternalError` with message "internal error"

The action threw something that is not a public error, so the server hid it from the
client ([Errors the client sees](./actions.md#errors-the-client-sees)). The error carries
an `errorId`, and the server's `onError` received the original error with the same id. Log
it there (`createServerApp({ onError })`) and match the ids. While developing,
`createServerApp({ exposeInternalErrors: true })` sends the real error to the client.

## `ActionRateLimitError` during normal play

The call went over its rate limit. Without a `rateLimit` of its own, an action uses
`actions.defaultRateLimit` from the config: 20 calls per player per second. An action a
client calls every frame, or in a burst, needs its own limit. `aruna inspect network` lists
the limit each action ends up with ([Rate limiting](./actions.md#rate-limiting)).

## "Aruna contract mismatch: client \<hash\> vs server \<hash\>." (`ActionVersionMismatchError`)

The client was built from different action and signal definitions than the server it
joined, and it was created with `rejectOnMismatch`. This usually means a stale place: the
client and server parts come from two builds, or a server from the previous deploy is
still running. Rebuild and publish both together. See
[Detecting a client built for another server](./actions.md#detecting-a-client-built-for-another-server).

## 'Aruna store "\<id\>" is running on an in-memory backend: …'

Studio cannot reach DataStores, so the store keeps data in memory for this playtest and
nothing is saved. Publish the place, then turn on **Game Settings → Security → Enable
Studio Access to API Services**. To make the missing access an error instead, see
[Studio without API access](./stores.md#studio-without-api-access).

## "Store \<id\> key \<key\> is locked by another server" (`StoreLockedError`)

A player's data is still held by the server they just left. This happens on a quick
rejoin or teleport, before the old server has released the record. The load retries
(`session.acquireAttempts`, 5 by default). If the old server crashed and never releases
the record, its lock expires after `session.lockTtlMs` (2 minutes by default), and a new
load succeeds after that. Do not hand the player a default document while the load fails:
that is how a save gets overwritten
([Player stores and the session lock](./stores.md#player-stores-and-the-session-lock)).
