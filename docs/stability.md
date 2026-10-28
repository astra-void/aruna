# Stability policy

Aruna is a framework people build games on. A game outlives the release it was started
on, so what a release may change, and how a project gets across a change, is written down
here rather than left to each CHANGELOG entry.

## Before the first public release (now)

The [Versioning](#versioning) and [Deprecation](#deprecation) rules below take effect at
the **first public release**.

> **TODO:** the first public release is not defined yet (which version, and what makes a
> release "public"). Define it here before it ships.

Until then Aruna has no users to keep working, so compatibility has no value:

- **Any breaking change is allowed**, with no deprecation period, warning release, shim,
  alias, or migration notes. The CHANGELOG records each change briefly.
- **The API report is a review aid, not a gate on breaking changes.** CI still fails when
  `api/` is stale, so every change to the public surface shows up as a diff in review, but
  a diff that removes or changes a name is not a reason to block the change.
- **Diagnostic codes are still never reused** ([below](#diagnostic-codes-are-never-reused)).
  Keeping a retired code out of circulation costs nothing and keeps old references from
  pointing at the wrong condition.

## What is public API

Everything below is public. A change to any of it is a user-visible change: it gets a
CHANGELOG entry, and a breaking one follows the rules in [Versioning](#versioning) and
[Deprecation](#deprecation).

| Surface | Where it is defined | How changes are caught |
| --- | --- | --- |
| **Subpath exports**: `aruna` (config and compiler), `aruna/server`, `aruna/client`, `aruna/roblox`, `aruna/schema`, `aruna/testing` — every exported name, its type, and its runtime behavior | `packages/aruna/src/index.ts`, `packages/aruna/roblox/*.ts` | the API report (`api/`, below) |
| **Config schema**: every key `defineConfig` accepts, its type, default, and meaning | `@arunajs/core` (`Config`), `packages/compiler/src/config.ts` | the API report (`api/aruna.d.ts`) |
| **CLI**: command names, flags, their defaults, exit codes, and `--json` output shapes | `packages/aruna/src/cli/cli.ts` | the compiler output guard (`--json` outputs), CLI tests |
| **Diagnostic codes and names**: `aruna::NNN`, the kebab-case name, the default severity, and what a config `diagnostics.ignore` entry matches | `crates/aruna_compiler/src/diagnostics.rs` | the output guard, `diagnostics.rs` tests |
| **Manifest format** (`manifest.json`, `version: 1`) | `crates/aruna_compiler/src/manifest.rs` and the record types in `primitives/` | the output guard |
| **Contract snapshot format** (`aruna.contract.json`, `version: 1`) and `contract diff` severities | `packages/aruna/src/cli/action-contracts.ts`, `contract-diff.ts` | the output guard, `contract-diff` tests |
| **Generated file locations**: `<generatedDir>/server/actions.server.generated.ts`, `<generatedDir>/shared/actions.client.generated.ts`, `shared/signals.generated.ts`, `shared/runtime/`, the generated entries, the virtual modules `$aruna/actions/client`, `$aruna/actions/server`, `$aruna/signals`, and the tsconfig aliases `aruna doctor --fix` writes | `crates/aruna_compiler/src/resolver.rs`, `packages/aruna/src/cli/tsconfig-paths.ts` | the output guard (build outputs), `verify:package-consumption` |
| **Wire format**: the action and signal RemoteEvent envelopes, the binary codec layout and schema fingerprint, store envelopes in a DataStore | `packages/aruna/roblox/` | Lune specs (`apps/roblox-runtime-test`), golden frames in `conformance/` |

Not public: anything under `aruna/internal/*`-style paths a spec reaches into, the
`@arunajs/compiler` and `@arunajs/core` packages' own exports beyond what `aruna` re-exports,
human-readable (non-`--json`) CLI output, diagnostic message wording, the native napi
surface, and the Rust crates. They may change in any release.

The wire and store formats deserve a note: a game running two releases at once — servers
mid-rollout, or a DataStore record written by last week's build — sees both sides. A
change that makes a new build unable to read what an old one wrote is breaking even
when no TypeScript signature changes; `contract diff` and the store compatibility gate
(`aruna::578`) exist to catch it in the project, and the same rule binds Aruna itself.

## Versioning

Aruna follows [Semantic Versioning](https://semver.org/).

From the first public release.

**Before 1.0**: a **minor** release (`0.x.0`) may contain breaking changes, each
marked **Breaking** in the CHANGELOG with migration notes, and a codemod when the
migration is mechanical. A **patch** release (`0.x.y`) contains no breaking changes. A
project that wants no surprises pins the minor (`~0.7.0`).

**From 1.0**: breaking changes only in a **major** release, after the deprecation period
below. Minors add; patches fix. A bug fix that changes behavior someone could depend on
— a diagnostic that starts firing, an error that becomes stricter — ships in a minor
with a CHANGELOG entry, never in a patch.

**Canary releases** (`x.y.(z+1)-canary.<sha7>.<run>`, npm tag `canary`) are published
from manual runs of the publish workflow (`workflow_dispatch`, channel `canary`), with no
guarantees beyond "built from the commit it was run on". They exist to try a change before it is released —
`npm install @arunajs/aruna@canary` — never to depend on from a project you ship.

## Deprecation

From the first public release. Before a public API is removed or changed incompatibly:

1. **Warn first.** It keeps working for **at least one minor release** in which using it
   produces a warning: a compiler diagnostic for something the compiler can see (a config
   key, a callee), a runtime warning in Studio otherwise. The warning names the
   replacement and the release that removes it.
2. **Document it** in the CHANGELOG's `Deprecated` section of the release that starts
   warning, and again under `Removed` (or `Changed`) in the release that ends it.
3. **Automate the migration when it is mechanical** — a rename, a moved import, a changed
   literal — with an `aruna migrate` codemod shipped in the release that starts warning
   (see [codemods.md](codemods.md)). The CHANGELOG entry names it. A migration that needs
   judgment (a changed semantic, a removed feature) gets written steps instead.

Before 1.0 the warning release may be the same minor as the removal when keeping the old
form would cost more than it saves (security fixes, wire-format corrections), but the
CHANGELOG entry and the codemod still apply.

## Diagnostic codes are never reused

A diagnostic code (`aruna::NNN`) and its name identify one condition forever. Projects
reference them in `diagnostics.ignore`, CI scripts grep for them, and documentation links
to them.

- A code that is retired stays reserved: it is never assigned to a different condition,
  even if the old one is gone. `diagnostics.rs` keeps retired codes in a comment list so
  the next allocation skips them.
- A code's name never changes; a condition that changes meaning gets a new code.
- Changing a code's **default severity** is a user-visible change (a warning becoming an
  error breaks a build) and follows the deprecation rules.
- Codes are allocated from the ranges in `docs/init-spec.md` §12; ranges marked reserved
  there are not used for anything else.

## How changes are caught in review

- **The API report** (`pnpm api:report`, committed under `api/`): one rolled-up `.d.ts` per
  public entry point, regenerated from the shipped declarations. CI fails when it is out
  of date, so every change to an exported name or type shows up in the pull request as a
  diff of `api/*.d.ts`.
- **The compiler output guard** (`packages/aruna/test/compiler-output-guard.test.ts`): every
  fixture's `--json` CLI outputs, generated files, and diagnostics, byte for byte.
- **The runtime specs** (`apps/roblox-runtime-test`): behavior and wire format, executed
  under Lune.

A change that moves any of these without a matching CHANGELOG entry is a review finding.
