# Setup DX Plan — codegen-owned project wiring

Status: Implemented (all phases). Companion to [create-app-plan.md](create-app-plan.md); this
doc defines the setup/everyday-DX contract the scaffolding targets. Phases A/B landed with
the recommended-layout conventions + generated entries rounds; Phase C is `aruna dev`
(watch build + rojo serve child, `dev.rojo` config); Phase D is `aruna add domain` and the
`create-aruna-app` package (scaffold → install → `aruna init` → `aruna add domain shop --with ui`
→ `aruna build`, so a new project builds green in one command). `aruna doctor` also gained
the roblox-ts ↔ typescript version-skew check.

## Problem statement

Setting up and living with an Aruna rbxts game is manual in exactly the places where
Aruna already has perfect information (the manifest, the config, the owned-file ledger).

Initial setup today:

1. `package.json` is hand-written — the pinned dependency matrix (`roblox-ts`,
   `typescript`, `@rbxts/types`, `@rbxts/compiler-types`, `aruna`) and scripts are not
   scaffolded by anything.
2. `aruna init` covers only `aruna.config.ts`, `tsconfig.json`, `default.project.json`.
   No `src/` starter, no `.gitignore`, no rokit/rojo tooling, no example domain.
3. `src/server.ts` / `src/client.tsx` bootstrap is hand-written boilerplate
   (`createServerApp` + registry import + transport; `createClientApp` + invoker) even
   though every input to that wiring is already in the manifest and config.
4. The default conventions (`**/client/**`, `**/server/**`, `**/shared/**`) do not match
   the Recommended Layout v0 (`domains/**/actions.ts` etc.), so every real project
   restates 8+ globs in `aruna.config.ts` — the in-repo harness included.
5. First-build ordering is folklore: tsconfig aliases point at files that only exist
   after `aruna build --emit-runtime`, so a fresh checkout needs the
   `doctor --fix --emit-runtime` → `build` dance in the right order.

Everyday friction today:

1. tsconfig alias drift. Aliases are only written by `doctor --fix`; `build` merely
   diagnoses (aruna::110/111). **Observed in-repo:** `apps/rbxts-harness/tsconfig.json`
   still carries pre-split-tree flat aliases while the generated files live under
   `server/` + `shared/` — and `aruna build` passes silently anyway (imports likely
   fall back to node_modules resolution). The framework's own harness drifted and
   nothing noticed.
2. A new domain is 3–4 hand-created files, and a file that misses the convention globs
   is misclassified with no scaffolding help.
3. Any wiring change (add a signal publisher, middleware, request-id policy) means
   editing bootstrap entries by hand.
4. The dev loop is multi-terminal: `aruna build --watch` and `rojo serve` are separate
   processes the user has to know about and start.

## Design principle

> If a file must stay in sync with codegen output, codegen must own that file.

Aruna already owns generated stubs, the vendored runtime, the manifest, and (via the
`.aruna-build.json` ledger) stale-artifact pruning. This plan extends ownership one
level up — from generated *code* to generated *project wiring* — and then collapses
the remaining setup into two commands: `create aruna` (once) and `aruna dev` (daily).

## Pillar 1 — Recommended-layout defaults (zero-config conventions)

Bake Recommended Layout v0 (init-spec) into `DEFAULT_CONVENTIONS` in
`packages/compiler/src/config.ts`, merged with the existing folder rules:

```
client: src/client.tsx, **/ui.tsx, **/client/**
server: src/server.ts, **/actions.ts, **/runtime.ts, **/server/**
shared: src/shared/**, src/app/**, **/schema.ts, **/model.ts, **/shared/**
```

- `aruna.config.ts` becomes optional for the standard layout; `conventions` is only for
  overrides (user globs still win over defaults, as merge order already allows).
- `aruna init` stops emitting a conventions block; the scaffolded config shrinks to
  near-empty.
- Guardrails stay: unclassified-module diagnostics remain, and
  `aruna inspect modules` keeps showing which pattern matched (`classification.source`
  distinguishes default-convention vs config).

Risk: filename rules like `**/runtime.ts` can false-positive in unusual layouts.
Mitigation: config overrides win, classification reasons are inspectable, and a
`conventions: { defaults: false }` escape hatch disables the built-in set.

## Pillar 2 — Generated wiring files (kill the drift class)

### tsconfig

`aruna build` (and `init`) emits `src/.aruna/tsconfig.aruna.json` — a ledger-owned,
deterministic fragment holding `baseUrl`-relative `paths` for `$aruna/*` and the
vendored `aruna/*` runtime aliases. The user tsconfig references it once:

```jsonc
{ "extends": "./src/.aruna/tsconfig.aruna.json", ... }
```

- TS `extends` semantics: child `paths` replaces parent wholesale, so if a user defines
  their own `paths`, aliases are shadowed. New diagnostic `aruna::112
  tsconfig-paths-shadow-generated` (doctor + build) catches this; the fix is to move
  user paths into the fragment via config (`compiler.extraPaths`) or accept ownership.
- `doctor --fix` gains a migration: rewrite an inline-alias tsconfig to the extends
  form and delete the inline aliases. aruna::110/111 remain for projects that opt out.
- Layout changes (like the flat → split-tree move) become invisible: the fragment is
  regenerated with the layout, and no user file mentions generated paths again.

### Rojo

`default.project.json` gains explicit ownership semantics: while it carries an
`"$aruna": { "generated": true }` marker (or a ledger entry), `aruna build` regenerates
it from `partitionedRojoProject()` whenever the partition contract changes. Deleting
the marker hands the file to the user permanently; doctor then only validates the
contract (out/server → ServerScriptService etc.) instead of the full shape.

## Pillar 3 — Generated entries (`main.server.ts` / `main.client.ts`)

This is the codegen centerpiece: the app bootstrap is *derived from the manifest*, not
hand-wired.

Codegen emits (into the split tree, ledger-owned):

- `src/.aruna/server/main.server.ts` — imports the generated registry +
  `defaultRateLimit`, constructs `createServerApp<Player>` with `robloxRemoteEvent()`,
  wires `createSignalPublisher` iff the manifest contains signals.
- `src/.aruna/client/main.client.ts` — `createClientApp` + `createActionInvoker`,
  wires the signal subscriber iff signals exist.

User customization moves to convention-discovered hook modules, statically imported by
the generated mains (manifest-driven conditional imports — no runtime scanning, fully
deterministic):

```ts
// src/server.ts — optional; all exports optional
export const middleware = [ ... ];
export const onError = (ctx, err) => { ... };
export function configure(app: ServerApp) { ... }  // last-mile escape hatch
```

```ts
// src/client.ts(x) — optional
export const createRequestId = () => ...;
export function onStart(app: ClientApp) { ... }
```

Consequences:

- The `.server`/`.client` suffix on the generated mains makes rbxtsc emit the real
  `Script` / `LocalScript`; user entries become plain ModuleScripts. This matches the
  init-spec rule that only explicit runtime entries become script instances, and it
  removes side-effectful user entry files entirely.
- `rojo-layout.ts` gains a `client/` partition subtree in generatedDir (today only
  `server/` + `shared/` exist) mapping to StarterPlayerScripts.
- Migration: `entries: "user"` in config keeps the current model (user-owned
  `server.ts`/`client.tsx` as entries, no generated mains). New projects default to
  `entries: "generated"`.
- A hook module with a wrong-shaped export is a compile-time diagnostic
  (aruna::5xx range), not a runtime surprise — the compiler already parses these files.

## Pillar 4 — `create aruna` (one-command initial setup)

`npm create aruna-app@latest my-game` (package: `create-aruna-app`) scaffolds the full project
per [create-app-plan.md](create-app-plan.md):

- `package.json` with the *framework-owned pinned matrix* (`roblox-ts`, `typescript`,
  `@rbxts/types`, `@rbxts/compiler-types`) — the known-good versions ship with the
  template, and `aruna doctor` gains a version-skew check (roblox-ts ↔ typescript
  pinning is the classic rbxts trap).
- Starter source: one example domain (`domains/shop/{schema,model,actions,ui}`),
  `src/shared/`, optional hook stubs. No entry boilerplate — Pillar 3 owns entries.
- `.gitignore` (with an explicit stance: `src/.aruna/` is regenerable; committed or
  ignored both work because the ledger prunes and build regenerates), `rokit.toml`
  for rojo, VS Code settings.
- Post-scaffold it runs install + `aruna build --emit-runtime`, so the project
  typechecks green before the user opens it. No doctor dance, no ordering folklore.

`aruna init` remains the adopt-into-existing-project path and is updated to scaffold
the Pillar 2 extends-style tsconfig and the near-empty config.

## Pillar 5 — `aruna dev` (one-command daily loop)

One terminal:

```
aruna dev
  = build --watch (exists)            # codegen + rbxtsc per change, ledger prune
  + rojo serve (spawned child)        # when default.project.json exists
```

- Config: `dev: { rojo: true | false | { port } }`.
- Watch filtering already excludes generated/emitted trees, so the loop is stable.
- Later (out of scope here): Studio overlay / runtime monitor per init-spec.

## Pillar 6 — `aruna add` (generators)

`aruna add domain shop [--with ui,runtime]` scaffolds
`src/domains/shop/{schema,model,actions[,ui,runtime]}.ts` skeletons. The generator and
the classifier share the same conventions source of truth, so scaffolded files are
correctly classified by construction. Later: `aruna add action shop.buyItem` appends a
typed `defineAction` skeleton to an existing domain.

## Resulting flows

New project:

```
npm create aruna-app@latest my-game
cd my-game
aruna dev          # rojo serving, watch building — open Studio and play
```

Daily: one terminal, save a file → codegen + Luau + Studio sync. Adding a feature is
`aruna add domain quests` + filling in schemas/actions; stubs, registry, entry wiring,
tsconfig aliases, and rojo placement are all generated. `doctor` is for real breakage,
not routine maintenance.

## Phasing

- **Phase A — wiring ownership (no new commands).** Pillar 1 defaults + Pillar 2
  tsconfig fragment/rojo marker + doctor migration + aruna::112. Small surface,
  eliminates the entire alias-drift class (the harness desync becomes structurally
  impossible).
- **Phase B — generated entries.** Pillar 3: generated mains, hook discovery, `client/`
  partition, `entries` config switch.
- **Phase C — dev loop.** Pillar 5 process orchestration on top of the existing watch.
- **Phase D — scaffolding.** Pillar 4 `create-aruna-app` + Pillar 6 generators. Cheap by
  now: after A–C the scaffold is little more than package.json + one example domain.

Dependency note: D intentionally last — every earlier phase shrinks what create-app
must generate, which is the same reason create-app-plan.md gated implementation on the
starter contract. This doc is that contract's setup/DX half.

## Immediate evidence / cleanup

`apps/rbxts-harness/tsconfig.json` is desynced today (flat aliases vs split-tree
files) and the build passes anyway — realign it via `doctor --fix --emit-runtime` and
investigate why rbxtsc doesn't fail on dangling aliases (suspected node_modules
fallback to the Node runtime package). Tracked as a separate task.
