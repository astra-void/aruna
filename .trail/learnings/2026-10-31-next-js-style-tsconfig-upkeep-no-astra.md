---
title: "Next.js-style tsconfig upkeep, no baseUrl"
author: Astra-void
date: 2026-10-31
branch: prerelease/v1-formats
cost: { minutes: 1, tokens: 6936 }
touches:
  - packages/aruna/src/cli/tsconfig-setup.ts
  - packages/aruna/src/cli/jsonc-edit.ts
  - packages/aruna/src/cli/tsconfig-paths.ts
  - packages/aruna/src/cli/cli.ts
  - packages/aruna/src/cli/doctor.ts
  - packages/aruna/src/cli/init.ts
  - packages/aruna/src/cli/owned-artifacts.ts
  - packages/aruna/src/cli/rojo-layout.ts
  - packages/compiler/src/index.ts
  - packages/aruna/test/compiler-output-guard.test.ts
---

## Decided
- tsconfig wiring is a Next.js-style upkeep (`packages/aruna/src/cli/tsconfig-setup.ts`): `init`, `build`, `dev`, `test` and `doctor --fix` edit the project's own tsconfig.json in place before compiling and print what changed; `check` and plain `doctor` only report (aruna::111). Mandatory (forced) = what roblox-ts 3.0's validateCompilerOptions enforces (noLib, strict, module CommonJS, moduleResolution Node10, moduleDetection force, allowSyntheticDefaultImports, typeRoots containing node_modules/@rbxts) plus target ESNext, verbatimModuleSyntax not true, the 8 `$aruna/*`/`aruna/*` aliases, and the dot-folder generatedDir in `include`. Suggested defaults are added only when the key is unset. Anything a base config supplies through `extends` counts as set.
- No `baseUrl` anywhere Aruna writes (upkeep, staged rbxtsc tsconfig, harnesses): alias targets are "./"-relative, because TS5090 rejects non-relative targets without a baseUrl. A project's own baseUrl is kept, and aliases are written relative to it (draw-a-tower uses `baseUrl: "src"`).
- The generated `<generatedDir>/tsconfig.aruna.json` fragment is retired: the build ledger prunes it, the upkeep drops a leftover `extends` of it, and aruna::112 is retired (listed in diagnostics.rs).
- Edits go through `jsonc-edit.ts`, a minimal-diff editor over jsonc-parser's tree. New keys go under the last one with its indent and the file's trailing-comma style, plain arrays stay inline, and an inline object opens up with its entries kept as written. It falls back to jsonc-parser `modify` only for odd layouts.
- Compiler: with no baseUrl, `paths` targets are anchored at TypeScript's internal `pathsBasePath` in `normalizeTsconfigOptions` (packages/compiler/src/index.ts). Without that, an inherited paths block resolved against the project root instead of the config that declares it.

## Tried and ruled out
- Keeping the fragment and only auto-adding the `extends`: the fragment lives in the gitignored generatedDir, so a fresh clone opens with a dangling extends (no noLib, no @rbxts types) until the first build, and a `paths` block in tsconfig.json itself (Next's `@/*`) replaces the fragment's aliases wholesale.
- jsonc-parser `modify` with formattingOptions for every edit: `withFormatting` forces keepLines:false and reformats the whole line around an insert or remove, so a neighbour's inline array gets expanded. Next.js's own approach (comment-json full re-stringify) re-indents the whole file.

## Watch out
- jsonc-parser `applyEdits` sorts edits by offset, so two zero-length inserts at the same offset apply in the wrong order. Send one combined edit instead.
- Only suggest `types: ["@rbxts/types", ...]` when ./node_modules itself is a type root. Under the classic `node_modules/@rbxts` type root, rbxtsc checks `types` entries against typeRoots and would not find `@rbxts/types`.
- The golden guard now also captures files `build` rewrites (tsconfig.json), not only new ones. Most fixtures start from `{}`, so each golden carries a full reconfigured tsconfig.
- The watch loop remembers the tsconfig.json contents it last wrote, so its own write does not trigger a rebuild.
