# Package Consumption Notes

Aruna has two package-consumption checks today:

- `apps/package-consumption-harness` validates the workspace-linked package shape quickly.
- `pnpm verify:package-consumption` builds local tarballs and tries to install them in a standalone consumer.

## Current smoke status

The packed smoke now installs local tarballs for `aruna`, `@arunajs/core`, and `@arunajs/compiler` without registry fallback.
It runs `aruna doctor --fix`, `aruna check`, `aruna build`, `aruna inspect actions`, `aruna inspect contract --json`, and `tsc -p tsconfig.typecheck.json --noEmit` successfully.

Latest retained-temp project:

- temp root: `/private/var/folders/v5/hzcgp7rn3m9051w47880v3180000gn/T/package-consumption-smoke`
- `tsconfig.json`: `rootDir: "src"`, `include: ["src/**/*.ts", "src/**/*.tsx"]`, `exclude` includes `aruna.config.ts`
- `tsconfig.typecheck.json`: `rootDir: "."`, `include` includes `aruna.config.ts`
- `default.project.json`: package-style `node_modules/aruna` mount remains in `rbxts_include`
- `node_modules/aruna/package.json`: public subpaths point at root shims such as `client.js`, `server.js`, `schema.js`, `roblox-runtime.js`, `client-runtime.js`, `server-app.js`, `runtime.js`, and `server-runtime.js`
- `node_modules/aruna` tree: root subpath shims are present alongside `package.json`

`rbxtsc` still fails, but the failure is now isolated:

- roblox-ts rejects the direct `node_modules` package modules for `aruna/server` and `aruna/schema`
- the temp Rojo tree still does not cover `out/domains/shop/model.luau` emitted from `src/domains/shop/model.ts`

Current `rbxtsc` log summary:

> rbxtsc rejected direct package imports from node_modules.
> rbxtsc could not map emitted files to the current Rojo project tree.

## Current conclusion

The packed smoke no longer fails because of `aruna.config.ts` leaking into the rbxtsc project or because public Aruna subpaths are missing from the packed tarball.
The remaining blocker is a rbxtsc package-layout boundary: either Aruna needs a runtime-only package or layout shim for Roblox-facing imports, or the temp consumer needs a compiler-friendly split that does not rely on direct `node_modules` package modules.
