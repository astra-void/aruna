# Troubleshooting

Start with `aruna doctor`. It reports the project, tsconfig, aliases, Rojo project and
toolchain in one pass and says when a fix is available; `aruna doctor --fix` applies the
tsconfig and alias fixes it can make safely.

```bash
npx aruna doctor
npx aruna doctor --fix
```

The rest of this page goes by the message you see.

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
